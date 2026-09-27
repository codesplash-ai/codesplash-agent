import { existsSync } from "node:fs"
import { chmod, readdir, readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { gunzipSync } from "node:zlib"
import { networkFetch } from "../../../core/network.ts"
import { atomic, bytes, digest } from "../../../core/session/files.ts"

export type LanguageDescriptor = {
  id: string
  languageId: string
  extensions: string[]
  command: string[]
  kind: "lsp" | "formatter" | "tree-sitter"
  download?: { url: string; sha256: string; compression?: "gzip" }
}
type Reviewed = {
  version: 1
  descriptor: LanguageDescriptor
  fingerprint: string
  executableSha256?: string
  fileArguments: Record<string, string>
}
export function descriptor(raw: unknown): LanguageDescriptor {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Language descriptor must be an object")
  const d = raw as LanguageDescriptor
  if (
    Object.keys(d).some(
      (k) => !["id", "languageId", "extensions", "command", "kind", "download"].includes(k),
    ) ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(d.id) ||
    typeof d.languageId !== "string" ||
    d.languageId.length > 64 ||
    !["lsp", "formatter", "tree-sitter"].includes(d.kind) ||
    !Array.isArray(d.extensions) ||
    !d.extensions.length ||
    d.extensions.length > 64 ||
    d.extensions.some((e) => !/^\.[a-zA-Z0-9]+$/.test(e)) ||
    !Array.isArray(d.command) ||
    !d.command.length ||
    d.command.length > 64 ||
    d.command.some((a) => typeof a !== "string" || a.length > 4096 || a.includes("\0"))
  )
    throw new Error("Invalid language descriptor")
  if (d.download) {
    const url = new URL(d.download.url)
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !/^[a-f0-9]{64}$/.test(d.download.sha256) ||
      ![undefined, "gzip"].includes(d.download.compression) ||
      Object.keys(d.download).some((k) => !["url", "sha256", "compression"].includes(k)) ||
      d.command[0] !== "{binary}"
    )
      throw new Error("Managed downloads require HTTPS, SHA256 and a {binary} command")
  } else if (!isAbsolute(d.command[0]!))
    throw new Error("Reviewed local executable must have an absolute path")
  return structuredClone(d)
}
export async function reviewDescriptor(path: string) {
  const d = descriptor(JSON.parse(bytes(path, 65536).toString()))
  const executableSha256 = d.download ? undefined : digest(await readFile(await realpath(d.command[0]!)))
  const fileArguments: Record<string, string> = {}
  for (const argument of d.command.slice(1)) {
    if (
      isAbsolute(argument) &&
      !argument.includes("{file}") &&
      (await stat(argument).catch(() => undefined))?.isFile()
    )
      fileArguments[argument] = digest(bytes(await realpath(argument), 128 * 1024 * 1024))
  }
  const fingerprint = digest(JSON.stringify({ descriptor: d, executableSha256, fileArguments }))
  return { version: 1 as const, descriptor: d, executableSha256, fileArguments, fingerprint }
}
export async function installDescriptor(root: string, path: string, fingerprint: string) {
  const review = await reviewDescriptor(path)
  if (review.fingerprint !== fingerprint) throw new Error("Language service changed since review")
  atomic(join(root, `${review.descriptor.id}.json`), JSON.stringify(review))
  return { installed: review.descriptor.id, fingerprint, downloadOnFirstUse: !!review.descriptor.download }
}
export async function reviewedDescriptors(root: string): Promise<Reviewed[]> {
  if (!existsSync(root)) return []
  const result: Reviewed[] = []
  for (const name of (await readdir(root))
    .filter((n) => /^[a-z][a-z0-9-]{0,63}\.json$/.test(n))
    .slice(0, 64)) {
    const r = JSON.parse(bytes(join(root, name), 65536).toString()) as Reviewed
    descriptor(r.descriptor)
    if (
      r.version !== 1 ||
      r.fingerprint !==
        digest(
          JSON.stringify({
            descriptor: r.descriptor,
            executableSha256: r.executableSha256,
            fileArguments: r.fileArguments,
          }),
        )
    )
      throw new Error(`Language service ${name} changed after review`)
    result.push(r)
  }
  return result
}
const installing = new Map<string, Promise<string[]>>()
export async function managedCommand(
  root: string,
  reviewed: Reviewed,
  signal: AbortSignal,
): Promise<string[]> {
  const key = `${root}/${reviewed.fingerprint}`
  const previous = installing.get(key)
  if (previous) return previous
  const work = (async () => {
    const d = reviewed.descriptor
    for (const [path, hash] of Object.entries(reviewed.fileArguments)) {
      if (digest(bytes(await realpath(path), 128 * 1024 * 1024)) !== hash)
        throw new Error("Language command file changed; review it again")
    }
    if (!d.download) {
      if (digest(await readFile(d.command[0]!)) !== reviewed.executableSha256)
        throw new Error("Language executable changed; review it again")
      return [...d.command]
    }
    const destination = join(root, "bin", reviewed.fingerprint),
      original = `${destination}.download`
    if (!existsSync(original) || digest(bytes(original, 128 * 1024 * 1024)) !== d.download.sha256) {
      const response = await networkFetch(d.download.url, {
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      })
      if (!response.ok || !response.body) throw new Error("Managed language-server download failed")
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = []
      let total = 0
      try {
        while (true) {
          const r = await reader.read()
          if (r.done) break
          total += r.value.length
          if (total > 128 * 1024 * 1024) throw new Error("Language download exceeds limit")
          chunks.push(r.value)
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
      const content = Buffer.concat(chunks)
      if (digest(content) !== d.download.sha256) throw new Error("Language download checksum mismatch")
      atomic(original, content)
    }
    const compressed = bytes(original, 128 * 1024 * 1024)
    const executable = d.download.compression
      ? gunzipSync(compressed, { maxOutputLength: 256 * 1024 * 1024 })
      : compressed
    if (!existsSync(destination) || digest(bytes(destination, 256 * 1024 * 1024)) !== digest(executable)) {
      atomic(destination, executable)
      await chmod(destination, 0o700)
    }
    return [destination, ...d.command.slice(1)]
  })()
  installing.set(key, work)
  try {
    return await work
  } finally {
    installing.delete(key)
  }
}
