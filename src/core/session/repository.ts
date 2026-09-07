import { Database } from "bun:sqlite"
import { chmodSync, existsSync, lstatSync, readdirSync, rmSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { setImmediate as yieldToHost } from "node:timers/promises"
import { dataDirectory } from "../config.ts"
import { redactSensitiveText } from "../redaction.ts"
import {
  readSessionEvents,
  readSessionMeta,
  type SessionMeta,
  sessionDirectory,
  sessionsRootDirectory,
  writeSessionMeta,
} from "../sessions.ts"
import { invalidateSession, sessionChanges } from "./changes.ts"
import { compressLogs } from "./compression.ts"
import { type ControlState, control, updateControl } from "./control.ts"
import {
  atomic,
  canonicalRoot,
  component,
  digest,
  directory,
  hostId,
  json,
  lease,
  localFilesystem,
  owner,
} from "./files.ts"

export type SessionQuery = {
  query?: string
  project?: string
  engine?: string
  archived?: boolean
  limit?: number
  offset?: number
  section?: string
  organization?: string
}
export type SessionPage = { sessions: SessionMeta[]; total: number; next?: number; warnings: string[] }
type Projection = { id: string; fingerprint: string; content: string; truncated: number }
const MAX_SESSIONS = 10_000
const CONTENT_LIMIT = 1024 * 1024
export const safeSessionMeta = (meta: SessionMeta): SessionMeta => ({
  ...meta,
  ...Object.fromEntries(
    ["title", "projectPath", "organization", "section"].flatMap((key) => {
      const value = meta[key as keyof SessionMeta]
      return typeof value === "string" ? [[key, safeSessionText(value)]] : []
    }),
  ),
})
export const safeSessionText = (text: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal control characters
  redactSensitiveText(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")

/** Canonical files own state. The disposable SQLite index only accelerates text searches. */
export class SessionRepository {
  readonly root: string
  readonly indexRoot: string
  constructor(root = sessionsRootDirectory(), indexRoot?: string) {
    this.root = canonicalRoot(root)
    this.indexRoot = canonicalRoot(
      indexRoot ??
        (localFilesystem(this.root)
          ? join(this.root, ".index")
          : join(dataDirectory(), "session-index", hostId(), digest(this.root))),
    )
  }
  path(meta: Pick<SessionMeta, "projectId" | "localSessionId">): string {
    return sessionDirectory(this.root, meta.projectId, meta.localSessionId)
  }
  async all(recoverPrepared = false): Promise<SessionMeta[]> {
    if (!existsSync(this.root)) return []
    directory(this.root)
    const result: SessionMeta[] = []
    for (const project of readdirSync(this.root, { withFileTypes: true })) {
      if (!project.isDirectory() || project.name.startsWith(".") || project.name === "tombstones") continue
      component(project.name)
      for (const entry of readdirSync(join(this.root, project.name), { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue
        const path = sessionDirectory(this.root, project.name, entry.name)
        const meta = await readSessionMeta(path, recoverPrepared)
        if (!meta) continue
        if (meta.projectId !== project.name || meta.localSessionId !== entry.name)
          throw new Error("Session identity does not match its directory")
        result.push(meta)
        if (result.length > MAX_SESSIONS)
          throw new Error("Session scan exceeds 10,000 sessions; select a smaller local store")
      }
    }
    return result.sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.localSessionId.localeCompare(b.localSessionId),
    )
  }
  async resolve(id: string, project?: string, recoverPrepared = false): Promise<SessionMeta> {
    const matches = (await this.all(recoverPrepared)).filter(
      (m) => (!project || m.projectId === project) && (m.localSessionId === id || m.title === id),
    )
    if (matches.length !== 1)
      throw new Error(
        matches.length ? "Ambiguous session; select a project and exact id" : "Session not found",
      )
    return matches[0] as SessionMeta
  }
  async list(options: SessionQuery = {}): Promise<SessionPage> {
    const limit = options.limit ?? 30,
      offset = options.offset ?? 0,
      query = options.query?.trim() ?? ""
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      query.length > 1000
    )
      throw new Error("Session query requires limit 1–100, nonnegative offset and query <=1,000 characters")
    const warnings: string[] = [],
      rows: SessionMeta[] = []
    let db: Database | undefined
    try {
      db = this.openIndex()
    } catch {
      if (query)
        warnings.push(
          "Index unavailable; searching canonical history. Run session reindex --apply to repair.",
        )
    }
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
    let candidates: Set<string> | undefined
    if (db && terms.some((term) => Array.from(term).length >= 3)) {
      try {
        const expression = terms
          .filter((term) => Array.from(term).length >= 3)
          .map((term) => `"${term.replaceAll('"', '""')}"`)
          .join(" AND ")
        candidates = new Set(
          db
            .query<{ id: string }, string>("SELECT id FROM search WHERE search MATCH ?")
            .all(expression)
            .map((row) => row.id),
        )
      } catch {
        db.close()
        db = undefined
        warnings.push("Search index needs rebuilding; searching canonical history")
      }
    }
    let view: SessionMeta[] | undefined
    const limited = new Set<string>()
    let dirty = new Set<string>()
    if (db) {
      try {
        const indexed = db
          .query<{ id: string; metadata: string; truncated: number }, []>(
            "SELECT id,metadata,truncated FROM sessions",
          )
          .all()
        for (const row of indexed) if (row.truncated) limited.add(row.id)
        const byId = new Map(indexed.map((row) => [row.id, JSON.parse(row.metadata) as SessionMeta]))
        if ([...byId.values()].some((meta) => meta.schemaVersion === 1))
          throw new Error("Legacy sessions require a canonical scan")
        for (const change of sessionChanges(this.root)) {
          const key = `${change.project}/${change.session}`
          dirty.add(key)
          const meta = await readSessionMeta(sessionDirectory(this.root, change.project, change.session))
          if (meta) byId.set(key, meta)
          else byId.delete(key)
        }
        view = [...byId.values()].sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) || a.localSessionId.localeCompare(b.localSessionId),
        )
      } catch {
        db.close()
        db = undefined
        candidates = undefined
        dirty = new Set()
      }
    }
    try {
      for (const meta of view ?? (await this.all())) {
        if (
          (options.project && meta.projectId !== options.project) ||
          (options.engine && meta.engine !== options.engine) ||
          (options.archived !== undefined && Boolean(meta.archived) !== options.archived) ||
          (options.section !== undefined && meta.section !== options.section) ||
          (options.organization !== undefined && meta.organization !== options.organization)
        )
          continue
        if (terms.length) {
          if (view && candidates && !dirty.has(this.key(meta)) && !candidates.has(this.key(meta))) continue
          if (
            view &&
            candidates &&
            !dirty.has(this.key(meta)) &&
            terms.every((term) => Array.from(term).length >= 3)
          ) {
            if (limited.has(this.key(meta))) warnings.push(`Search excerpt truncated: ${meta.localSessionId}`)
            rows.push(meta)
            continue
          }
          let projection: Projection | undefined
          if (db && (!view || !dirty.has(this.key(meta)))) {
            try {
              const status = db
                .query<{ fingerprint: string; truncated: number }, string>(
                  "SELECT fingerprint,truncated FROM sessions WHERE id=?",
                )
                .get(this.key(meta))
              if (
                candidates &&
                !candidates.has(this.key(meta)) &&
                status?.fingerprint === this.fingerprint(meta)
              ) {
                if (status.truncated) warnings.push(`Search excerpt truncated: ${meta.localSessionId}`)
                continue
              }
              projection =
                db.query<Projection, string>("SELECT * FROM sessions WHERE id=?").get(this.key(meta)) ??
                undefined
            } catch {
              db.close()
              db = undefined
              warnings.push("Corrupt index; searching canonical history")
            }
          }
          if (!projection || (!view && projection.fingerprint !== this.fingerprint(meta)))
            projection = await this.project(meta)
          if (projection.truncated) warnings.push(`Search excerpt truncated: ${meta.localSessionId}`)
          // Literal substring semantics are the same with and without an index; SQL never sees raw FTS syntax.
          if (!terms.every((term) => projection.content.toLocaleLowerCase().includes(term))) continue
        }
        rows.push(meta)
      }
    } finally {
      db?.close()
    }
    if (options.section !== undefined || options.organization !== undefined)
      rows.sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || b.updatedAt.localeCompare(a.updatedAt))
    return {
      sessions: rows.slice(offset, offset + limit).map(safeSessionMeta),
      total: rows.length,
      ...(offset + limit < rows.length ? { next: offset + limit } : {}),
      warnings: [...new Set(warnings)],
    }
  }
  async change(
    meta: SessionMeta,
    expected: string,
    operation: string,
    change: (state: ControlState) => void,
  ): Promise<SessionMeta> {
    const release = lease(this.path(meta))
    try {
      const current = await readSessionMeta(this.path(meta))
      if (!current) throw new Error("Session no longer exists")
      this.inactive(current)
      invalidateSession(this.path(meta))
      updateControl(this.path(meta), expected, operation, change)
      return (await readSessionMeta(this.path(meta))) as SessionMeta
    } finally {
      release()
    }
  }
  async rename(
    meta: SessionMeta,
    title: string,
    expected = control(this.path(meta)).revision,
  ): Promise<SessionMeta> {
    if (!title.trim() || title.length > 200) throw new Error("Title requires 1–200 characters")
    return this.change(meta, expected, "rename", (state) => {
      state.title = safeSessionText(title.trim())
      state.manualTitle = true
    })
  }
  async archive(
    meta: SessionMeta,
    archived: boolean,
    expected = control(this.path(meta)).revision,
  ): Promise<SessionMeta> {
    return this.change(meta, expected, "archive", (state) => {
      state.archived = archived
    })
  }
  async move(
    meta: SessionMeta,
    organization: string,
    section: string,
    position: number,
  ): Promise<SessionMeta> {
    if (organization.length > 200 || section.length > 200 || !Number.isFinite(position))
      throw new Error("Invalid organization, section or position")
    return this.change(meta, control(this.path(meta)).revision, "move", (state) => {
      state.organization = safeSessionText(organization)
      state.section = safeSessionText(section)
      state.position = position
    })
  }
  preview(meta: SessionMeta, action: string) {
    return {
      action,
      id: meta.localSessionId,
      project: meta.projectId,
      revision: control(this.path(meta)).revision,
      owner: owner(join(this.path(meta), "writer.lease")),
      legacyRecoveryRequired: meta.schemaVersion === 1 && !["closed", "failed"].includes(meta.lastStatus),
      localStorage: localFilesystem(this.root),
      note:
        action === "delete"
          ? "Deletes local history only. Repository memories and provider threads remain independent."
          : "No provider or tool operations will be replayed.",
    }
  }
  async maintenance(
    meta: SessionMeta,
    action: "migrate" | "compress" | "recover" | "delete",
    expected: string,
  ) {
    const path = this.path(meta),
      release = lease(path)
    try {
      if (control(path).revision !== expected) throw new Error("Session changed; preview again")
      let current = await readSessionMeta(path, action === "recover")
      if (!current) throw new Error("Session no longer exists")
      if (action !== "recover") this.inactive(current)
      invalidateSession(path)
      if (action === "recover") {
        current = { ...current, lastStatus: "failed" }
        await writeSessionMeta(path, current)
        updateControl(path, expected, "recover", (state) => {
          state.values.recovery = { at: new Date().toISOString(), requiresReview: true }
        })
        return {
          recovered: true,
          warning: "Interrupted work and unresolved approvals require review; nothing was replayed.",
        }
      }
      if (action === "migrate") {
        if (current.schemaVersion === 2) return { migrated: false, reason: "Already version 2" }
        atomic(join(path, "meta.v1.backup.json"), JSON.stringify(current))
        const next: SessionMeta = { ...current, schemaVersion: 2 }
        updateControl(path, expected, "migrate", (state) => {
          state.migrated = true
          state.values.migrationMeta = next
          state.values.migrationSourceHash = digest(JSON.stringify(json(join(path, "meta.json"))))
        })
        await writeSessionMeta(path, next)
        return { migrated: true }
      }
      if (action === "compress") return { files: compressLogs(path) }
      const releaseIndex = lease(this.root, "index.lease")
      try {
        // Commit non-resurrection before cleanup, including before deleting the lease itself.
        atomic(
          join(this.root, "tombstones", `${digest(this.key(meta))}.json`),
          JSON.stringify({ version: 1, deletedAt: new Date().toISOString() }),
        )
        directory(path)
        rmSync(path, { recursive: true })
        // All generations are disposable and may retain excerpts of deleted content.
        const indexRoot = this.indexRoot
        if (existsSync(indexRoot)) {
          directory(indexRoot)
          rmSync(indexRoot, { recursive: true })
        }
        return { deleted: true, note: "Repository memories and provider threads were not deleted." }
      } finally {
        releaseIndex()
      }
    } finally {
      release()
    }
  }
  async reindex(
    options: {
      signal?: AbortSignal
      onProgress?: (progress: { completed: number; cursor: string }) => void
    } = {},
  ): Promise<{ sessions: number; truncated: number; journal: string }> {
    options.signal?.throwIfAborted()
    const release = lease(localFilesystem(this.root) ? this.root : this.indexRoot, "index.lease")
    let db: Database | undefined
    try {
      const generation = crypto.randomUUID(),
        root = this.indexRoot,
        path = join(root, `${generation}.sqlite`)
      directory(root, true)
      atomic(path, new Uint8Array())
      db = new Database(path)
      const journal = localFilesystem(this.root) ? "WAL" : "TRUNCATE"
      db.exec(
        `PRAGMA busy_timeout=2000; PRAGMA journal_mode=${journal}; CREATE TABLE sessions(id TEXT PRIMARY KEY, fingerprint TEXT, content TEXT, truncated INTEGER, metadata TEXT); CREATE VIRTUAL TABLE search USING fts5(id UNINDEXED,content,tokenize=trigram); CREATE TABLE control(id TEXT PRIMARY KEY, revision TEXT, state TEXT); CREATE TABLE maintenance(cursor TEXT, completed INTEGER);`,
      )
      const capturedChanges = sessionChanges(this.root)
      let count = 0,
        truncated = 0
      for (const meta of await this.all()) {
        const row = await this.project(meta),
          record = control(this.path(meta)),
          database = db
        database.transaction(() => {
          database
            .query("INSERT INTO sessions VALUES (?,?,?,?,?)")
            .run(row.id, row.fingerprint, row.content, row.truncated, JSON.stringify(safeSessionMeta(meta)))
          database.query("INSERT INTO search VALUES (?,?)").run(row.id, row.content)
          database.query("INSERT INTO control VALUES (?,?,?)").run(
            row.id,
            record.revision,
            JSON.stringify({
              title: record.state.title === undefined ? undefined : safeSessionText(record.state.title),
              archived: record.state.archived,
              organization:
                record.state.organization === undefined
                  ? undefined
                  : safeSessionText(record.state.organization),
              section: record.state.section === undefined ? undefined : safeSessionText(record.state.section),
              position: record.state.position,
            }),
          )
          database.exec("DELETE FROM maintenance")
          database.query("INSERT INTO maintenance VALUES (?,?)").run(row.id, ++count)
        })()
        truncated += row.truncated
        options.onProgress?.({ completed: count, cursor: row.id })
        if (count % 100 === 0) await yieldToHost()
        options.signal?.throwIfAborted()
      }
      // Never consume an intent belonging to a writer still running or to a changed source.
      const cleanup: string[] = []
      for (const change of capturedChanges) {
        const path = sessionDirectory(this.root, change.project, change.session)
        if (owner(join(path, "writer.lease"))) continue
        const meta = await readSessionMeta(path)
        const row = db
          .query<{ fingerprint: string }, string>("SELECT fingerprint FROM sessions WHERE id=?")
          .get(`${change.project}/${change.session}`)
        if (meta && row?.fingerprint !== this.fingerprint(meta)) continue
        cleanup.push(change.file)
      }
      db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=TRUNCATE")
      db.close()
      db = undefined
      chmodSync(path, 0o600)
      atomic(join(root, `${hostId()}.json`), JSON.stringify({ version: 1, generation }))
      for (const file of cleanup) {
        if (existsSync(file)) unlinkSync(file)
      }
      return { sessions: count, truncated, journal }
    } finally {
      db?.close()
      release()
    }
  }
  private inactive(meta: SessionMeta) {
    if (meta.schemaVersion === 1 && !["closed", "failed"].includes(meta.lastStatus))
      throw new Error(
        "Legacy session may still be active. Close the old app, then run session recover --apply before maintenance",
      )
  }
  private key(meta: SessionMeta) {
    return `${meta.projectId}/${meta.localSessionId}`
  }
  private fingerprint(meta: SessionMeta): string {
    const path = this.path(meta)
    return digest(
      JSON.stringify([
        meta,
        control(path).revision,
        ...["events.jsonl", "events.jsonl.storage.json"].map((name) => {
          const file = join(path, name)
          if (!existsSync(file)) return null
          const stat = lstatSync(file)
          return [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]
        }),
      ]),
    )
  }
  private async project(meta: SessionMeta): Promise<Projection> {
    const fingerprint = this.fingerprint(meta)
    let content = safeSessionText(meta.title ?? ""),
      truncated = 0
    for (const event of (await readSessionEvents(this.path(meta))).events) {
      if (event.kind === "user.message" || event.kind === "message.completed") {
        content += `\n${safeSessionText(event.payload.text ?? "")}`
        if (Buffer.byteLength(content) > CONTENT_LIMIT) {
          content = Buffer.from(content).subarray(0, CONTENT_LIMIT).toString("utf8")
          truncated = 1
          break
        }
      }
    }
    return { id: this.key(meta), fingerprint, content, truncated }
  }
  private openIndex(): Database {
    const root = this.indexRoot,
      pointer = json<{ version: number; generation: string }>(join(root, `${hostId()}.json`), 4096)
    if (pointer.version !== 1 || !/^[a-f0-9-]{36}$/.test(pointer.generation))
      throw new Error("Invalid index manifest")
    const path = join(root, `${pointer.generation}.sqlite`)
    directory(root)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe index file")
    const db = new Database(path, { readonly: true })
    try {
      db.exec("PRAGMA busy_timeout=2000; PRAGMA query_only=ON")
      return db
    } catch (error) {
      db.close()
      throw error
    }
  }
}
