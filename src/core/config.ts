import { chmod, mkdir, readFile, rename } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { NativeSandboxConfig } from "../engines/codesplash/sandbox/contracts.ts"
import { validateEnvironmentName } from "../engines/codesplash/sandbox/env-policy.ts"
import { redactSensitiveText } from "./redaction.ts"
import { stringifyToml, type TomlTable } from "./toml.ts"

export type ThemePreference = "system" | "dark" | "light"

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access"

export type ConfigSandboxMode = Exclude<SandboxMode, "danger-full-access">

export type ApprovalPolicy = "untrusted" | "on-request"

/** First-party permission layer mode. "bypass" is per-session only, never a persisted default. */
export type PermissionMode = "plan" | "default" | "accept-edits" | "bypass"

/** Modes persistable in config; "bypass" requires the --bypass-approvals flag per session. */
export type ConfigPermissionMode = Exclude<PermissionMode, "bypass">

/**
 * Permission rule grammar: `tool` or `tool(pattern)` — a lowercase tool name plus an optional
 * non-empty parenthesized pattern. Unknown tool NAMES are deliberately not a config error
 * (forward compatibility); the engine warns about them at session open instead.
 */
export const PERMISSION_RULE_PATTERN = /^[a-z][a-z0-9_-]*(\(.+\))?$/

export type PermissionsConfig = {
  mode: ConfigPermissionMode
  allow: string[]
  ask: string[]
  deny: string[]
}

/** Wire protocol a custom provider speaks; mirrors the engine's ProviderId union. */
export type CustomProviderProtocol = "anthropic" | "openai"

/** Catalog price estimates in USD per million tokens. */
export type CustomModelPricing = {
  inputPerMTok: number
  outputPerMTok: number
  cachedInputPerMTok?: number
}

export type CustomModelConfig = {
  id: string
  displayName: string
  contextWindow: number
  maxOutputTokens: number
  supportsReasoning: boolean
  isDefault: boolean
  pricing?: CustomModelPricing
}

/** One `[providers.<id>]` table, fully resolved (defaults applied). Keys never live here. */
export type CustomProviderConfig = {
  id: string
  protocol: CustomProviderProtocol
  baseUrl: string
  displayName: string
  keyEnvVar: string
  requiresKey: boolean
  models: CustomModelConfig[]
}

export type AgentConfig = {
  schemaVersion: 1
  theme: ThemePreference
  history: { enabled: boolean }
  codex: { sandbox: ConfigSandboxMode; approvalPolicy: ApprovalPolicy }
  permissions: PermissionsConfig
  codesplash: { fallbackModel?: string; autoCompact?: boolean; compactionStrategy?: "summary" | "prune" }
  providers: CustomProviderConfig[]
  sandbox?: NativeSandboxConfig
  guardian?: {
    enabled: boolean
    model?: string
    timeoutMs?: number
    maxReviews?: number
    maxTokens?: number
    maxCostUsd?: number
  }
}

export const defaultConfig: AgentConfig = {
  schemaVersion: 1,
  theme: "system",
  history: { enabled: true },
  codex: { sandbox: "workspace-write", approvalPolicy: "on-request" },
  permissions: { mode: "default", allow: [], ask: [], deny: [] },
  codesplash: {},
  providers: [],
}

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const RESERVED_PROVIDER_IDS = ["anthropic", "openai"]
/**
 * Credential-shaped field names refused inside [providers.*]: API keys belong in the
 * environment. Compared case-insensitively with `_`/`-` stripped, so the common aliases
 * (api_key, api-key, API_KEY, Token, ...) are refused too instead of sitting unused in
 * plaintext on disk.
 */
const CREDENTIAL_FIELD_KEYS = new Set([
  "key",
  "apikey",
  "token",
  "secret",
  "password",
  "authorization",
  "bearer",
])

/** Field names in `table` that look like credentials (see CREDENTIAL_FIELD_KEYS). */
function credentialFieldNames(table: Record<string, unknown>): string[] {
  return Object.keys(table).filter((name) =>
    CREDENTIAL_FIELD_KEYS.has(name.toLowerCase().replace(/[-_]/g, "")),
  )
}
const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384

export function configDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  if (env.CODESPLASH_AGENT_CONFIG_DIR) return env.CODESPLASH_AGENT_CONFIG_DIR
  if (platform === "darwin") return join(home, "Library", "Application Support", "codesplash-agent")
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "codesplash-agent")
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "codesplash-agent")
}

export function dataDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  if (env.CODESPLASH_AGENT_DATA_DIR) return env.CODESPLASH_AGENT_DATA_DIR
  if (platform === "darwin") return join(home, "Library", "Application Support", "codesplash-agent")
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "codesplash-agent")
  return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "codesplash-agent")
}

export function configFilePath(directory = configDirectory()): string {
  return join(directory, "config.toml")
}

/**
 * Loads and validates the config file. `overrides` are per-invocation `-c/--config` values in
 * `dotted.path=value` form, applied via applyConfigOverrides BEFORE validation — they are never
 * written back to disk. A missing file still honors the overrides (applied to an empty table).
 */
export async function loadConfig(
  path = configFilePath(),
  overrides: readonly string[] = [],
): Promise<AgentConfig> {
  let source: string
  try {
    source = await readFile(path, "utf8")
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      if (overrides.length === 0) return structuredClone(defaultConfig)
      return validateConfig(applyConfigOverrides({}, overrides), path)
    }
    throw new Error(`Could not read config at ${path}: ${errorMessage(error)}`, { cause: error })
  }

  let parsed: unknown
  try {
    parsed = Bun.TOML.parse(source)
  } catch (error) {
    throw new Error(`Could not parse config at ${path}: ${errorMessage(error)}`, { cause: error })
  }

  return validateConfig(applyConfigOverrides(parsed, overrides), path)
}

/**
 * Applies `dotted.path=value` overrides to a parsed (but not yet validated) TOML object. Values
 * parse as TOML scalars, falling back to the raw string. Malformed overrides throw with the
 * offending override named; the message passes through redactSensitiveText so a value that looks
 * like a credential is never echoed.
 */
export function applyConfigOverrides(parsed: unknown, overrides: readonly string[]): unknown {
  if (overrides.length === 0) return parsed
  const root: Record<string, unknown> = isRecord(parsed) ? structuredClone(parsed) : {}

  for (const override of overrides) {
    const separator = override.indexOf("=")
    if (separator === -1) {
      throw new Error(
        `Invalid config override "${redactSensitiveText(override)}": expected dotted.path=value`,
      )
    }
    const path = override.slice(0, separator).trim()
    const segments = path.split(".").map((segment) => segment.trim())
    if (path === "" || segments.some((segment) => segment === "")) {
      throw new Error(`Invalid config override "${redactSensitiveText(override)}": the key path is empty`)
    }
    setConfigPath(root, segments, parseOverrideValue(override.slice(separator + 1)))
  }

  return root
}

function parseOverrideValue(raw: string): unknown {
  try {
    const parsed = Bun.TOML.parse(`v = ${raw}`)
    if (isRecord(parsed) && "v" in parsed) return parsed.v
  } catch {
    // Not a TOML scalar; fall through to the raw string.
  }
  return raw
}

function setConfigPath(root: Record<string, unknown>, segments: string[], value: unknown): void {
  let cursor = root
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment]
    if (isRecord(next)) {
      cursor = next
    } else {
      const created: Record<string, unknown> = {}
      cursor[segment] = created
      cursor = created
    }
  }
  const leaf = segments[segments.length - 1]
  if (leaf !== undefined) cursor[leaf] = value
}

export function validateConfig(parsed: unknown, path: string): AgentConfig {
  if (!isRecord(parsed)) throw new Error(`Invalid config at ${path}: expected a TOML table`)

  const problems: string[] = []
  const config = structuredClone(defaultConfig)

  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 1) {
    problems.push(`schemaVersion: got ${JSON.stringify(parsed.schemaVersion)}, expected 1`)
  }

  if (parsed.theme !== undefined) {
    if (isThemePreference(parsed.theme)) config.theme = parsed.theme
    else problems.push(`theme: got ${JSON.stringify(parsed.theme)}, expected "system", "dark", or "light"`)
  }

  if (parsed.history !== undefined) {
    if (!isRecord(parsed.history)) {
      problems.push(`[history]: expected a table`)
    } else if (parsed.history.enabled !== undefined) {
      if (typeof parsed.history.enabled === "boolean") config.history.enabled = parsed.history.enabled
      else
        problems.push(
          `[history].enabled: got ${JSON.stringify(parsed.history.enabled)}, expected true or false`,
        )
    }
  }

  if (parsed.codex !== undefined) {
    if (!isRecord(parsed.codex)) {
      problems.push(`[codex]: expected a table`)
    } else {
      const sandbox = parsed.codex.sandbox
      if (sandbox !== undefined) {
        if (sandbox === "danger-full-access") {
          problems.push(
            `[codex].sandbox: "danger-full-access" cannot be a persisted default; full access requires the --full-access flag per session`,
          )
        } else if (isConfigSandboxMode(sandbox)) {
          config.codex.sandbox = sandbox
        } else {
          problems.push(
            `[codex].sandbox: got ${JSON.stringify(sandbox)}, expected "read-only" or "workspace-write"`,
          )
        }
      }
      const approvalPolicy = parsed.codex.approvalPolicy
      if (approvalPolicy !== undefined) {
        if (isApprovalPolicy(approvalPolicy)) config.codex.approvalPolicy = approvalPolicy
        else {
          problems.push(
            `[codex].approvalPolicy: got ${JSON.stringify(approvalPolicy)}, expected "untrusted" or "on-request"`,
          )
        }
      }
    }
  }

  if (parsed.permissions !== undefined) {
    validatePermissions(parsed.permissions, config.permissions, problems)
  }

  if (parsed.codesplash !== undefined) {
    if (!isRecord(parsed.codesplash)) {
      problems.push(`[codesplash]: expected a table`)
    } else if (parsed.codesplash.fallbackModel !== undefined) {
      // Which model the id names is validated at use time, not load time.
      if (typeof parsed.codesplash.fallbackModel === "string" && parsed.codesplash.fallbackModel !== "") {
        config.codesplash.fallbackModel = parsed.codesplash.fallbackModel
      } else {
        problems.push(
          `[codesplash].fallbackModel: got ${JSON.stringify(parsed.codesplash.fallbackModel)}, expected a model id string`,
        )
      }
    }
  }

  if (isRecord(parsed.codesplash)) {
    const { autoCompact, compactionStrategy } = parsed.codesplash
    if (autoCompact !== undefined) {
      if (typeof autoCompact === "boolean") config.codesplash.autoCompact = autoCompact
      else problems.push("[codesplash].autoCompact: expected true or false")
    }
    if (compactionStrategy !== undefined) {
      if (compactionStrategy === "summary" || compactionStrategy === "prune")
        config.codesplash.compactionStrategy = compactionStrategy
      else problems.push('[codesplash].compactionStrategy: expected "summary" or "prune"')
    }
  }

  if (parsed.providers !== undefined) {
    if (!isRecord(parsed.providers)) {
      problems.push(`[providers]: expected one [providers.<id>] table per custom provider`)
    } else {
      config.providers = validateProviders(parsed.providers, problems)
    }
  }

  if (parsed.sandbox !== undefined) {
    if (!isRecord(parsed.sandbox)) problems.push("[sandbox]: expected a table")
    else {
      config.sandbox = {}
      for (const [key, value] of Object.entries(parsed.sandbox)) {
        if (!["readRoots", "writeRoots", "allowedHosts", "environment"].includes(key)) {
          problems.push(`[sandbox].${key}: unknown setting`)
          continue
        }
        if (!Array.isArray(value) || value.some((s) => typeof s !== "string" || !s)) {
          problems.push(`[sandbox].${key}: expected an array of nonempty strings`)
          continue
        }
        if (key === "environment")
          for (const name of value as string[]) {
            try {
              validateEnvironmentName(name)
            } catch {
              problems.push("[sandbox].environment: unsafe environment name")
            }
          }
        config.sandbox[key as keyof NativeSandboxConfig] = value as string[]
      }
    }
  }
  if (parsed.guardian !== undefined) {
    if (!isRecord(parsed.guardian)) problems.push("[guardian]: expected a table")
    else {
      config.guardian = { enabled: false }
      for (const [key, value] of Object.entries(parsed.guardian)) {
        if (key === "enabled" && typeof value === "boolean") config.guardian.enabled = value
        else if (key === "model" && typeof value === "string" && value) config.guardian.model = value
        else if (
          ["timeoutMs", "maxReviews", "maxTokens", "maxCostUsd"].includes(key) &&
          typeof value === "number" &&
          Number.isFinite(value) &&
          value > 0 &&
          (key === "maxCostUsd" || Number.isInteger(value))
        ) {
          Object.assign(config.guardian, { [key]: value })
        } else problems.push(`[guardian].${key}: invalid setting`)
      }
      if (
        (config.guardian.timeoutMs ?? 10_000) > 60_000 ||
        (config.guardian.maxReviews ?? 3) > 10 ||
        (config.guardian.maxTokens ?? 256) > 1024 ||
        (config.guardian.maxCostUsd ?? 0.1) > 1
      )
        problems.push("[guardian]: limits exceed maximums (60s, 10 reviews, 1024 tokens, $1 per turn)")
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid config at ${path}:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`)
  }

  return config
}

/**
 * Validates the [permissions] table into `target`, aggregating problems in the existing style.
 * "bypass" is refused as a persisted default the same way [codex] refuses danger-full-access.
 */
function validatePermissions(value: unknown, target: PermissionsConfig, problems: string[]): void {
  if (!isRecord(value)) {
    problems.push(`[permissions]: expected a table`)
    return
  }

  if (value.mode !== undefined) {
    if (value.mode === "bypass") {
      problems.push(
        `[permissions].mode: "bypass" cannot be a persisted default; bypass requires the --bypass-approvals flag per session`,
      )
    } else if (isConfigPermissionMode(value.mode)) {
      target.mode = value.mode
    } else {
      problems.push(
        `[permissions].mode: got ${JSON.stringify(value.mode)}, expected "plan", "default", or "accept-edits"`,
      )
    }
  }

  for (const action of ["allow", "ask", "deny"] as const) {
    const raw = value[action]
    if (raw === undefined) continue
    if (!Array.isArray(raw)) {
      problems.push(`[permissions].${action}: got ${JSON.stringify(raw)}, expected an array of rule strings`)
      continue
    }
    const rules: string[] = []
    for (const [index, rule] of raw.entries()) {
      if (typeof rule !== "string") {
        problems.push(
          `[permissions].${action}[${index + 1}]: got ${JSON.stringify(rule)}, expected a rule string`,
        )
      } else if (!isValidPermissionRule(rule)) {
        problems.push(
          `[permissions].${action}[${index + 1}]: invalid rule ${JSON.stringify(rule)} — rules are "tool" or "tool(pattern)" (lowercase tool name, non-empty pattern)`,
        )
      } else {
        // Unknown tool names pass on purpose (forward compat); the engine warns at session open.
        rules.push(rule)
      }
    }
    target[action] = rules
  }
}

function validateProviders(providers: Record<string, unknown>, problems: string[]): CustomProviderConfig[] {
  const validated: CustomProviderConfig[] = []
  /** model id -> provider id that already defined it; duplicates across the config are errors. */
  const seenModelIds = new Map<string, string>()

  for (const [id, table] of Object.entries(providers)) {
    if (RESERVED_PROVIDER_IDS.includes(id)) {
      problems.push(
        `[providers.${id}]: "${id}" is a built-in provider; custom provider ids must not shadow it`,
      )
      continue
    }
    if (!PROVIDER_ID_PATTERN.test(id)) {
      problems.push(
        `[providers.${id}]: provider ids must match ${PROVIDER_ID_PATTERN} (lowercase letters, digits, hyphens)`,
      )
      continue
    }
    if (!isRecord(table)) {
      problems.push(`[providers.${id}]: expected a table`)
      continue
    }
    const provider = validateProvider(id, table, seenModelIds, problems)
    if (provider) validated.push(provider)
  }

  return validated
}

function validateProvider(
  id: string,
  table: Record<string, unknown>,
  seenModelIds: Map<string, string>,
  problems: string[],
): CustomProviderConfig | undefined {
  const before = problems.length
  const keyEnvVar = readOptionalString(table.keyEnvVar) ?? defaultKeyEnvVar(id)

  // Never store credentials in config.toml — refuse the field without echoing its value.
  for (const field of credentialFieldNames(table)) {
    problems.push(
      `[providers.${id}].${field}: API keys never live in config.toml; set the ${keyEnvVar} environment variable instead`,
    )
  }

  if (table.keyEnvVar !== undefined && readOptionalString(table.keyEnvVar) === undefined) {
    problems.push(`[providers.${id}].keyEnvVar: expected a non-empty environment variable name`)
  }

  let protocol: CustomProviderProtocol | undefined
  if (table.protocol === undefined) {
    problems.push(`[providers.${id}].protocol: required — "anthropic" or "openai"`)
  } else if (table.protocol === "anthropic" || table.protocol === "openai") {
    protocol = table.protocol
  } else {
    problems.push(
      `[providers.${id}].protocol: got ${JSON.stringify(table.protocol)}, expected "anthropic" or "openai"`,
    )
  }

  let baseUrl: string | undefined
  if (table.baseUrl === undefined) {
    problems.push(`[providers.${id}].baseUrl: required for custom providers`)
  } else {
    baseUrl = readOptionalString(table.baseUrl)
    if (baseUrl === undefined) {
      problems.push(`[providers.${id}].baseUrl: got ${JSON.stringify(table.baseUrl)}, expected a URL string`)
    }
  }

  const displayName = readOptionalString(table.displayName) ?? capitalize(id)
  if (table.displayName !== undefined && readOptionalString(table.displayName) === undefined) {
    problems.push(`[providers.${id}].displayName: expected a non-empty string`)
  }

  let requiresKey = true
  if (table.requiresKey !== undefined) {
    if (typeof table.requiresKey === "boolean") requiresKey = table.requiresKey
    else {
      problems.push(
        `[providers.${id}].requiresKey: got ${JSON.stringify(table.requiresKey)}, expected true or false`,
      )
    }
  }

  const models = validateModels(id, table.models, keyEnvVar, seenModelIds, problems)

  if (problems.length > before || protocol === undefined || baseUrl === undefined || !models) {
    return undefined
  }
  return { id, protocol, baseUrl, displayName, keyEnvVar, requiresKey, models }
}

function validateModels(
  providerId: string,
  value: unknown,
  keyEnvVar: string,
  seenModelIds: Map<string, string>,
  problems: string[],
): CustomModelConfig[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    problems.push(
      `[providers.${providerId}].models: at least one [[providers.${providerId}.models]] table is required`,
    )
    return undefined
  }

  const before = problems.length
  const models: CustomModelConfig[] = []
  let sawDefault = false

  for (const [index, entry] of value.entries()) {
    const label = `[[providers.${providerId}.models]] #${index + 1}`
    if (!isRecord(entry)) {
      problems.push(`${label}: expected a table`)
      continue
    }

    for (const field of credentialFieldNames(entry)) {
      problems.push(
        `${label}.${field}: API keys never live in config.toml; set the ${keyEnvVar} environment variable instead`,
      )
    }

    const id = readOptionalString(entry.id)
    if (id === undefined) {
      problems.push(`${label}.id: required — the model id sent to the provider`)
      continue
    }
    const previousOwner = seenModelIds.get(id)
    if (previousOwner !== undefined) {
      problems.push(
        `${label}.id: duplicate model id "${id}" (already defined by [providers.${previousOwner}])`,
      )
      continue
    }
    seenModelIds.set(id, providerId)

    const model: CustomModelConfig = {
      id,
      displayName: readOptionalString(entry.displayName) ?? id,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      supportsReasoning: false,
      isDefault: false,
    }
    if (entry.displayName !== undefined && readOptionalString(entry.displayName) === undefined) {
      problems.push(`${label}.displayName: expected a non-empty string`)
    }

    for (const field of ["contextWindow", "maxOutputTokens"] as const) {
      const raw = entry[field]
      if (raw === undefined) continue
      if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) model[field] = raw
      else problems.push(`${label}.${field}: got ${JSON.stringify(raw)}, expected a positive integer`)
    }

    for (const [field, target] of [
      ["supportsReasoning", "supportsReasoning"],
      ["default", "isDefault"],
    ] as const) {
      const raw = entry[field]
      if (raw === undefined) continue
      if (typeof raw === "boolean") model[target] = raw
      else problems.push(`${label}.${field}: got ${JSON.stringify(raw)}, expected true or false`)
    }
    if (model.isDefault) {
      if (sawDefault) {
        problems.push(`${label}.default: more than one model sets default = true`)
        model.isDefault = false
      }
      sawDefault = true
    }

    if (entry.pricing !== undefined) {
      const pricing = validatePricing(label, entry.pricing, problems)
      if (pricing) model.pricing = pricing
    }

    models.push(model)
  }

  if (problems.length > before) return undefined
  if (!sawDefault && models[0]) models[0].isDefault = true
  return models
}

function validatePricing(label: string, value: unknown, problems: string[]): CustomModelPricing | undefined {
  if (!isRecord(value)) {
    problems.push(`${label}.pricing: expected a table`)
    return undefined
  }
  const before = problems.length
  const read = (field: string, required: boolean): number | undefined => {
    const raw = value[field]
    if (raw === undefined) {
      if (required) problems.push(`${label}.pricing.${field}: required — USD per million tokens`)
      return undefined
    }
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw
    problems.push(`${label}.pricing.${field}: got ${JSON.stringify(raw)}, expected a non-negative number`)
    return undefined
  }
  const inputPerMTok = read("inputPerMTok", true)
  const outputPerMTok = read("outputPerMTok", true)
  const cachedInputPerMTok = read("cachedInputPerMTok", false)
  if (problems.length > before || inputPerMTok === undefined || outputPerMTok === undefined) return undefined
  const pricing: CustomModelPricing = { inputPerMTok, outputPerMTok }
  if (cachedInputPerMTok !== undefined) pricing.cachedInputPerMTok = cachedInputPerMTok
  return pricing
}

/** Default key env var for a custom provider id: upper-cased, non-alphanumerics to "_". */
export function defaultKeyEnvVar(providerId: string): string {
  return `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export async function saveConfig(config: AgentConfig, path = configFilePath()): Promise<void> {
  const directory = dirname(path)

  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${process.pid}.tmp`
  const table: TomlTable = {
    schemaVersion: config.schemaVersion,
    theme: config.theme,
    history: { enabled: config.history.enabled },
    codex: { sandbox: config.codex.sandbox, approvalPolicy: config.codex.approvalPolicy },
  }
  const permissions = permissionsTable(config.permissions)
  if (permissions) table.permissions = permissions
  if (config.sandbox) table.sandbox = { ...config.sandbox }
  if (config.guardian) table.guardian = { ...config.guardian }
  if (Object.keys(config.codesplash).length > 0) {
    table.codesplash = Object.fromEntries(
      Object.entries(config.codesplash).filter(([, value]) => value !== undefined),
    )
  }
  if (config.providers.length > 0) {
    table.providers = Object.fromEntries(
      config.providers.map((provider) => [provider.id, providerTable(provider)]),
    )
  }
  const source = stringifyToml(table)
  await Bun.write(temporaryPath, source)
  await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, path)
}

/**
 * [permissions] serializes only the fields that differ from the defaults, and the table only
 * when at least one does — matching the [codesplash]/[providers] style.
 */
function permissionsTable(permissions: PermissionsConfig): TomlTable | undefined {
  const table: TomlTable = {}
  if (permissions.mode !== "default") table.mode = permissions.mode
  if (permissions.allow.length > 0) table.allow = [...permissions.allow]
  if (permissions.ask.length > 0) table.ask = [...permissions.ask]
  if (permissions.deny.length > 0) table.deny = [...permissions.deny]
  return Object.keys(table).length > 0 ? table : undefined
}

function providerTable(provider: CustomProviderConfig): TomlTable {
  return {
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    displayName: provider.displayName,
    keyEnvVar: provider.keyEnvVar,
    requiresKey: provider.requiresKey,
    models: provider.models.map((model) => {
      const entry: TomlTable = {
        id: model.id,
        displayName: model.displayName,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        supportsReasoning: model.supportsReasoning,
        default: model.isDefault,
      }
      if (model.pricing) {
        const pricing: TomlTable = {
          inputPerMTok: model.pricing.inputPerMTok,
          outputPerMTok: model.pricing.outputPerMTok,
        }
        if (model.pricing.cachedInputPerMTok !== undefined) {
          pricing.cachedInputPerMTok = model.pricing.cachedInputPerMTok
        }
        entry.pricing = pricing
      }
      return entry
    }),
  }
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "dark" || value === "light"
}

export function isSandboxMode(value: unknown): value is SandboxMode {
  return value === "danger-full-access" || isConfigSandboxMode(value)
}

function isConfigSandboxMode(value: unknown): value is ConfigSandboxMode {
  return value === "read-only" || value === "workspace-write"
}

function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  return value === "untrusted" || value === "on-request"
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "bypass" || isConfigPermissionMode(value)
}

export function isConfigPermissionMode(value: unknown): value is ConfigPermissionMode {
  return value === "plan" || value === "default" || value === "accept-edits"
}

/** True when `value` parses as a permission rule string (see PERMISSION_RULE_PATTERN). */
export function isValidPermissionRule(value: string): boolean {
  return PERMISSION_RULE_PATTERN.test(value)
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
