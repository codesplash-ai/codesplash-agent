import { lstat, opendir, statfs } from "node:fs/promises"
import { join } from "node:path"
import { configDirectory, dataDirectory } from "../core/config.ts"

export async function diskUsage(
  root: string,
  limit = 250000,
): Promise<{ bytes: number; files: number; skippedLinks: number; truncated: boolean }> {
  const result = { bytes: 0, files: 0, skippedLinks: 0, truncated: false },
    pending = [root],
    inodes = new Set<string>()
  let visited = 0
  while (pending.length) {
    if (++visited > limit) {
      result.truncated = true
      break
    }
    const path = pending.pop()!,
      info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
    if (!info) continue
    if (info.isSymbolicLink()) {
      result.skippedLinks++
      continue
    }
    if (info.isDirectory()) {
      for await (const entry of await opendir(path)) {
        if (visited + pending.length >= limit) {
          result.truncated = true
          break
        }
        pending.push(join(path, entry.name))
      }
      continue
    }
    if (!info.isFile()) continue
    const key = `${info.dev}:${info.ino}`
    if (inodes.has(key)) continue
    inodes.add(key)
    result.files++
    result.bytes += info.size
  }
  return result
}
export async function runDiskCommand(args: string[]): Promise<number> {
  if (args.length) throw new Error("Use disk without arguments; reports owned config/data trees only")
  const roots = [...new Set([configDirectory(), dataDirectory()])]
  const report = await Promise.all(
    roots.map(async (path) => ({
      path,
      ...(await diskUsage(path)),
      availableBytes: await statfs(path)
        .then((s) => s.bavail * s.bsize)
        .catch(() => null),
    })),
  )
  process.stdout.write(`${JSON.stringify({ version: 1, roots: report }, null, 2)}\n`)
  return 0
}
