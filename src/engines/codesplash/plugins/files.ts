import { createHash } from "node:crypto"
import { closeSync, constants, fsyncSync, openSync } from "node:fs"
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { bytes, digest } from "../../../core/session/files.ts"

export const PACKAGE_BYTES = 128 * 1024 * 1024
export const ARCHIVE_BYTES = 32 * 1024 * 1024
export const FILE_BYTES = 16 * 1024 * 1024
export type PackageFile = { path: string; sha256: string; size: number; executable: boolean }
export function packagePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    value.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error("Unsafe plugin path")
  return value
}
export async function packageFiles(root: string, signal?: AbortSignal): Promise<PackageFile[]> {
  if (!(await lstat(root)).isDirectory()) throw new Error("Plugin root must be a real directory")
  root = await realpath(root)
  const files: PackageFile[] = []
  let total = 0,
    entries = 0
  const visit = async (directory: string, depth: number) => {
    if (depth > 32) throw new Error("Plugin directory depth exceeded")
    for (const name of (await readdir(directory)).sort()) {
      signal?.throwIfAborted()
      if (++entries > 4096) throw new Error("Plugin exceeds 4096 entries")
      const path = join(directory, name),
        rel = packagePath(relative(root, path)),
        info = await lstat(path)
      if (info.isDirectory()) await visit(path, depth + 1)
      else {
        if (!info.isFile() || info.nlink !== 1)
          throw new Error(`Plugin links and special files are forbidden: ${rel}`)
        const data = bytes(path, FILE_BYTES)
        total += data.length
        if (total > PACKAGE_BYTES) throw new Error("Plugin exceeds 128 MiB")
        files.push({ path: rel, sha256: digest(data), size: data.length, executable: !!(info.mode & 0o111) })
      }
    }
  }
  await visit(root, 0)
  return files
}
export async function copyPackage(
  root: string,
  target: string,
  signal?: AbortSignal,
): Promise<PackageFile[]> {
  const files = await packageFiles(root, signal)
  for (const file of files) {
    signal?.throwIfAborted()
    const data = bytes(join(root, file.path), FILE_BYTES)
    if (digest(data) !== file.sha256) throw new Error("Plugin source changed while copying")
    await mkdir(dirname(join(target, file.path)), { recursive: true, mode: 0o700 })
    await writeFile(join(target, file.path), data, { flag: "wx", mode: file.executable ? 0o700 : 0o600 })
  }
  return files
}
export async function boundedBody(
  body: ReadableStream<Uint8Array>,
  max: number,
  signal?: AbortSignal,
  account?: (bytes: number) => void,
): Promise<Buffer> {
  const reader = body.getReader(),
    chunks: Uint8Array[] = []
  let size = 0
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener("abort", abort, { once: true })
  try {
    while (true) {
      signal?.throwIfAborted()
      const { value, done } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      size += value.length
      account?.(value.length)
      if (size > max) throw new Error("Plugin download/expansion exceeds its byte limit")
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  } finally {
    signal?.removeEventListener("abort", abort)
    await reader.cancel().catch(() => {})
  }
}
export function verifyIntegrity(data: Uint8Array, integrity: string): void {
  if (
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity) ||
    `sha512-${createHash("sha512").update(data).digest("base64")}` !== integrity
  )
    throw new Error("Plugin archive integrity mismatch (SHA-512 required)")
}
export async function unpackArchive(
  input: Uint8Array,
  target?: string,
  strip = false,
  signal?: AbortSignal,
): Promise<{ bytes: number; entries: number }> {
  if (input.length > ARCHIVE_BYTES) throw new Error("Plugin archive exceeds 32 MiB")
  const data =
    input[0] === 31 && input[1] === 139
      ? await boundedBody(
          new Blob([new Uint8Array(input)]).stream().pipeThrough(new DecompressionStream("gzip")),
          PACKAGE_BYTES,
          signal,
        )
      : Buffer.from(input)
  if (data.length > PACKAGE_BYTES) throw new Error("Plugin archive exceeds 128 MiB")
  const seen = new Set<string>()
  const field = (block: Buffer, start: number, length: number) =>
    block
      .subarray(start, start + length)
      .toString()
      .split("\0")[0]!
  let count = 0,
    end = false
  for (let offset = 0; offset + 512 <= data.length; ) {
    signal?.throwIfAborted()
    const header = data.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      end = true
      break
    }
    if (++count > 4096) throw new Error("Plugin archive exceeds 4096 entries")
    const checksum = parseInt(field(header, 148, 8).trim(), 8)
    const actual = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0)
    if (actual !== checksum) throw new Error("Invalid plugin archive checksum")
    const sizeText = field(header, 124, 12).trim()
    if (!/^[0-7]+$/.test(sizeText)) throw new Error("Invalid archive size")
    const size = parseInt(sizeText, 8),
      type = field(header, 156, 1)
    if (size > FILE_BYTES || offset + 512 + size > data.length)
      throw new Error("Invalid or oversized archive entry")
    let name = field(header, 0, 100),
      prefix = field(header, 345, 155)
    if (prefix) name = `${prefix}/${name}`
    name = name.replace(/\/$/, "")
    // Git's global PAX record carries only inert commit metadata. Path/size overrides are refused.
    if (type === "g") {
      const metadata = data.subarray(offset + 512, offset + 512 + size).toString()
      if (metadata.split("\n").some((line) => line && !/^\d+ comment=[a-f0-9]{40,64}$/.test(line)))
        throw new Error("Unsupported archive metadata")
    } else {
      packagePath(name)
      if (strip) {
        if (name === "package" && type === "5") {
          offset += 512 + Math.ceil(size / 512) * 512
          continue
        }
        if (!name.startsWith("package/")) throw new Error("npm archive must contain one package root")
        name = packagePath(name.slice(8))
      }
      if (seen.has(name)) throw new Error("Duplicate plugin archive path")
      seen.add(name)
      if (!["", "0", "5"].includes(type)) throw new Error("Plugin archive links and extensions are forbidden")
      if (type === "5" && size) throw new Error("Invalid archive directory")
      if (target) {
        const path = join(target, name)
        await mkdir(type === "5" ? path : dirname(path), { recursive: true, mode: 0o700 })
        if (type !== "5")
          await writeFile(path, data.subarray(offset + 512, offset + 512 + size), {
            flag: "wx",
            mode: parseInt(field(header, 100, 8), 8) & 0o111 ? 0o700 : 0o600,
          })
      }
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  if (!end) throw new Error("Truncated plugin archive")
  return { bytes: data.length, entries: count }
}

export function syncPackage(root: string, files: PackageFile[]): void {
  const directories = new Set([root])
  for (const file of files) {
    const path = join(root, file.path),
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    let parent = dirname(path)
    while (parent !== root) {
      directories.add(parent)
      parent = dirname(parent)
    }
  }
  for (const path of [...directories].sort((a, b) => b.length - a.length)) syncDirectory(path)
}
export function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
