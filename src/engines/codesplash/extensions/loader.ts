import { constants } from "node:fs"
import { mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises"
import { isBuiltin } from "node:module"
import { tmpdir } from "node:os"
import { dirname, extname, join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { digest } from "../../../core/session/files.ts"
import type { ExtensionReview } from "./trust.ts"

/** Copy reviewed bytes, then import a fresh module graph. Never installs dependencies. */
export async function snapshotExtension(review: ExtensionReview, signal: AbortSignal) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codesplash-extension-")))
  const close = () => rm(root, { recursive: true, force: true })
  try {
    for (const file of review.files) {
      signal.throwIfAborted()
      const handle = await open(
        join(review.root, file.path),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      let bytes: Buffer
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size > 512 * 1024 * 1024)
          throw new Error("Extension changed during activation")
        bytes = Buffer.alloc(stat.size)
        let offset = 0
        while (offset < bytes.length) {
          signal.throwIfAborted()
          const { bytesRead } = await handle.read(bytes, offset, Math.min(128 * 1024, bytes.length - offset))
          if (!bytesRead) throw new Error("Extension changed during activation")
          offset += bytesRead
        }
        if ((await handle.stat()).size !== stat.size || digest(bytes) !== file.sha256)
          throw new Error("Extension changed during activation")
      } finally {
        await handle.close()
      }
      const destination = join(root, file.path)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await writeFile(destination, bytes, { mode: 0o600, flag: "wx" })
    }
    // Reject ordinary imports reaching outside the reviewed snapshot. This is a dependency
    // contract, not a security boundary against arbitrary trusted computed imports or direct I/O.
    const pending = [join(root, review.config.entry)],
      seen = new Set<string>()
    while (pending.length) {
      signal.throwIfAborted()
      const path = pending.pop()!
      if (seen.has(path)) continue
      seen.add(path)
      const extension = extname(path)
      if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(extension)) continue
      const transpiler = new Bun.Transpiler({ loader: extension.endsWith("x") ? "tsx" : "ts" })
      for (const item of transpiler.scanImports(await Bun.file(path).text())) {
        if (isBuiltin(item.path) || item.path === "bun") continue
        const resolved = Bun.resolveSync(item.path, dirname(path))
        const local = relative(root, resolved)
        if (local === ".." || local.startsWith("../") || resolved.startsWith("/$bunfs/"))
          throw new Error("Extension imports must resolve inside its reviewed root or to runtime builtins")
        pending.push(resolved)
      }
    }
    signal.throwIfAborted()
    return {
      root,
      close,
      load: () =>
        import(pathToFileURL(join(root, review.config.entry)).href) as Promise<{ default?: unknown }>,
    }
  } catch (error) {
    await close()
    throw error
  }
}
