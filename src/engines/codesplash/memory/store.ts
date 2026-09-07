import { existsSync, readdirSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import {
  MEMORY_BODY_BYTES,
  MEMORY_ID,
  MEMORY_MAX_RECORDS,
  type MemoryRecord,
  type MemorySnapshot,
} from "./contracts.ts"
import { atomicWrite, directory, locked, readBounded } from "./files.ts"
export const OBJECT_NAME = /^[0-9a-f-]{36}-[0-9a-f-]{36}\.md$/
type Manifest = { version: 1; revision: string; records: Record<string, string>; processed: string[] }
export function validateRecord(value: unknown): asserts value is MemoryRecord {
  if (!value || typeof value !== "object") throw new Error("Invalid memory record")
  const r = value as MemoryRecord
  if (Buffer.byteLength(JSON.stringify(value)) > 8000)
    throw new Error("Memory metadata exceeds the record size limit")
  if (
    !MEMORY_ID.test(r.id) ||
    !Number.isSafeInteger(r.revision) ||
    r.revision < 1 ||
    !["repo", "worktree"].includes(r.scope) ||
    !/^[0-9a-f]{64}$/.test(r.worktree) ||
    !["fact", "candidate", "note"].includes(r.kind) ||
    !["user", "generated"].includes(r.source) ||
    (r.reviewed !== undefined && typeof r.reviewed !== "boolean") ||
    typeof r.session !== "string" ||
    r.session.length > 128 ||
    typeof r.text !== "string" ||
    !r.text.trim() ||
    Buffer.byteLength(r.text) > MEMORY_BODY_BYTES ||
    !Number.isFinite(Date.parse(r.created)) ||
    !Number.isFinite(Date.parse(r.updated)) ||
    !Array.isArray(r.sources) ||
    r.sources.length > 32 ||
    r.sources.some(
      (s) =>
        !s ||
        typeof s.id !== "string" ||
        s.id.length > 128 ||
        !/^[0-9a-f]{64}$/.test(s.hash) ||
        (s.path !== undefined && (typeof s.path !== "string" || s.path.length > 4096)),
    )
  )
    throw new Error("Invalid or oversized memory record")
}
export class MemoryStore {
  constructor(readonly root: string) {}
  snapshot(): MemorySnapshot {
    // A writer may retire old objects between our manifest and object reads. Retry only
    // if its atomic commit changed the manifest; genuine corruption remains an error.
    for (let attempt = 0; attempt < 3; attempt++) {
      const path = join(this.root, "manifest.json")
      const before = existsSync(path) ? readBounded(path) : ""
      try {
        const result = this.#snapshot()
        if ((existsSync(path) ? readBounded(path) : "") === before) return result
      } catch (error) {
        if ((existsSync(path) ? readBounded(path) : "") === before) throw error
      }
    }
    throw new Error("Memory changed while reading; retry")
  }
  #snapshot(): MemorySnapshot {
    directory(this.root)
    const path = join(this.root, "manifest.json")
    if (!existsSync(path)) return { revision: "", records: [], processed: [] }
    const m = JSON.parse(readBounded(path)) as Manifest
    if (
      m.version !== 1 ||
      !MEMORY_ID.test(m.revision) ||
      !m.records ||
      typeof m.records !== "object" ||
      Array.isArray(m.records) ||
      Object.keys(m.records).length > MEMORY_MAX_RECORDS ||
      !Array.isArray(m.processed) ||
      m.processed.length > 256 ||
      m.processed.some((hash) => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))
    )
      throw new Error("Corrupt memory manifest; preserve the store before recovery")
    const records = Object.entries(m.records).map(([id, name]) => {
      if (!MEMORY_ID.test(id) || !OBJECT_NAME.test(name) || !name.startsWith(`${id}-`))
        throw new Error("Invalid memory object reference")
      const text = readBounded(join(this.root, "objects", name), 8192)
      const lines = text.split("\n")
      if (lines[0] !== "---" || lines[2] !== "---") throw new Error("Invalid memory Markdown header")
      const record: unknown = { ...JSON.parse(lines[1] ?? ""), text: lines.slice(3).join("\n") }
      validateRecord(record)
      if (record.id !== id) throw new Error("Memory object identity mismatch")
      return record
    })
    return { revision: m.revision, records, processed: m.processed }
  }
  commit(expected: string, records: MemoryRecord[], processed: string[] = []): MemorySnapshot {
    if (records.length > MEMORY_MAX_RECORDS || new Set(records.map((r) => r.id)).size !== records.length)
      throw new Error("Memory record limit or duplicate id")
    for (const record of records) validateRecord(record)
    if (processed.some((hash) => !/^[0-9a-f]{64}$/.test(hash)))
      throw new Error("Invalid processed source hash")
    return locked(this.root, () => {
      const before = this.snapshot()
      if (before.revision !== expected) throw new Error("Memory changed concurrently; reload and retry")
      const oldManifest: Manifest | undefined = expected
        ? (JSON.parse(readBounded(join(this.root, "manifest.json"))) as Manifest)
        : undefined
      const manifest: Manifest = {
        version: 1,
        revision: crypto.randomUUID(),
        records: {},
        processed: [...new Set(processed)].slice(-256),
      }
      directory(join(this.root, "objects"), true)
      for (const { text, ...meta } of records) {
        const previous = before.records.find((record) => record.id === meta.id)
        const oldFile = oldManifest?.records[meta.id]
        if (oldFile && previous && JSON.stringify(previous) === JSON.stringify({ ...meta, text })) {
          manifest.records[meta.id] = oldFile
          continue
        }
        const body = `---\n${JSON.stringify(meta)}\n---\n${text}`
        if (Buffer.byteLength(body) > 8192) throw new Error("Memory record metadata exceeds 8 KiB")
        const file = `${meta.id}-${crypto.randomUUID()}.md`
        atomicWrite(join(this.root, "objects", file), body)
        manifest.records[meta.id] = file
      }
      atomicWrite(join(this.root, "manifest.json"), JSON.stringify(manifest))
      try {
        this.#collect(manifest)
      } catch {
        throw new Error("Memory saved, but cleanup failed; run memory repair before retrying a write")
      }
      return { revision: manifest.revision, records, processed: manifest.processed }
    })
  }
  repair(): MemorySnapshot {
    return locked(this.root, () => {
      const snapshot = this.snapshot()
      if (snapshot.revision)
        this.#collect(JSON.parse(readBounded(join(this.root, "manifest.json"))) as Manifest)
      return snapshot
    })
  }
  #collect(manifest: Manifest): void {
    const active = new Set(Object.values(manifest.records))
    for (const file of readdirSync(join(this.root, "objects")))
      if ((OBJECT_NAME.test(file) && !active.has(file)) || /^[0-9a-f-]+\.md\.[0-9a-f-]+\.tmp$/.test(file))
        unlinkSync(join(this.root, "objects", file))
    for (const file of readdirSync(this.root))
      if (
        /^index-[0-9a-f-]+\.sqlite(?:-journal)?$/.test(file) ||
        /^manifest\.json\.[0-9a-f-]+\.tmp$/.test(file)
      )
        unlinkSync(join(this.root, file))
    // Derived content may contain deleted text; never retain it after a committed mutation.
    for (const name of ["index.sqlite", "index.sqlite-journal", "index.sqlite-wal", "index.sqlite-shm"])
      if (existsSync(join(this.root, name))) unlinkSync(join(this.root, name))
  }
}
