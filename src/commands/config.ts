import { resolve } from "node:path"
import managedSchema from "../core/config/managed-schema.json"
import { unknownConfigFields } from "../core/config/resolver.ts"
import schema from "../core/config/schema.json"
import { editConfigSource, isTable } from "../core/config/source.ts"
import { configDirectory, configFilePath, loadConfig, validateConfig } from "../core/config.ts"
import { redactSensitiveText } from "../core/redaction.ts"
import { UsageError } from "./usage-error.ts"

export async function runConfigCommand(
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv
    output?: (text: string) => void
    configOverrides?: readonly string[]
    profile?: string
    strictConfig?: boolean
  } = {},
): Promise<number> {
  const env = options.env ?? process.env
  const output = options.output ?? ((text: string) => process.stdout.write(text))
  let cwd = process.cwd()
  const command: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--path") {
      if (!args[i + 1]) throw new UsageError("--path requires a directory")
      cwd = resolve(args[++i]!)
    } else if (args[i] !== "--json") command.push(args[i]!)
  }
  const [action = "explain", sub, name, ...extra] = command
  const path = configFilePath(configDirectory(env))
  if (action === "schema" && (!sub || sub === "managed") && !name) {
    output(`${JSON.stringify(sub === "managed" ? managedSchema : schema, null, 2)}\n`)
    return 0
  }
  if (action === "profile" && sub === "select" && name && !extra.length) {
    // Validate the proposed profile and source set before persisting the selection.
    const reviewed = await loadConfig(path, [], { cwd, env, profile: name, strict: true })
    editConfigSource(
      path,
      (raw) => {
        if (!isTable(raw.profiles) || !isTable(raw.profiles[name]))
          throw new Error("Only a user-defined profile can be selected persistently")
        raw.profile = name
        validateConfig(raw, path)
        if (unknownConfigFields(raw).length)
          throw new Error("Fix unknown settings before selecting a profile")
      },
      reviewed.resolution?.sources.find((source) => source.scope === "user")?.fingerprint,
    )
    output(`Selected user profile ${name}.\n`)
    return 0
  }
  if (
    extra.length ||
    (action === "profile" ? sub !== "list" || name : sub) ||
    !["explain", "validate", "profile"].includes(action)
  )
    throw new UsageError(
      "Usage: codesplash config explain|validate|schema|profile list|profile select NAME [--path PATH] [--profile NAME] [--strict-config]",
    )
  const config = await loadConfig(path, options.configOverrides, {
    cwd,
    env,
    profile: options.profile,
    strict: options.strictConfig,
  })
  const { resolution, ...values } = config
  if (!resolution) throw new Error("Missing configuration resolution")
  const { request: _request, ...details } = resolution
  // Never expose invocation environment or arbitrary winning values without redaction.
  const result =
    action === "validate"
      ? { valid: true, generation: details.generation, diagnostics: details.diagnostics }
      : action === "profile"
        ? {
            selected: details.profile,
            profiles: details.profiles,
            sources: details.sources.filter((source) => source.scope === "profile"),
          }
        : { ...details, config: values }
  output(`${JSON.stringify(redactConfigValue(result, env), null, 2)}\n`)

  return 0
}

/** Redact before JSON serialization so replacement cannot corrupt JSON syntax. */
export function redactConfigValue(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactConfigValue(entry, env))
  if (isTable(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactConfigValue(entry, env)]),
    )
  if (typeof value !== "string") return value
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      if (url.username || url.password) {
        url.username = "REDACTED"
        url.password = ""
      }
      for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "REDACTED")
      value = url.toString()
    } catch {
      return "[invalid URL]"
    }
  }
  return redactSensitiveText(value as string, env)
}
