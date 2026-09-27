import { join } from "node:path"
import { assertManagedPolicy } from "../core/config/policy.ts"
import { dataDirectory, loadConfig } from "../core/config.ts"
import type { NativeSandboxConfig } from "../engines/codesplash/sandbox/contracts.ts"
import { createProfile } from "../engines/codesplash/sandbox/profile.ts"
import { NativeSandbox } from "../engines/codesplash/sandbox/runtime.ts"
import { UsageError } from "./usage-error.ts"

export function parseSandboxArguments(args: string[]) {
  const boundary = args.indexOf("--")
  if (boundary < 0 || boundary === args.length - 1)
    throw new UsageError(
      "Usage: codesplash sandbox [--read-only] [--read-root PATH] [--write-root PATH] [--allow-host HOST:PORT] [--no-history] -- CMD [ARGS...]",
    )
  let readOnly = false,
    history = true
  const config: NativeSandboxConfig = { readRoots: [], writeRoots: [], allowedHosts: [] }
  for (let i = 0; i < boundary; i++) {
    const arg = args[i]
    if (arg === "--read-only") readOnly = true
    else if (arg === "--no-history") history = false
    else if (
      arg === "--read-root" ||
      arg === "--write-root" ||
      arg === "--allow-host" ||
      arg === "--deny-read" ||
      arg === "--deny-write"
    ) {
      const value = args[++i]
      if (!value || i >= boundary) throw new UsageError(`${arg} requires a value`)
      const key =
        arg === "--deny-read"
          ? "denyRead"
          : arg === "--deny-write"
            ? "denyWrite"
            : arg === "--read-root"
              ? "readRoots"
              : arg === "--write-root"
                ? "writeRoots"
                : "allowedHosts"
      const values = config[key] ?? []
      values.push(value)
      config[key] = values
    } else throw new UsageError(`Unknown sandbox option ${arg}`)
  }
  if (readOnly && config.writeRoots?.length) throw new UsageError("--read-only conflicts with --write-root")
  return {
    mode: readOnly ? ("read-only" as const) : ("workspace-write" as const),
    config,
    history,
    argv: args.slice(boundary + 1),
  }
}
export async function runSandboxCommand(args: string[]): Promise<number> {
  const parsed = parseSandboxArguments(args)
  const config = await loadConfig(undefined, [], { cwd: process.cwd() })
  assertManagedPolicy(config, {
    sandbox: parsed.mode,
    approvalPolicy: config.codex.approvalPolicy,
    permissionMode: config.permissions.mode,
  })
  const merged = {
    ...config.sandbox,
    ...parsed.config,
    denyRead: [...(config.sandbox?.denyRead ?? []), ...(parsed.config.denyRead ?? [])],
    denyWrite: [...(config.sandbox?.denyWrite ?? []), ...(parsed.config.denyWrite ?? [])],
  }
  const ceiling = config.resolution?.constraints.allowedHosts
  if (ceiling && merged.allowedHosts?.some((host) => !ceiling.includes(host)))
    throw new Error("Requested network host prohibited by managed configuration")
  const profile = createProfile(process.cwd(), parsed.mode, merged)
  const runtime = new NativeSandbox(
    profile,
    parsed.history ? join(dataDirectory(), "sandbox-events.jsonl") : undefined,
    undefined,
    config.resolution?.constraints,
  )
  const abort = new AbortController()
  const stop = () => abort.abort()
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  try {
    const result = await runtime.execute(parsed.argv, abort.signal)
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    return result.exitCode
  } finally {
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
    await runtime.close()
  }
}
