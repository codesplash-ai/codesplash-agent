/** Durable local session metadata and coalesced event history. */
import { createHash } from "node:crypto"
import { constants, existsSync } from "node:fs"
import { mkdir, open, readdir, truncate } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ApprovalPolicy, SandboxMode } from "./config.ts"
import { dataDirectory } from "./config.ts"
import type { AgentEvent, EngineId, SessionStatus } from "./events.ts"
import { invalidateSession } from "./session/changes.ts"
import { logBytes, materialize } from "./session/compression.ts"
import { control, type SessionStateAccess, updateControl } from "./session/control.ts"
import { atomic, canonicalRoot, component, digest, hostPath, json, lease } from "./session/files.ts"

export type SessionMeta = {
  schemaVersion: 1 | 2
  engine: EngineId
  localSessionId: string
  nativeSessionId?: string
  projectPath: string
  projectId: string
  archived?: boolean
  section?: string
  organization?: string
  position?: number
  title?: string
  createdAt: string
  updatedAt: string
  lastStatus: SessionStatus
  lastSequence: number
  /** Codex-only; Claude launches own their permission model inside the official CLI. */
  sandbox?: SandboxMode
  approvalPolicy?: ApprovalPolicy
  /** Codesplash-only first-party permission mode; loosely validated like sandbox. */
  permissionMode?: string
}

export type SessionEventsRead = {
  events: AgentEvent[]
  /** Byte length of the file up to and including the last intact line. */
  validByteLength: number
  truncatedLineRecovered: boolean
  skippedLineCount: number
}

export function sessionsRootDirectory(dataDir = dataDirectory()): string {
  return join(dataDir, "sessions")
}

/** Stable per-project identity derived from the canonical (realpath) working directory. */
export function projectIdFor(canonicalPath: string): string {
  return createHash("sha256").update(canonicalPath).digest("hex").slice(0, 16)
}

export function sessionDirectory(root: string, projectId: string, localSessionId: string): string {
  return join(root, component(projectId), component(localSessionId))
}

/**
 * Where an engine-owned native transcript lives for a session: `transcript.jsonl` next to the
 * session's events.jsonl. The session store never reads it; engines own its format.
 */
export function transcriptPathFor(handle: Pick<SessionHandle, "directory">): string {
  return join(handle.directory, "transcript.jsonl")
}

/**
 * Where a project's remembered permission grants live: `<dataDir>/permissions/<projectId>.toml`.
 * The engine owns the file's format and creates it (and the directory) on first grant; nothing
 * is created here.
 */
export function permissionGrantsPathFor(dataDir: string, projectId: string): string {
  return join(dataDir, "permissions", `${projectId}.toml`)
}

export async function listProjectSessions(
  projectId: string,
  root = sessionsRootDirectory(),
  includeArchived = false,
): Promise<SessionMeta[]> {
  const projectDirectory = join(root, component(projectId))
  let entries: string[]
  try {
    entries = await readdir(projectDirectory)
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return []
    throw error
  }

  const metas: SessionMeta[] = []
  for (const entry of entries) {
    const meta = await readSessionMeta(join(projectDirectory, entry))
    if (meta && meta.projectId === projectId && (includeArchived || !meta.archived)) metas.push(meta)
  }
  return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function readSessionMeta(
  directory: string,
  recoverPrepared = false,
): Promise<SessionMeta | undefined> {
  return readSessionMetaSync(directory, recoverPrepared)
}

function readSessionMetaSync(directory: string, recoverPrepared = false): SessionMeta | undefined {
  directory = hostPath(directory)
  const root = dirname(dirname(directory)),
    key = digest(`${directory.split("/").at(-2)}/${directory.split("/").at(-1)}`)
  if (existsSync(join(root, "tombstones", `${key}.json`))) return undefined
  let parsed: unknown
  try {
    parsed = json<unknown>(join(directory, "meta.json"))
  } catch {
    return undefined
  }
  if (!isSessionMeta(parsed)) return undefined
  let resolved = parsed
  const state = control(directory).state
  if (state.migrated && parsed.schemaVersion !== 2) {
    const prepared = state.values.migrationMeta
    if (
      !recoverPrepared ||
      !isSessionMeta(prepared) ||
      prepared.schemaVersion !== 2 ||
      prepared.localSessionId !== parsed.localSessionId ||
      prepared.projectId !== parsed.projectId ||
      state.values.migrationSourceHash !== digest(JSON.stringify(parsed))
    )
      throw new Error(
        "Legacy session writer changed migrated metadata or migration was interrupted; inspect and recover before resuming",
      )
    resolved = prepared
  }
  const selectedThread = (state.values.branches as { activeThreadId?: unknown } | undefined)?.activeThreadId
  if (
    selectedThread !== undefined &&
    (typeof selectedThread !== "string" || !selectedThread || selectedThread.length > 256)
  )
    throw new Error("Invalid selected provider thread")
  return {
    ...resolved,
    ...(resolved.engine === "codex" && typeof selectedThread === "string"
      ? { nativeSessionId: selectedThread }
      : {}),
    ...(state.title === undefined ? {} : { title: state.title }),
    ...(state.archived === undefined ? {} : { archived: state.archived }),
    ...(state.section === undefined ? {} : { section: state.section }),
    ...(state.organization === undefined ? {} : { organization: state.organization }),
    ...(state.position === undefined ? {} : { position: state.position }),
  }
}

export async function writeSessionMeta(directory: string, meta: SessionMeta): Promise<void> {
  invalidateSession(directory)
  atomic(join(directory, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`)
}

/**
 * Reads the append-only event log, dropping a torn final line (crash mid-append) and
 * skipping isolated corrupt lines without discarding intact history after them.
 */
export async function readSessionEvents(directory: string): Promise<SessionEventsRead> {
  return readSessionEventsSync(directory)
}

function readSessionEventsSync(directory: string): SessionEventsRead {
  const source = logBytes(join(directory, "events.jsonl"))

  const events: AgentEvent[] = []
  let validByteLength = 0
  let truncatedLineRecovered = false
  let skippedLineCount = 0
  let offset = 0

  while (offset < source.length) {
    const newlineIndex = source.indexOf(0x0a, offset)
    const lineEnd = newlineIndex === -1 ? source.length : newlineIndex + 1
    const line = source.subarray(offset, newlineIndex === -1 ? source.length : newlineIndex).toString("utf8")
    const complete = newlineIndex !== -1

    if (line.trim().length > 0) {
      const event = parseEventLine(line)
      if (event) {
        events.push(event)
        validByteLength = lineEnd
      } else if (complete) {
        skippedLineCount += 1
      } else {
        truncatedLineRecovered = true
      }
    } else if (complete) {
      validByteLength = lineEnd
    }

    offset = lineEnd
  }

  return { events, validByteLength, truncatedLineRecovered, skippedLineCount }
}

export class SessionStore {
  readonly root: string
  constructor(root = sessionsRootDirectory()) {
    this.root = canonicalRoot(root)
  }

  async create(meta: SessionMeta): Promise<SessionHandle> {
    const directory = sessionDirectory(this.root, meta.projectId, meta.localSessionId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const release = lease(directory)
    try {
      if (existsSync(join(directory, "meta.json"))) throw new Error("Session already exists")
      if (
        existsSync(
          join(this.root, "tombstones", `${digest(`${meta.projectId}/${meta.localSessionId}`)}.json`),
        )
      )
        throw new Error("Deleted session identities cannot be reused")
      await writeSessionMeta(directory, meta)
    } finally {
      release()
    }
    return new SessionHandle(directory, meta, 0)
  }

  async open(projectId: string, localSessionId: string): Promise<SessionHandle> {
    const directory = sessionDirectory(this.root, projectId, localSessionId)
    const meta = await readSessionMeta(directory)
    if (!meta) throw new Error(`No session metadata at ${directory}`)
    const read = await readSessionEvents(directory)
    return new SessionHandle(directory, meta, read.validByteLength)
  }

  list(projectId: string): Promise<SessionMeta[]> {
    return listProjectSessions(projectId, this.root)
  }
}

/** One session's on-disk files; append truncates torn trailing bytes before writing. */
export class SessionHandle {
  #meta: SessionMeta
  #validByteLength: number
  #healed = false
  #release: (() => void) | undefined
  #writes: Promise<void> = Promise.resolve()
  readonly state: SessionStateAccess = {
    durable: true,
    assertOwned: () => {
      if (!this.#release) throw new Error("Session recovery assets require the writer lease")
    },
    read: () => control(this.directory),
    update: (expected, operation, change) => {
      if (!this.#release) throw new Error("Session state requires its writer lease")
      return updateControl(this.directory, expected, operation, change)
    },
  }
  acquire(): void {
    if (this.#release) return
    this.#release = lease(this.directory)
    try {
      invalidateSession(this.directory)
      const meta = readSessionMetaSync(this.directory)
      if (!meta) throw new Error("Session no longer exists")
      this.#meta = meta
      this.#validByteLength = readSessionEventsSync(this.directory).validByteLength
      this.#healed = false
      materialize(this.eventsPath)
      materialize(join(this.directory, "transcript.jsonl"))
    } catch (error) {
      this.release()
      throw error
    }
  }
  release(): void {
    this.#release?.()
    this.#release = undefined
  }

  constructor(
    readonly directory: string,
    meta: SessionMeta,
    validByteLength: number,
  ) {
    this.#meta = meta
    this.#validByteLength = validByteLength
    Object.defineProperty(this.state, "directory", { value: directory, enumerable: true })
  }

  get meta(): SessionMeta {
    return this.#meta
  }

  get eventsPath(): string {
    return join(this.directory, "events.jsonl")
  }

  async updateMeta(
    patch: Partial<Omit<SessionMeta, "schemaVersion" | "localSessionId" | "projectId">>,
  ): Promise<void> {
    await this.#write(async () => {
      const next = { ...this.#meta, ...patch, updatedAt: new Date().toISOString() }
      await writeSessionMeta(this.directory, next)
      this.#meta = next
    })
  }

  async appendEventLines(lines: string[]): Promise<void> {
    if (lines.length === 0) return
    await this.#write(async () => {
      materialize(this.eventsPath)
      await this.#healTrailingBytes()
      const handle = await open(
        this.eventsPath,
        constants.O_RDWR |
          constants.O_APPEND |
          constants.O_CREAT |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      )
      let serialized = lines.map((line) => `${line}\n`).join("")
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.nlink !== 1) throw new Error("Unsafe session event file")
        if (info.size) {
          const last = Buffer.alloc(1)
          await handle.read(last, 0, 1, info.size - 1)
          if (last[0] !== 10) serialized = `\n${serialized}`
        }
        await handle.writeFile(serialized)
        await handle.sync()
      } finally {
        await handle.close()
      }
      this.#validByteLength += Buffer.byteLength(serialized)
    })
  }

  #write(operation: () => Promise<void>): Promise<void> {
    const result = this.#writes.then(async () => {
      const temporary = !this.#release
      if (temporary) this.acquire()
      try {
        await operation()
      } finally {
        if (temporary) this.release()
      }
    })
    this.#writes = result.catch(() => {})
    return result
  }

  async #healTrailingBytes(): Promise<void> {
    if (this.#healed) return
    this.#healed = true
    try {
      const size = Bun.file(this.eventsPath).size
      if (size > this.#validByteLength) await truncate(this.eventsPath, this.#validByteLength)
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error
    }
  }
}

function parseEventLine(line: string): AgentEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    return isAgentEventShape(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isAgentEventShape(value: unknown): value is AgentEvent {
  if (!isRecord(value)) return false
  return (
    value.schemaVersion === 1 &&
    typeof value.sequence === "number" &&
    typeof value.timestamp === "string" &&
    typeof value.engine === "string" &&
    typeof value.localSessionId === "string" &&
    typeof value.kind === "string" &&
    isRecord(value.payload)
  )
}

function isSessionMeta(value: unknown): value is SessionMeta {
  if (!isRecord(value)) return false
  return (
    (value.schemaVersion === 1 || value.schemaVersion === 2) &&
    (value.engine === "codex" || value.engine === "claude" || value.engine === "codesplash") &&
    typeof value.localSessionId === "string" &&
    typeof value.projectPath === "string" &&
    typeof value.projectId === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.lastStatus === "string" &&
    typeof value.lastSequence === "number" &&
    (value.sandbox === undefined || typeof value.sandbox === "string") &&
    (value.approvalPolicy === undefined || typeof value.approvalPolicy === "string") &&
    (value.permissionMode === undefined || typeof value.permissionMode === "string")
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value
}
