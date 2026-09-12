import { dataDirectory, loadConfig } from "../core/config.ts"
import { WorktreeStore } from "../core/orchestration/worktrees.ts"
import { readTrustDecision } from "../core/trust.ts"
import { controlWorktree, worktreeInput } from "../engines/codesplash/orchestration/worktrees.ts"
import { createPermissionRuntime } from "../engines/codesplash/permissions.ts"
import { UsageError } from "./usage-error.ts"

export async function runWorktreeCommand(
  args: string[],
  options: { cwd?: string; dataDir?: string; configPath?: string; output?: (text: string) => void } = {},
) {
  const usage =
    "codesplash worktree list | create [BASE] --apply --trust | preview ID | apply ID --fingerprint HASH --apply --trust | remove ID --apply --trust | gc --apply --trust | recover ID | rollback ID --apply --trust"
  const output = options.output ?? ((text) => process.stdout.write(text))
  if (args.length === 1 && ["-h", "--help"].includes(args[0]!)) {
    output(`${usage}\n`)
    return 0
  }
  const cwd = options.cwd ?? process.cwd(),
    data = options.dataDir ?? dataDirectory()
  const positional: string[] = []
  let apply = false,
    trust = false,
    fingerprint: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--apply") apply = true
    else if (arg === "--trust") trust = true
    else if (arg === "--fingerprint") fingerprint = args[++i]
    else if (arg.startsWith("--")) throw new UsageError(usage)
    else positional.push(arg)
  }
  const [action = "list", value, ...extra] = positional
  if (extra.length || (["list", "gc"].includes(action) && value)) throw new UsageError(usage)
  const request = worktreeInput({
    action,
    ...(action === "create" ? (value ? { base: value } : {}) : value ? { id: value } : {}),
    ...(fingerprint ? { fingerprint } : {}),
  })
  const mutable = !["list", "preview", "recover"].includes(action)
  if (mutable && !apply) {
    output(`Preview: ${JSON.stringify(request)}. Add --apply after review.\n`)
    return 0
  }
  const trusted = trust || (await readTrustDecision(cwd, data))?.trusted === true
  if (!trusted && mutable) throw new Error("Worktree changes require workspace trust (--trust)")
  const config = await loadConfig(options.configPath, [], { cwd, workspaceTrusted: trusted, dataDir: data })
  if (
    mutable &&
    (config.permissions.mode === "plan" ||
      config.codex.sandbox === "read-only" ||
      config.history.enabled === false)
  )
    throw new Error("Worktree persistence/mutation is denied by configuration")
  const permissions = await createPermissionRuntime({
    cwd,
    workspaceTrusted: trusted,
    mode: config.permissions.mode,
    configRules: config.permissions,
    constraints: config.resolution?.constraints,
  })
  if (permissions.decide("worktree", undefined, !mutable).kind === "deny")
    throw new Error("Worktree operation denied by configuration")
  const store = await WorktreeStore.open(cwd, data, {
    readable: (path) =>
      !permissions.isReadDenied(path, "read_file") &&
      !["ask", "deny"].includes(permissions.decide("read_file", { paths: [path] }, true).kind),
    writable: (path) =>
      !["ask", "deny"].includes(permissions.decide("write_file", { paths: [path] }, false).kind),
  })
  output(`${JSON.stringify(await controlWorktree(store, request), null, 2)}\n`)
  return 0
}
