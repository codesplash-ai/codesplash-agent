import { resolve } from "node:path"
import { dataDirectory, loadConfig } from "../core/config.ts"
import { GitProjection, projectionPaths } from "../core/orchestration/projection.ts"
import { readTrustDecision } from "../core/trust.ts"
import { createPermissionRuntime } from "../engines/codesplash/permissions.ts"
import { UsageError } from "./usage-error.ts"
export async function runProjectionCommand(args: string[]): Promise<number> {
  const apply = args.includes("--apply"),
    trust = args.includes("--trust"),
    p = args.filter((a) => !["--apply", "--trust"].includes(a)),
    [action, destination, source, ...paths] = p
  if (!action || action === "--help") {
    process.stdout.write(
      "codesplash projection create DEST LOCAL_REPO DIR... --apply --trust | expand DEST DIR... --apply --trust | status DEST\n",
    )
    return 0
  }
  if (!destination || !["create", "expand", "status"].includes(action) || (action === "status" && source))
    throw new UsageError("Use projection --help")
  const target = resolve(destination),
    store = new GitProjection(target)
  if (action === "status") {
    process.stdout.write(`${JSON.stringify(store.status(), null, 2)}\n`)
    return 0
  }
  const selected = projectionPaths(action === "create" ? paths : [source!, ...paths])
  if (!apply) {
    process.stdout.write(
      `Preview: ${action} projection at ${target}, directories ${JSON.stringify(selected)}. Add --apply --trust after review.\n`,
    )
    return 0
  }
  const cwd = action === "create" ? resolve(source!) : target,
    data = dataDirectory(),
    trusted = trust || (await readTrustDecision(cwd, data))?.trusted === true
  if (!trusted) throw new Error("Projection requires explicit workspace trust")
  const config = await loadConfig(undefined, [], { cwd, workspaceTrusted: trusted })
  if (config.codex.sandbox === "read-only" || config.permissions.mode === "plan" || !config.history.enabled)
    throw new Error("Projection persistence is denied by configuration")
  const permissions = await createPermissionRuntime({
    cwd,
    workspaceTrusted: trusted,
    mode: config.permissions.mode,
    configRules: config.permissions,
    constraints: config.resolution?.constraints,
  })
  for (const [name, path, readonly] of [
    ["read_file", cwd, true],
    ["write_file", target, false],
  ] as const)
    if (
      ["ask", "deny"].includes(permissions.decide(name, { paths: [path] }, readonly).kind) ||
      permissions.isReadDenied(cwd, "read_file")
    )
      throw new Error("Projection denied by path policy")
  // Whole-repository object copying cannot satisfy a partial read ceiling; fail closed if any explicit read rules exist.
  if (
    config.permissions.deny.length ||
    config.permissions.ask.length ||
    config.resolution?.constraints?.deny?.length
  )
    throw new Error("Repository projection requires unrestricted repository read authority")
  const result = action === "create" ? await store.create(cwd, selected) : await store.expand(selected)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return 0
}
