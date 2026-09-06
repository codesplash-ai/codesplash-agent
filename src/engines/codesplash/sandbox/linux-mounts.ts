import { existsSync, statSync } from "node:fs"
import { basename } from "node:path"
import { contains } from "./profile.ts"

/** Harden the pinned backend's generated bwrap argv; never parse workload shell text. */
export function hardenLinuxMounts(
  argv: string[],
  policy: { allowWrite?: string[]; allowRead?: string[]; denyWrite?: string[] },
  deniedFile?: string,
  sensitive: Array<{ path: string; directory: boolean }> = [],
): string[] {
  const writeRoots = policy.allowWrite ?? []
  if (basename(argv[0] ?? "") !== "bwrap") throw new Error("Unexpected Linux sandbox wrapper")
  const arity: Record<string, number> = {
    "--die-with-parent": 0,
    "--new-session": 0,
    "--unshare-net": 0,
    "--unshare-pid": 0,
    "--unshare-user": 0,
    "--cap-drop": 1,
    "--setenv": 2,
    "--unsetenv": 1,
    "--bind": 2,
    "--ro-bind": 2,
    "--tmpfs": 1,
    "--dev": 1,
    "--proc": 1,
  }
  const mounts: { args: string[]; destination: string }[] = []
  const output = [argv[0] ?? ""]
  const roots = writeRoots.filter(
    (root) => !writeRoots.some((other) => other !== root && contains(other, root)),
  )
  let end = 1
  while (argv[end] !== "--") {
    const flag = argv[end] ?? ""
    const count = arity[flag]
    if (count === undefined || end + count >= argv.length) throw new Error("Unexpected bwrap option")
    const args = argv.slice(end, end + count + 1)
    const destination = argv[end + count] ?? ""
    // Upstream can emit a /dev/null mountpoint for an absent child after its
    // protected parent is already read-only. That mount cannot be created and
    // is redundant: the literal parent denial prevents creating the child.
    if (
      flag === "--ro-bind" &&
      args[1] === "/dev/null" &&
      !existsSync(destination) &&
      policy.denyWrite?.some(
        (path) =>
          !path.includes("*") &&
          path !== destination &&
          contains(path, destination) &&
          existsSync(path) &&
          statSync(path).isDirectory(),
      )
    ) {
      end += count + 1
      continue
    }
    output.push(...args)
    if (["--bind", "--ro-bind", "--tmpfs"].includes(flag)) {
      mounts.push({ args, destination })
      // Upstream restores write mounts before a read-only ancestor after tmpfs.
      // Restore each affected subtree immediately, before later protection mounts
      // need to create mountpoints in it. Replay every earlier nested mask/deny.
      // Never repair a protected ancestor or a mount that isn't a configured read.
      const readRestore =
        flag === "--ro-bind" &&
        args[1] === destination &&
        policy.allowRead?.includes(destination) &&
        !destination.split("/").includes(".git") &&
        !policy.denyWrite?.some((path) => !path.includes("*") && contains(path, destination))
      if (readRestore)
        for (const root of roots) {
          if (
            root === destination ||
            !contains(destination, root) ||
            !mounts.some((mount) => mount.args[0] === "--bind" && mount.destination === root)
          )
            continue
          for (const mount of mounts) if (contains(root, mount.destination)) output.push(...mount.args)
        }
    }
    end += count + 1
  }
  const repairs: string[] = []
  if (!deniedFile) throw new Error("Missing Linux read-denial sentinel")
  // Linux upstream does not expand denyRead globs. Bind every admitted existing
  // sensitive file explicitly, after all ancestor mounts and write repairs.
  for (const item of sensitive) {
    if (item.directory) repairs.push("--tmpfs", item.path, "--remount-ro", item.path)
    else repairs.push("--ro-bind", deniedFile, item.path)
  }
  // Read-denied directories are empty tmpfs mounts, not the host directories.
  // Make those masks read-only too; writable bind submounts retain their policy.
  for (const path of new Set(
    mounts.filter((mount) => mount.args[0] === "--tmpfs").map((mount) => mount.destination),
  )) {
    // If the backend later rebound this exact path, it is no longer a mask.
    const last = mounts.findLast((mount) => mount.destination === path)
    if (last?.args[0] === "--tmpfs") repairs.push("--remount-ro", path)
  }
  return [...output, ...repairs, ...argv.slice(end)]
}
