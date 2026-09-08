import { join } from "node:path"
import type { PermissionRuntime } from "../contracts.ts"
import type { ContextToolRunner } from "../inputs/contracts.ts"
import { commandArgs } from "../inputs/syntax.ts"
import {
  MEMORY_BODY_BYTES,
  MEMORY_ID,
  type MemoryConfig,
  type MemoryIdentity,
  type MemoryRecord,
  type MemorySearch,
  type MemorySnapshot,
  type MemorySource,
} from "./contracts.ts"
import { embeddingKey } from "./embedding.ts"
import { ensureIdentity, linkIdentity, memoryHash, memoryIdentity } from "./identity.ts"
import { MemoryIndex, type StoredVector, validVector, writeIndex } from "./retrieval.ts"
import { MemoryStore } from "./store.ts"
export type MemoryOptions = {
  root: string
  cwd: string
  session: string
  history: boolean
  trusted: boolean
  config?: MemoryConfig
  writable: () => boolean
  permissions: PermissionRuntime
  sanitize: (text: string) => string
}
export class MemorySession {
  #identity: MemoryIdentity | undefined
  #selected: { revision: string; mode: string; records: MemoryRecord[] } | undefined
  readonly notes = new Map<string, string>()
  #selectedBranchNotes = false
  selectBranchNotes(notes: Record<string, string>): void {
    this.#selectedBranchNotes = true
    this.notes.clear()
    for (const [id, text] of Object.entries(notes)) this.notes.set(id, text)
  }
  lastSearch: MemorySearch = { mode: "lexical", records: [] }
  constructor(readonly options: MemoryOptions) {
    const sanitize = options.sanitize
    this.options = {
      ...options,
      sanitize: (text) => {
        const key = options.config?.embedding?.keyEnvVar
        const value = key ? process.env[key] : undefined
        return sanitize(value ? text.replaceAll(value, "[REDACTED]") : text)
      },
    }
  }
  get available() {
    return this.options.history && this.options.trusted && this.options.config?.enabled !== false
  }
  invalidate() {
    this.#selected = undefined
  }
  async identity(signal: AbortSignal) {
    if (!this.available)
      throw new Error("Durable memory is unavailable in untrusted, no-history or disabled sessions")
    if (!this.#identity?.repository)
      this.#identity = await memoryIdentity(this.options.root, this.options.cwd, signal)
    return this.#identity
  }
  async store(signal: AbortSignal, create = false): Promise<MemoryStore | undefined> {
    const identity = await this.identity(signal)
    if (create) {
      this.requireWrite()
      ensureIdentity(this.options.root, identity)
    }
    return identity.repository ? new MemoryStore(join(this.options.root, identity.repository)) : undefined
  }
  #index(store: MemoryStore, snapshot: MemorySnapshot) {
    try {
      writeIndex(store.root, this.cleanSnapshot(snapshot))
    } catch (error) {
      this.lastSearch = {
        mode: "fallback",
        records: [],
        reason: `Memory saved; index needs repair: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
  cleanSnapshot(snapshot: MemorySnapshot): MemorySnapshot {
    return {
      ...snapshot,
      records: snapshot.records.map((r) => ({ ...r, text: this.options.sanitize(r.text) })),
    }
  }
  async restoreNotes(signal: AbortSignal): Promise<void> {
    if (!this.available || this.#selectedBranchNotes) return
    const snapshot = (await this.store(signal))?.snapshot()
    if (this.options.writable()) this.notes.clear()
    for (const record of snapshot?.records ?? []) {
      if (
        record.kind !== "note" ||
        record.session !== this.options.session ||
        record.sources.some((s) => s.path && this.options.permissions.isReadDenied(s.path, "read_file"))
      )
        continue
      const match = /^\[([a-z0-9][a-z0-9-]{0,63})\]\n([\s\S]*)$/.exec(record.text)
      if (match?.[1] && match[2] !== undefined && this.notes.size < 16 && !this.notes.has(match[1]))
        this.notes.set(match[1], this.options.sanitize(match[2]))
    }
  }
  requireWrite() {
    if (!this.available || !this.options.writable())
      throw new Error(
        "Memory writes require a trusted, history-enabled workspace-write session outside plan mode",
      )
  }
  eligible(record: MemoryRecord, identity: MemoryIdentity) {
    return (
      (record.scope === "repo" || record.worktree === identity.worktree) &&
      record.kind === "fact" &&
      record.sources.every(
        (source) => !source.path || !this.options.permissions.isReadDenied(source.path, "read_file"),
      )
    )
  }
  async search(query: string, signal: AbortSignal, run?: ContextToolRunner): Promise<MemorySearch> {
    const store = await this.store(signal),
      snapshot = this.cleanSnapshot(store?.snapshot() ?? { revision: "", records: [], processed: [] }),
      identity = await this.identity(signal)
    const records = snapshot.records.filter((r) => this.eligible(r, identity))
    let index = new MemoryIndex(store?.root, snapshot),
      vector: { key: string; values: number[] } | undefined,
      reason: string | undefined =
        store && index.fallback
          ? "Index missing, stale or corrupt; using an in-memory index. Run memory repair."
          : undefined
    try {
      const config = this.options.config?.embedding
      if (config && run && records.length) {
        try {
          const decision = this.options.permissions.decide("memory_write", undefined, false)
          const key = embeddingKey(config),
            cached = index.vectors(key),
            prioritized = [
              ...index.search(this.options.sanitize(query), records).records.map((r) => r.record),
              ...records,
            ],
            missing =
              this.options.writable() && decision.kind !== "deny" && decision.kind !== "ask"
                ? [...new Map(prioritized.map((r) => [r.id, r])).values()]
                    .filter((r) => !cached.some((v) => v.id === r.id && v.hash === memoryHash(r.text)))
                    .slice(0, 15)
                : []
          const result = await run("memory_embed", {
            texts: [this.options.sanitize(query), ...missing.map((r) => r.text)],
          })
          signal.throwIfAborted()
          if (result.isError) throw new Error(result.text)
          const values = (JSON.parse(result.text) as { vectors: unknown[] }).vectors
          if (
            !Array.isArray(values) ||
            values.length !== missing.length + 1 ||
            values.some((v) => !validVector(v, config.dimensions))
          )
            throw new Error("Invalid embedding result")
          vector = { key, values: values[0] as number[] }
          if (missing.length && store) {
            const vectors: StoredVector[] = [
              ...cached,
              ...missing.map((r, i) => ({
                id: r.id,
                hash: memoryHash(r.text),
                key,
                values: values[i + 1] as number[],
              })),
            ]
            writeIndex(store.root, snapshot, vectors)
            index.close()
            index = new MemoryIndex(store.root, snapshot)
            reason = undefined
          }
        } catch (error) {
          signal.throwIfAborted()
          reason = this.options.sanitize(error instanceof Error ? error.message : String(error))
        }
      }
      const result = index.search(this.options.sanitize(query), records, vector)
      if (reason) {
        result.mode = "fallback"
        result.reason = reason
      }
      this.lastSearch = result
      return result
    } finally {
      index.close()
    }
  }
  async prepare(query: string, signal: AbortSignal, run: ContextToolRunner): Promise<string> {
    if (!this.available) return ""
    const identity = await this.identity(signal),
      store = await this.store(signal),
      snapshot = store?.snapshot()
    if (!snapshot?.records.length) {
      this.invalidate()
      return ""
    }
    if (
      !this.#selected ||
      this.#selected.revision !== snapshot.revision ||
      this.#selected.mode !== this.options.permissions.mode
    ) {
      const result = await this.search(query.slice(0, 1000), signal, run)
      this.#selected = {
        revision: snapshot.revision,
        mode: this.options.permissions.mode,
        records: result.records.map((r) => r.record),
      }
    }
    const records = this.#selected.records.filter((r) => this.eligible(r, identity))
    if (!records.length) return ""
    return `Remembered reference facts (may be stale; current instructions and permissions take precedence):\n${records.map((r) => `[Memory ${r.id}, ${r.source}, updated ${r.updated}]\n${this.options.sanitize(r.text)}`).join("\n\n")}`
  }
  async remember(
    text: string,
    signal: AbortSignal,
    options: { generated?: boolean; sources?: MemorySource[]; kind?: MemoryRecord["kind"] } = {},
  ): Promise<MemoryRecord> {
    this.requireWrite()
    text = this.options.sanitize(text).trim()
    if (!text || Buffer.byteLength(text) > MEMORY_BODY_BYTES)
      throw new Error("Memory text must be 1–4096 UTF-8 bytes")
    const store = (await this.store(signal, true)) as MemoryStore,
      snapshot = store.snapshot(),
      identity = await this.identity(signal),
      now = new Date().toISOString()
    const record: MemoryRecord = {
      id: crypto.randomUUID(),
      revision: 1,
      scope: options.generated ? "worktree" : "repo",
      worktree: identity.worktree,
      kind: options.kind ?? (options.generated ? "candidate" : "fact"),
      source: options.generated ? "generated" : "user",
      session: this.options.session,
      sources: options.sources ?? [],
      created: now,
      updated: now,
      text,
    }
    signal.throwIfAborted()
    this.#index(store, store.commit(snapshot.revision, [...snapshot.records, record], snapshot.processed))
    this.invalidate()
    return record
  }
  async mutate(
    id: string,
    action: "edit" | "forget" | "accept",
    text: string | undefined,
    signal: AbortSignal,
    expected?: number,
    model = false,
  ): Promise<string> {
    this.requireWrite()
    if (!MEMORY_ID.test(id)) throw new Error("Invalid memory id")
    const store = await this.store(signal)
    if (!store) throw new Error("No memory store")
    const snapshot = store.snapshot(),
      record = snapshot.records.find((r) => r.id === id),
      identity = await this.identity(signal)
    if (!record || (record.scope === "worktree" && record.worktree !== identity.worktree))
      throw new Error("Memory not found in this scope")
    if (expected !== undefined && record.revision !== expected)
      throw new Error("Memory revision changed; reload before editing")
    if (model && (record.kind !== "candidate" || action === "accept"))
      throw new Error("Only the user can change curated facts or accept candidates")
    if (action === "edit") {
      const clean = this.options.sanitize(text ?? "").trim()
      if (!clean || Buffer.byteLength(clean) > MEMORY_BODY_BYTES)
        throw new Error("Memory text must be 1–4096 UTF-8 bytes")
      record.text = clean
      if (!model) record.source = "user"
    }
    if (action === "accept") {
      if (record.kind !== "candidate") throw new Error("Only candidates need acceptance")
      record.kind = "fact"
      record.reviewed = true
    }
    if (record.kind === "note") this.notes.clear()
    record.revision++
    record.updated = new Date().toISOString()
    signal.throwIfAborted()
    this.#index(
      store,
      store.commit(
        snapshot.revision,
        action === "forget" ? snapshot.records.filter((r) => r.id !== id) : snapshot.records,
        snapshot.processed,
      ),
    )
    this.invalidate()
    return `${action}: ${id}`
  }
  async command(source: string, signal: AbortSignal, run?: ContextToolRunner): Promise<string> {
    const [action = "list", ...args] = commandArgs(source),
      identity = await this.identity(signal)
    if (action === "remember") return `Remembered ${(await this.remember(args.join(" "), signal)).id}`
    if (action === "link") {
      if (args.length < 1 || args.length > 2 || (args[1] && args[1] !== "--apply"))
        throw new Error("Usage: memory link UUID [--apply]")
      if (args[1]) this.requireWrite()
      const result = linkIdentity(this.options.root, identity, args[0] ?? "", args[1] === "--apply")
      this.invalidate()
      return result
    }
    const store = await this.store(signal),
      snapshot = this.cleanSnapshot(store?.snapshot() ?? { revision: "", records: [], processed: [] })
    const visible = snapshot.records.filter(
      (r) =>
        (r.scope === "repo" || r.worktree === identity.worktree) &&
        (r.kind !== "note" || r.session === this.options.session) &&
        r.sources.every((s) => !s.path || !this.options.permissions.isReadDenied(s.path, "read_file")),
    )
    if (action === "status")
      return `Repository: ${identity.repository ?? "not created"}\nLocation: ${identity.location}\nWorktree: ${identity.worktree}\nRecords: ${visible.length}\nRevision: ${snapshot.revision || "none"}\nAutomatic learning: ${this.options.config?.autoLearn ? "enabled" : "off"}\nRetrieval: ${this.lastSearch.mode}${this.lastSearch.reason ? ` (${this.lastSearch.reason})` : ""}`
    if (action === "index") {
      this.requireWrite()
      const config = this.options.config?.embedding
      if (!config || !run) throw new Error("Configure memory.embedding before indexing vectors")
      if (!store) return "No memory store to index"
      const index = new MemoryIndex(store.root, snapshot)
      const key = embeddingKey(config)
      const records = visible.filter((r) => this.eligible(r, identity))
      let cached: StoredVector[]
      try {
        cached = index
          .vectors(key)
          .filter((v) => snapshot.records.some((r) => r.id === v.id && memoryHash(r.text) === v.hash))
      } finally {
        index.close()
      }
      const missing = records.filter((r) => !cached.some((v) => v.id === r.id)).slice(0, 16)
      if (!missing.length) return `Vector index complete: ${records.length} eligible facts.`
      const result = await run("memory_embed", { texts: missing.map((r) => r.text) })
      signal.throwIfAborted()
      if (result.isError) throw new Error(result.text)
      const values = (JSON.parse(result.text) as { vectors: unknown[] }).vectors
      if (
        !Array.isArray(values) ||
        values.length !== missing.length ||
        values.some((v) => !validVector(v, config.dimensions))
      )
        throw new Error("Invalid embedding result")
      writeIndex(store.root, snapshot, [
        ...cached,
        ...missing.map((r, i) => ({
          id: r.id,
          hash: memoryHash(r.text),
          key,
          values: values[i] as number[],
        })),
      ])
      this.invalidate()
      const remaining = records.filter((r) => !cached.some((v) => v.id === r.id)).length - missing.length
      return `Indexed ${missing.length} facts; ${remaining} remaining.${remaining ? " Run memory index again for the next bounded batch." : ""}`
    }
    if (action === "list")
      return (
        visible
          .map(
            (r) =>
              `${r.id} r${r.revision} [${r.kind}/${r.scope}/${r.source}] ${r.text.slice(0, 100).replaceAll("\n", " ")}`,
          )
          .join("\n") || "No memories in this scope."
      )
    if (action === "show") {
      const record = visible.find((r) => r.id === args[0])
      if (!record) throw new Error("Memory not found")
      return `[${record.id} r${record.revision} ${record.kind}/${record.source}${record.reviewed ? "/reviewed" : ""}]\nSources: ${JSON.stringify(record.sources)}\n${record.text}`
    }
    if (action === "search") {
      const result = await this.search(args.join(" "), signal, run)
      return `[${result.mode}${result.reason ? `: ${result.reason}` : ""}]\n${result.records.map((r) => `[${r.record.id}] ${r.record.text}`).join("\n\n") || "No matches"}`
    }
    if (action === "edit" || action === "forget" || action === "accept") {
      const record = visible.find((r) => r.id === args[0])
      if (!record) throw new Error("Memory not found")
      return this.mutate(record.id, action, args.slice(1).join(" "), signal, record.revision)
    }
    if (action === "repair") {
      this.requireWrite()
      if (!store) return "No memory store to repair"
      const repaired = this.cleanSnapshot(store.repair())
      writeIndex(store.root, repaired)
      return "Memory index rebuilt from the committed Markdown records."
    }
    if (action === "refresh") {
      this.invalidate()
      return "Memory will be selected again for the next turn."
    }
    throw new Error(
      "Use memory list|show|search|remember|edit|forget|accept|status|repair|index|link|refresh|extract|consolidate",
    )
  }
  async commitCandidates(
    start: MemorySnapshot,
    texts: Array<{ text: string; sources: MemorySource[] }>,
    hash: string,
    signal: AbortSignal,
    replace: string[] = [],
  ) {
    this.requireWrite()
    const store = (await this.store(signal, true)) as MemoryStore,
      identity = await this.identity(signal),
      now = new Date().toISOString()
    if (
      replace.some(
        (id) =>
          !start.records.some(
            (r) => r.id === id && r.kind === "candidate" && r.worktree === identity.worktree,
          ),
      )
    )
      throw new Error("Consolidation cannot replace curated or foreign records")
    const retained = start.records.filter((r) => !replace.includes(r.id))
    const seen = new Set(retained.map((r) => this.options.sanitize(r.text).trim().toLowerCase()))
    const candidates: MemoryRecord[] = texts
      .filter((item) => {
        const key = this.options.sanitize(item.text).trim().toLowerCase()
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
      .map(
        (item) =>
          start.records.find(
            (r) =>
              replace.includes(r.id) &&
              r.text === this.options.sanitize(item.text) &&
              JSON.stringify(r.sources) === JSON.stringify(item.sources),
          ) ?? {
            id: crypto.randomUUID(),
            revision: 1,
            scope: "worktree",
            worktree: identity.worktree,
            kind: "candidate",
            source: "generated",
            session: this.options.session,
            sources: item.sources,
            created: now,
            updated: now,
            text: this.options.sanitize(item.text),
          },
      )
    signal.throwIfAborted()
    this.#index(store, store.commit(start.revision, [...retained, ...candidates], [...start.processed, hash]))
    this.invalidate()
    return candidates.length
  }
}
