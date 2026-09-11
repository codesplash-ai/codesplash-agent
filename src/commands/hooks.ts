import { join, resolve } from "node:path"
import { editConfigSource, isTable, readConfigSource } from "../core/config/source.ts"
import { configDirectory, configFilePath, dataDirectory, loadConfig } from "../core/config.ts"
import { SessionRepository } from "../core/session/repository.ts"
import { SessionStore, sessionsRootDirectory } from "../core/sessions.ts"
import { HOOK_ID, validateHookConfig } from "../engines/codesplash/hooks/config.ts"
import { HookReceipts } from "../engines/codesplash/hooks/receipts.ts"
import { hookTrusted, reviewHook, trustHook } from "../engines/codesplash/hooks/trust.ts"
import { redactConfigValue } from "./config.ts"
import { UsageError } from "./usage-error.ts"

const USAGE =
  "Usage: codesplash hooks list|show ID|enable ID|disable ID|trust ID --fingerprint HASH [--scope user|project] [--path DIR] [--profile NAME] [--strict-config] [-c KEY=VALUE]\nRecovery: hooks receipts --session SESSION | acknowledge RECEIPT_KEY --session SESSION\nHandlers are configured in TOML and inactive by default. Enable, inspect, then trust the resulting fingerprint. Acknowledgment consumes uncertain execution; it does not retry it.\n"
export async function runHooksCommand(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; output?: (text: string) => void } = {},
): Promise<number> {
  const env = options.env ?? process.env,
    output = options.output ?? ((text) => process.stdout.write(text))
  if (args.length === 1 && ["-h", "--help"].includes(args[0] ?? "")) {
    output(USAGE)
    return 0
  }
  const positional: string[] = [],
    overrides: string[] = [],
    flags: Record<string, string> = {}
  let strict = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ""
    if (arg === "--json") continue
    if (arg === "--strict-config") {
      strict = true
      continue
    }
    if (["--scope", "--path", "--profile", "--fingerprint", "--session", "-c", "--config"].includes(arg)) {
      const value = args[++i]
      if (!value) throw new UsageError(`${arg} requires a value`)
      if (arg === "-c" || arg === "--config") overrides.push(value)
      else {
        if (arg in flags) throw new UsageError(`Duplicate ${arg}`)
        flags[arg] = value
      }
    } else if (arg.startsWith("-")) throw new UsageError(`Unknown hook option ${arg}`)
    else positional.push(arg)
  }
  const [action = "list", id, ...extra] = positional
  const scope = flags["--scope"] ?? "user",
    cwd = resolve(flags["--path"] ?? options.cwd ?? process.cwd())
  if (
    extra.length ||
    !["user", "project"].includes(scope) ||
    !["list", "show", "enable", "disable", "trust", "receipts", "acknowledge"].includes(action)
  )
    throw new UsageError(USAGE)
  const emit = (value: unknown) => output(`${JSON.stringify(redactConfigValue(value, env), null, 2)}\n`)
  if (["receipts", "acknowledge"].includes(action)) {
    if (
      !flags["--session"] ||
      Object.keys(flags).some((key) => key !== "--session") ||
      overrides.length ||
      strict ||
      (action === "receipts" ? !!id : !id || !/^[a-f0-9]{64}$/.test(id))
    )
      throw new UsageError(USAGE)
    const root = sessionsRootDirectory(dataDirectory(env)),
      repository = new SessionRepository(root)
    const meta = await repository.resolve(flags["--session"])
    if (meta.engine !== "codesplash") throw new Error("Hook receipts belong to native CodeSplash sessions")
    const handle = await new SessionStore(root).open(meta.projectId, meta.localSessionId)
    handle.acquire()
    try {
      const receipts = new HookReceipts(handle.state)
      if (action === "acknowledge" && id) receipts.acknowledge(id)
      emit({ session: meta.localSessionId, receipts: receipts.list() })
    } finally {
      handle.release()
    }
    return 0
  }
  if (
    flags["--session"] ||
    (action === "list" ? !!id : !id || !HOOK_ID.test(id)) ||
    (action === "trust" ? !flags["--fingerprint"] : !!flags["--fingerprint"])
  )
    throw new UsageError(USAGE)
  const userPath = configFilePath(configDirectory(env))
  if (["enable", "disable"].includes(action) && id) {
    if (flags["--profile"] || overrides.length || strict)
      throw new UsageError("Hook edits target the raw user/project source; omit profiles and overrides")
    const path = scope === "user" ? userPath : join(cwd, ".codesplash", "config.toml")
    editConfigSource(
      path,
      (raw) => {
        if (!isTable(raw.hooks) || !isTable(raw.hooks.handlers) || !isTable(raw.hooks.handlers[id]))
          throw new Error("Hook is absent from the selected raw source")
        raw.hooks.handlers[id].enabled = action === "enable"
        validateHookConfig(raw.hooks)
      },
      readConfigSource(path).fingerprint,
    )
    emit({
      action,
      id,
      scope,
      path,
      message:
        action === "enable"
          ? "Inspect and trust the resulting fingerprint before execution."
          : "Handler disabled in configuration.",
    })
    return 0
  }
  const config = await loadConfig(userPath, overrides, { cwd, env, profile: flags["--profile"], strict })
  if (action === "list") {
    emit({
      handlers: Object.entries(config.hooks?.handlers ?? {}).map(([id, handler]) => ({
        id,
        kind: handler.kind,
        enabled: handler.enabled,
        events: handler.events,
        share: handler.share,
        source: config.resolution?.provenance[`hooks.handlers.${id}.kind`] ?? [],
      })),
      diagnostics: config.resolution?.diagnostics ?? [],
    })
    return 0
  }
  const review = await reviewHook(config, id ?? "", cwd)
  if (action === "trust") trustHook(dataDirectory(env), review, flags["--fingerprint"] ?? "")
  emit({
    ...review,
    trusted: hookTrusted(dataDirectory(env), review),
    permitted:
      (!config.resolution?.constraints.hookHandlers ||
        config.resolution.constraints.hookHandlers.includes(review.id)) &&
      (!config.resolution?.constraints.hooksManagedOnly || review.managed),
    execution:
      review.config.kind === "http"
        ? "Unknown remote effects; refused in plan/read-only mode. Only declared fields are shared."
        : `Fixed OS sandbox; ${review.config.writeWorkspace ? "workspace writes requested, still clamped by mode" : "read-only filesystem"}; no temporary tool grants.`,
    message: "Offline inspection; no handler was executed.",
  })
  return 0
}
