import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"

export type ExecutableReview = {
  argv: string[]
  files: Array<{ requested: string; path: string; sha256: string }>
}
/** Bounded descriptor hashing shared by reviewed external runtimes; this never launches code. */
export async function reviewExecutable(
  command: string,
  args: string[],
  trustFiles: string[],
  cwd: string,
  signal?: AbortSignal,
  label = "Executable",
): Promise<ExecutableReview> {
  const files: ExecutableReview["files"] = []
  let total = 0
  const seen = new Set<string>()
  const add = async (requested: string, tree = false): Promise<string> => {
    signal?.throwIfAborted()
    const original = resolve(cwd, requested)
    const info = await lstat(original)
    if (tree && info.isSymbolicLink())
      throw new Error(`${label} trust directories cannot contain symbolic links`)
    const path = await realpath(original)
    if (seen.has(path)) return path
    seen.add(path)
    if (seen.size > 4096) throw new Error(`${label} trust file count exceeds 4096`)
    if (info.isDirectory()) {
      const names = await readdir(path)
      if (names.length + seen.size > 4096) throw new Error(`${label} trust file count exceeds 4096`)
      for (const name of names.sort()) await add(join(path, name), true)
      return path
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = await file.stat()
      if (!before.isFile() || before.size + total > 512 * 1024 * 1024)
        throw new Error(`${label} trust inputs must be regular files totaling at most 512 MiB`)
      total += before.size
      const hash = createHash("sha256")
      const buffer = Buffer.alloc(128 * 1024)
      let count = 0
      while (true) {
        signal?.throwIfAborted()
        const { bytesRead } = await file.read(buffer)
        if (!bytesRead) break
        count += bytesRead
        if (count > before.size) throw new Error(`${label} executable changed during review`)
        hash.update(buffer.subarray(0, bytesRead))
      }
      const after = await file.stat()
      if (count !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
        throw new Error(`${label} executable changed during review`)
      files.push({ requested: original, path, sha256: hash.digest("hex") })
    } finally {
      await file.close()
    }
    return path
  }
  let argv: string[]
  {
    const executable =
      isAbsolute(command) || command.includes("/")
        ? resolve(cwd, command)
        : Bun.which(command, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin", cwd })
    if (!executable)
      throw new Error(`${label} executable was not found on the sandbox PATH; configure an absolute command`)
    const executablePath = await add(executable)
    argv = [executablePath, ...args]
    // Common script/file arguments are always covered. Additional dependency trees are explicit.
    for (const arg of args) {
      if (!arg || arg.startsWith("-")) continue
      const candidate = resolve(cwd, arg)
      const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
        if (["ENOENT", "ENOTDIR", "ENAMETOOLONG"].includes(error.code ?? "")) return undefined
        throw error
      })
      if (info?.isFile() || info?.isSymbolicLink()) await add(candidate)
    }
    for (const path of trustFiles) await add(path)
  }
  return { argv, files }
}

/** Immutable plugin versions may coexist while one session stages a replacement. */
export function executableTrustKey(
  cwd: string,
  id: string,
  sources: Array<{ id: string; fingerprint: string }>,
): string {
  const plugins = sources
    .filter((source) => source.id.startsWith("plugin:"))
    .map(({ id, fingerprint }) => ({ id, fingerprint }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return createHash("sha256")
    .update(`${cwd}\0${id}${plugins.length ? `\0${JSON.stringify(plugins)}` : ""}`)
    .digest("hex")
}
