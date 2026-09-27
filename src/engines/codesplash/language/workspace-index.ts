import { existsSync } from "node:fs"
import { join } from "node:path"
import { atomic, digest, directory, json, lease } from "../../../core/session/files.ts"

type Position = { line: number; character: number }
export type IndexedSymbol = { name: string; position: Position; kind?: number; references?: unknown[] }
type Entry = { hash: string; descriptors: string; symbols: IndexedSymbol[] }
type Snapshot = { version: 1; files: Record<string, Entry> }
function position(raw: unknown): raw is Position {
  const p = raw as Position
  return (
    !!p &&
    Number.isSafeInteger(p.line) &&
    p.line >= 0 &&
    Number.isSafeInteger(p.character) &&
    p.character >= 0
  )
}
/** LSP document symbols, or reviewed Tree-sitter JSON with {name, position} records. */
export function indexSymbols(raw: unknown): IndexedSymbol[] {
  if (raw && typeof raw === "object" && "captures" in raw) {
    const captures = (raw as { captures: unknown }).captures
    if (typeof captures !== "string") throw new Error("Index capture output must be JSON")
    try {
      raw = JSON.parse(captures)
    } catch {
      throw new Error(
        "Workspace indexing requires structured JSON captures from the reviewed Tree-sitter query",
      )
    }
  }
  if (!Array.isArray(raw)) throw new Error("Language service did not return a symbol list")
  const output: IndexedSymbol[] = []
  let visited = 0
  const walk = (values: unknown[], depth: number) => {
    if (depth > 32) throw new Error("Symbol nesting exceeds index limit")
    for (const value of values) {
      if (++visited > 4096) throw new Error("Symbol count exceeds index limit")
      if (!value || typeof value !== "object") continue
      const s = value as Record<string, any>
      const start = s.position ?? s.selectionRange?.start ?? s.range?.start ?? s.location?.range?.start
      if (typeof s.name === "string" && s.name.length <= 512 && position(start))
        output.push({
          name: s.name,
          position: { line: start.line, character: start.character },
          ...(Number.isSafeInteger(s.kind) ? { kind: s.kind } : {}),
        })
      if (Array.isArray(s.children)) walk(s.children, depth + 1)
    }
  }
  walk(raw, 0)
  return output.slice(0, 256)
}
/** Advisory private index. Content and policy are revalidated by the caller on every use. */
export class WorkspaceIndex {
  readonly directory: string
  #memory: Snapshot = { version: 1, files: {} }
  constructor(
    root: string,
    cwd: string,
    readonly persistent: boolean,
  ) {
    this.directory = join(root, "indexes", digest(cwd))
  }
  read(): Snapshot {
    if (!this.persistent) return structuredClone(this.#memory)
    const path = join(this.directory, "symbols.json")
    if (!existsSync(path)) return { version: 1, files: {} }
    const value = json<Snapshot>(path, 16 * 1024 * 1024)
    if (
      value.version !== 1 ||
      !value.files ||
      typeof value.files !== "object" ||
      Array.isArray(value.files) ||
      Object.keys(value.files).length > 2048
    )
      throw new Error("Invalid workspace index; rebuild it explicitly")
    for (const entry of Object.values(value.files)) {
      if (
        !entry ||
        !/^[a-f0-9]{64}$/.test(entry.hash) ||
        !/^[a-f0-9]{64}$/.test(entry.descriptors) ||
        !Array.isArray(entry.symbols) ||
        entry.symbols.length > 256 ||
        entry.symbols.some(
          (s) =>
            !s ||
            typeof s.name !== "string" ||
            s.name.length > 512 ||
            !position(s.position) ||
            (s.references !== undefined && (!Array.isArray(s.references) || s.references.length > 256)),
        )
      )
        throw new Error("Invalid workspace index entry")
    }
    return value
  }
  update(entries: Record<string, Entry>): void {
    if (this.persistent) directory(this.directory, true)
    const release = this.persistent ? lease(this.directory, "index.lease") : () => {}
    try {
      const value = this.read()
      for (const [path, entry] of Object.entries(entries)) value.files[path] = entry
      if (Object.keys(value.files).length > 2048) throw new Error("Workspace index limit is 2048 files")
      const encoded = JSON.stringify(value)
      if (Buffer.byteLength(encoded) > 16 * 1024 * 1024) throw new Error("Workspace index exceeds 16 MiB")
      if (this.persistent) atomic(join(this.directory, "symbols.json"), encoded)
      else this.#memory = value
    } finally {
      release()
    }
  }
}
