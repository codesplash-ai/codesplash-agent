import { Database } from "bun:sqlite"
import { chmodSync, existsSync, lstatSync, renameSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import type { MemoryRecord, MemorySearch, MemorySnapshot } from "./contracts.ts"
import { directory, locked, readBounded } from "./files.ts"
import { memoryHash } from "./identity.ts"
export type StoredVector = { id: string; hash: string; key: string; values: number[] }
export function validVector(value: unknown, dimensions?: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 1536 &&
    (dimensions === undefined || value.length === dimensions) &&
    value.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 1e10) &&
    value.some((n) => n !== 0)
  )
}
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || !a.length) return 0
  let dot = 0,
    na = 0,
    nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0,
      y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}
const words = (text: string) => [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 128)
function overlap(a: string, b: string): number {
  const one = new Set(words(a)),
    two = new Set(words(b)),
    common = [...one].filter((word) => two.has(word)).length
  return common / Math.max(1, one.size + two.size - common)
}
function makeIndex(snapshot: MemorySnapshot, path = ":memory:", vectors: StoredVector[] = []): Database {
  const db = new Database(path, { create: true, strict: true })
  try {
    db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=500; CREATE TABLE meta(revision TEXT); CREATE VIRTUAL TABLE facts USING fts5(id UNINDEXED, body); CREATE TABLE vectors(id TEXT PRIMARY KEY, hash TEXT, key TEXT, data BLOB);",
    )
    db.transaction(() => {
      db.prepare("INSERT INTO meta VALUES (?)").run(snapshot.revision)
      const insert = db.prepare("INSERT INTO facts VALUES (?, ?)")
      for (const record of snapshot.records) insert.run(record.id, record.text)
      for (const vector of vectors) {
        const record = snapshot.records.find((r) => r.id === vector.id)
        if (record && vector.hash === memoryHash(record.text) && validVector(vector.values))
          db.prepare("INSERT OR REPLACE INTO vectors VALUES (?, ?, ?, ?)").run(
            vector.id,
            vector.hash,
            vector.key,
            Buffer.from(new Float32Array(vector.values).buffer),
          )
      }
    })()
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
export function writeIndex(root: string, snapshot: MemorySnapshot, vectors: StoredVector[] = []): void {
  locked(root, () => {
    if (
      (JSON.parse(readBounded(join(root, "manifest.json"))) as { revision: string }).revision !==
      snapshot.revision
    )
      throw new Error("Memory changed while indexing; retry")
    const temp = join(root, `index-${crypto.randomUUID()}.sqlite`)
    try {
      const db = makeIndex(snapshot, temp, vectors)
      db.close()
      chmodSync(temp, 0o600)
      renameSync(temp, join(root, "index.sqlite"))
    } finally {
      if (existsSync(temp)) unlinkSync(temp)
    }
  })
}
export class MemoryIndex {
  readonly db: Database
  readonly fallback: boolean
  constructor(root: string | undefined, snapshot: MemorySnapshot) {
    let db: Database | undefined
    if (root) {
      directory(root)
      const path = join(root, "index.sqlite")
      if (existsSync(path)) {
        const info = lstatSync(path)
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 64 * 1024 * 1024)
          throw new Error("Unsafe memory index")
        try {
          db = new Database(path, { readonly: true, strict: true })
          if (
            (db.query("SELECT revision FROM meta").get() as { revision: string })?.revision !==
            snapshot.revision
          ) {
            db.close()
            db = undefined
          }
        } catch {
          db?.close()
          db = undefined
        }
      }
    }
    this.fallback = !db
    this.db = db ?? makeIndex(snapshot)
  }
  vectors(key: string): StoredVector[] {
    try {
      return (
        this.db.query("SELECT id, hash, key, data FROM vectors WHERE key = ? LIMIT 2000").all(key) as Array<{
          id: string
          hash: string
          key: string
          data: Uint8Array
        }>
      ).flatMap((row) => {
        if (!row.data.byteLength || row.data.byteLength % 4 || row.data.byteLength > 1536 * 4) return []
        const values = Array.from(new Float32Array(Uint8Array.from(row.data).buffer))
        return validVector(values) ? [{ id: row.id, hash: row.hash, key: row.key, values }] : []
      })
    } catch {
      return []
    }
  }
  search(
    query: string,
    records: MemoryRecord[],
    vector?: { key: string; values: number[] },
    now = Date.now(),
  ): MemorySearch {
    if (query.length > 1000) throw new Error("Memory search query exceeds 1000 characters")
    const tokens = words(query).slice(0, 32)
    if (!tokens.length) return { mode: "lexical", records: [] }
    const permitted = new Map(records.map((r) => [r.id, r]))
    const ranked = new Map<string, number>()
    const rows = this.db
      .query("SELECT id, bm25(facts) AS score FROM facts WHERE facts MATCH ? ORDER BY score, id LIMIT 2000")
      .all(tokens.map((token) => `"${token}"`).join(" OR ")) as Array<{ id: string; score: number }>
    rows
      .filter((r) => permitted.has(r.id))
      .slice(0, 100)
      .forEach((row, i) => {
        ranked.set(row.id, 1 / (20 + i))
      })
    const vectors = vector
      ? this.vectors(vector.key).filter((v) => {
          const record = permitted.get(v.id)
          return record && memoryHash(record.text) === v.hash && v.values.length === vector.values.length
        })
      : []
    if (vector)
      vectors
        .map((v) => ({ id: v.id, score: cosine(v.values, vector.values) }))
        .filter((v) => v.score > 0.2)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, 100)
        .forEach((row, i) => {
          ranked.set(row.id, (ranked.get(row.id) ?? 0) + 1 / (20 + i))
        })
    const pool = [...ranked]
      .map(([id, score]) => {
        const record = permitted.get(id) as MemoryRecord
        const age = Math.max(0, now - Date.parse(record.updated)) / 86400000
        return {
          record,
          score:
            score * (record.source === "user" || record.reviewed ? 1.2 : Math.exp((-Math.LN2 * age) / 30)),
        }
      })
      .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
      .slice(0, 100)
    const result: typeof pool = []
    const top = pool[0]?.score ?? 1
    let bytes = 0
    while (pool.length && result.length < 6) {
      pool.sort((a, b) => {
        const rank = (item: typeof a) =>
          (0.7 * item.score) / top -
          0.3 * Math.max(0, ...result.map((r) => overlap(item.record.text, r.record.text)))
        return rank(b) - rank(a) || a.record.id.localeCompare(b.record.id)
      })
      const next = pool.shift()
      if (!next) break
      if (result.some((r) => overlap(next.record.text, r.record.text) > 0.9)) continue
      const size = Buffer.byteLength(next.record.text) + 200
      if (bytes + size > 8192) continue
      bytes += size
      result.push(next)
    }
    return { mode: vectors.length ? "hybrid" : "lexical", records: result }
  }
  close(): void {
    this.db.close()
  }
}
