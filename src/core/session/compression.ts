import { existsSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
import { atomic, bytes, digest, hostPath, json } from "./files.ts"
export const LOG_LIMIT = 64 * 1024 * 1024
const names = new Set(["events.jsonl", "transcript.jsonl"])
type Compressed = { version: 1; codec: "gzip"; file: string; hash: string; size: number }
function manifest(path: string): Compressed | undefined {
  if (!existsSync(`${path}.storage.json`)) return undefined
  const value = json<Compressed>(`${path}.storage.json`, 4096)
  if (
    value.version !== 1 ||
    value.codec !== "gzip" ||
    value.file !== `${path.split("/").at(-1)}.gz` ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    value.size > LOG_LIMIT ||
    !/^[a-f0-9]{64}$/.test(value.hash)
  )
    throw new Error("Invalid compressed session manifest")
  return value
}
export function logBytes(path: string, max = LOG_LIMIT): Buffer {
  path = hostPath(path)
  const stored = manifest(path)
  if (!stored) return existsSync(path) ? bytes(path, max) : Buffer.alloc(0)
  if (stored.size > max) throw new Error("Session log exceeds the requested read limit")
  const plain = gunzipSync(bytes(`${path}.gz`, LOG_LIMIT), { maxOutputLength: Math.max(1, stored.size) })
  if (plain.length !== stored.size || digest(plain) !== stored.hash)
    throw new Error("Compressed session checksum mismatch")
  if (existsSync(path) && digest(bytes(path, LOG_LIMIT)) !== stored.hash)
    throw new Error("Conflicting plain and compressed session logs; preserve both before recovery")
  return plain
}
/** Caller holds the session writer/maintenance lease. */
export function materialize(path: string): void {
  path = hostPath(path)
  if (!manifest(path)) return
  atomic(path, logBytes(path))
  unlinkSync(`${path}.storage.json`)
  unlinkSync(`${path}.gz`)
}
/** Caller holds the session maintenance lease and has checked inactivity. */
export function compressLogs(root: string): string[] {
  const compressed: string[] = []
  for (const name of names) {
    const path = join(hostPath(root), name)
    if (manifest(path) || !existsSync(path)) continue
    const value = bytes(path, LOG_LIMIT),
      encoded = gzipSync(value)
    if (!gunzipSync(encoded, { maxOutputLength: Math.max(value.length, 1) }).equals(value))
      throw new Error("Compression verification failed")
    atomic(`${path}.gz`, encoded)
    atomic(
      `${path}.storage.json`,
      JSON.stringify({
        version: 1,
        codec: "gzip",
        file: `${name}.gz`,
        hash: digest(value),
        size: value.length,
      }),
    )
    unlinkSync(path)
    compressed.push(name)
  }
  return compressed
}
