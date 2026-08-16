/** Durable local session metadata and coalesced event history. */
import { createHash } from "node:crypto"
import { chmod, mkdir, open, readdir, readFile, rename, truncate } from "node:fs/promises"
import { join } from "node:path"
import type { ApprovalPolicy, SandboxMode } from "./config.ts"
import { dataDirectory } from "./config.ts"
import type { AgentEvent, EngineId, SessionStatus } from "./events.ts"

export type SessionMeta = {
  schemaVersion: 1
  engine: EngineId
  localSessionId: string
  nativeSessionId?: string
  projectPath: string
  projectId: string
  title?: string
  createdAt: string
  updatedAt: string
  lastStatus: SessionStatus
  lastSequence: number
  sandbox: SandboxMode
  approvalPolicy: ApprovalPolicy
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
  return join(root, projectId, localSessionId)
}

export async function listProjectSessions(
  projectId: string,
  root = sessionsRootDirectory(),
): Promise<SessionMeta[]> {
  const projectDirectory = join(root, projectId)
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
    if (meta && meta.projectId === projectId) metas.push(meta)
  }
  return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function readSessionMeta(directory: string): Promise<SessionMeta | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(directory, "meta.json"), "utf8"))
    return isSessionMeta(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export async function writeSessionMeta(directory: string, meta: SessionMeta): Promise<void> {
  const path = join(directory, "meta.json")
  const temporaryPath = `${path}.${process.pid}.tmp`
  await Bun.write(temporaryPath, `${JSON.stringify(meta, null, 2)}\n`)
  await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, path)
}

/**
 * Reads the append-only event log, dropping a torn final line (crash mid-append) and
 * skipping isolated corrupt lines without discarding intact history after them.
 */
export async function readSessionEvents(directory: string): Promise<SessionEventsRead> {
  const path = join(directory, "events.jsonl")
  let source: Buffer
  try {
    source = Buffer.from(await readFile(path))
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { events: [], validByteLength: 0, truncatedLineRecovered: false, skippedLineCount: 0 }
    }
    throw error
  }

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
  constructor(readonly root = sessionsRootDirectory()) {}

  async create(meta: SessionMeta): Promise<SessionHandle> {
    const directory = sessionDirectory(this.root, meta.projectId, meta.localSessionId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeSessionMeta(directory, meta)
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

  constructor(
    readonly directory: string,
    meta: SessionMeta,
    validByteLength: number,
  ) {
    this.#meta = meta
    this.#validByteLength = validByteLength
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
    this.#meta = { ...this.#meta, ...patch, updatedAt: new Date().toISOString() }
    await writeSessionMeta(this.directory, this.#meta)
  }

  async appendEventLines(lines: string[]): Promise<void> {
    if (lines.length === 0) return
    await this.#healTrailingBytes()

    const handle = await open(this.eventsPath, "a", 0o600)
    try {
      await handle.write(lines.map((line) => `${line}\n`).join(""))
    } finally {
      await handle.close()
    }
    this.#validByteLength += Buffer.byteLength(lines.map((line) => `${line}\n`).join(""))
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
    value.schemaVersion === 1 &&
    (value.engine === "codex" || value.engine === "claude") &&
    typeof value.localSessionId === "string" &&
    typeof value.projectPath === "string" &&
    typeof value.projectId === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.lastStatus === "string" &&
    typeof value.lastSequence === "number" &&
    typeof value.sandbox === "string" &&
    typeof value.approvalPolicy === "string"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value
}
