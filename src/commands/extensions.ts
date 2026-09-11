import { join, resolve } from "node:path"
import { editConfigSource, isTable, readConfigSource } from "../core/config/source.ts"
import { configDirectory, configFilePath, dataDirectory, loadConfig } from "../core/config.ts"
import { EXTENSION_ID, validateExtensions } from "../engines/codesplash/extensions/config.ts"
import { extensionTrusted, reviewExtension, trustExtension } from "../engines/codesplash/extensions/trust.ts"
import { redactConfigValue } from "./config.ts"
import { UsageError } from "./usage-error.ts"

const USAGE =
  "Usage: codesplash extensions list|show ID|enable ID|disable ID|trust ID --fingerprint HASH [--scope user|project] [--path DIR] [--profile NAME] [--strict-config] [-c KEY=VALUE]\nConfigure a dedicated root and relative entry under [extensions.entries.ID]. Enable, inspect, then trust the resulting fingerprint. Code executes with harness-process privileges. Recovery: --no-extensions.\n"
export async function runExtensionsCommand(
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
    const arg = args[i]!
    if (arg === "--json") continue
    if (arg === "--strict-config") {
      strict = true
      continue
    }
    if (["--scope", "--path", "--profile", "--fingerprint", "-c", "--config"].includes(arg)) {
      const value = args[++i]
      if (!value) throw new UsageError(`${arg} requires a value`)
      if (["-c", "--config"].includes(arg)) overrides.push(value)
      else {
        if (arg in flags) throw new UsageError(`Duplicate ${arg}`)
        flags[arg] = value
      }
    } else if (arg.startsWith("-")) throw new UsageError(`Unknown extension option ${arg}`)
    else positional.push(arg)
  }
  const [action = "list", id, ...extra] = positional,
    scope = flags["--scope"] ?? "user",
    cwd = resolve(flags["--path"] ?? options.cwd ?? process.cwd())
  if (
    extra.length ||
    !["user", "project"].includes(scope) ||
    !["list", "show", "enable", "disable", "trust"].includes(action) ||
    (action === "list" ? !!id : !id || !EXTENSION_ID.test(id)) ||
    (action === "trust" ? !flags["--fingerprint"] : !!flags["--fingerprint"])
  )
    throw new UsageError(USAGE)
  const emit = (value: unknown) => output(`${JSON.stringify(redactConfigValue(value, env), null, 2)}\n`)
  const userPath = configFilePath(configDirectory(env))
  if (["enable", "disable"].includes(action) && id) {
    if (flags["--profile"] || overrides.length || strict)
      throw new UsageError("Extension edits target the raw source; omit profiles and overrides")
    const path = scope === "user" ? userPath : join(cwd, ".codesplash", "config.toml")
    editConfigSource(
      path,
      (raw) => {
        if (
          !isTable(raw.extensions) ||
          !isTable(raw.extensions.entries) ||
          !isTable(raw.extensions.entries[id])
        )
          throw new Error("Extension is absent from the selected source")
        raw.extensions.entries[id].enabled = action === "enable"
        validateExtensions(raw.extensions)
      },
      readConfigSource(path).fingerprint,
    )
    emit({
      action,
      id,
      path,
      message:
        "Inspect and trust the resulting fingerprint before activation. Extensions execute trusted code with harness privileges.",
    })
    return 0
  }
  const config = await loadConfig(userPath, overrides, { cwd, env, profile: flags["--profile"], strict })
  if (action === "list")
    emit({
      disabled: config.extensions?.disabled ?? false,
      entries: config.extensions?.entries ?? {},
      diagnostics: config.resolution?.diagnostics ?? [],
    })
  else {
    const review = await reviewExtension(config, id!, cwd)
    if (action === "trust") trustExtension(dataDirectory(env), review, flags["--fingerprint"]!)
    emit({
      ...review,
      trusted: extensionTrusted(dataDirectory(env), review),
      warning:
        "In-process code has full harness privileges. Dependencies are included in review. Inspection does not import code. Recovery: --no-extensions.",
    })
  }
  return 0
}
