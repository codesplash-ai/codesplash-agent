import { constants } from "node:fs"
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { contains } from "../sandbox/profile.ts"
import { skillScaffold } from "./syntax.ts"

/** User-authorized local configuration writes only. Never registered as a model tool. */
export async function writeResources(
  root: string,
  files: Array<{ path: string; text: string }>,
): Promise<void> {
  const canonical = await realpath(root)
  const seen = new Set<string>()
  // Check every target before the first write; open(wx) also checks races at each leaf.
  for (const file of files) {
    const path = resolve(canonical, file.path)
    if (!contains(canonical, path) || path === canonical || seen.has(path))
      throw new Error("Invalid or duplicate resource destination")
    seen.add(path)
    let current = canonical
    for (const part of relative(canonical, path).split("/")) {
      current = join(current, part)
      const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
        return undefined
      })
      if (info?.isSymbolicLink()) throw new Error(`Destination uses a symlink: ${current}`)
      if (current === path && info) throw new Error(`Refusing to overwrite ${path}`)
      if (current !== path && info && !info.isDirectory()) throw new Error(`Not a directory: ${current}`)
    }
  }
  const created: Array<{ path: string; ino: number; dev: number }> = []
  try {
    for (const file of files) {
      const path = resolve(canonical, file.path)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      if ((await realpath(dirname(path))) !== dirname(path))
        throw new Error("Destination directory changed or uses symlinks")
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      const identity = await handle.stat()
      created.push({ path, ino: identity.ino, dev: identity.dev })
      try {
        await handle.writeFile(file.text)
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
  } catch (error) {
    for (const file of created.reverse()) {
      const current = await lstat(file.path).catch(() => undefined)
      if (current?.ino === file.ino && current.dev === file.dev) await unlink(file.path)
    }
    throw error
  }
}

export async function createSkill(root: string, name: string, write = false): Promise<string> {
  const text = skillScaffold(name),
    path = `.codesplash/skills/${name}/SKILL.md`
  if (write) await writeResources(root, [{ path, text }])
  return `${write ? "Created" : "Preview"}: ${resolve(root, path)}\n\n${text}${write ? "" : "\nUse --write to create this file. Existing files are never overwritten.\n"}`
}
