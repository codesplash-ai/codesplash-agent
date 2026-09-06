import { lstat, readdir, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import type { SandboxProfile } from "./contracts.ts"
import { contains, physicalPath } from "./profile.ts"

/**
 * Path-based OS sandboxes cannot distinguish an existing inode's other names.
 * Refuse shared inodes before admission, including shell/CLI execution. Symlinks
 * are not followed: the kernel checks their resolved target against the profile.
 * Workspace contents must not be changed by an unconfined hostile host process;
 * such a process can also replace this same-user harness itself.
 */
export async function assertPrivateInodes(
  profile: SandboxProfile,
  signal: AbortSignal,
): Promise<Array<{ path: string; directory: boolean }>> {
  const roots = [...new Set([...profile.readRoots, ...profile.writeRoots])]
  const pending = roots.filter((root) => !roots.some((other) => other !== root && contains(other, root)))
  let visited = 0
  const shared = new Map<string, { links: number; paths: string[] }>()
  const sensitive: Array<{ path: string; directory: boolean }> = []
  while (pending.length) {
    signal.throwIfAborted()
    const path = pending.pop()
    if (!path) continue
    if (++visited > 250_000)
      throw new Error("Sandbox filesystem admission exceeded 250000 entries; use a smaller workspace")
    if (profile.deniedReadPaths.some((root) => contains(root, path))) continue
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!info) continue
    if (/^(?:\.env(?:\..*)?|id_rsa.*|id_ed25519.*)$|\.(?:pem|p12)$/.test(basename(path))) {
      const target = physicalPath(path)
      const resolved = info.isSymbolicLink() ? await stat(target).catch(() => undefined) : info
      if (resolved) sensitive.push({ path: target, directory: resolved.isDirectory() })
      // An alias outside a masked directory is still rejected through nlink accounting.
      if (resolved?.isDirectory()) continue
    }
    if (info.isFile() && info.nlink !== 1) {
      const key = `${info.dev}:${info.ino}`
      const entry = shared.get(key) ?? { links: info.nlink, paths: [] }
      if (entry.links !== info.nlink) throw new Error("Hardlinks changed during sandbox admission")
      entry.paths.push(path)
      shared.set(key, entry)
    }
    if (info.isDirectory()) {
      // Detect directory substitution during traversal instead of following a
      // newly introduced symlink into an unrelated host directory.
      if (physicalPath(path) !== path)
        throw new Error(
          "Sandbox directory changed during filesystem admission; retry after workspace changes finish",
        )
      for (const name of await readdir(path)) pending.push(join(path, name))
      const after = await lstat(path)
      if (!after.isDirectory() || after.dev !== info.dev || after.ino !== info.ino) {
        throw new Error(
          "Sandbox directory changed during filesystem admission; retry after workspace changes finish",
        )
      }
    }
  }
  for (const entry of shared.values()) {
    // Internal package-manager hardlinks are safe only when EVERY inode name is
    // accounted for and has the same privileges. Outside/protected/read-only
    // aliases make the entire invocation inadmissible.
    const writable = (path: string) => profile.writeRoots.some((root) => contains(root, path))
    const protectedAlias = entry.paths.some(
      (path) =>
        profile.protectedPaths.some((root) => contains(root, path)) ||
        path
          .split("/")
          .some(
            (part) =>
              part === ".git" ||
              part === ".codesplash" ||
              part.startsWith(".env") ||
              /^id_(rsa|ed25519)/.test(part) ||
              /\.(pem|p12)$/.test(part),
          ),
    )
    const first = entry.paths[0]
    if (
      !first ||
      entry.paths.length !== entry.links ||
      protectedAlias ||
      entry.paths.some((path) => writable(path) !== writable(first))
    ) {
      throw new Error(
        `Sandbox refuses multiply-linked file: ${first}. Its aliases include paths outside the same access boundary; replace it with a private copy before running tools.`,
      )
    }
  }
  return sensitive
}
