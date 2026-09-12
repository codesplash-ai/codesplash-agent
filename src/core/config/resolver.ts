import { realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { validatePlugins } from "../../engines/codesplash/plugins/config.ts"
import { pluginLayers } from "../../engines/codesplash/plugins/resolve.ts"
import { validateEnvironmentName } from "../../engines/codesplash/sandbox/env-policy.ts"
import { canonicalHost } from "../../engines/codesplash/sandbox/profile.ts"
import {
  type AgentConfig,
  applyConfigOverrides,
  dataDirectory,
  defaultConfig,
  isValidPermissionRule,
  validateConfig,
} from "../config.ts"
import { HOOK_EVENTS } from "../hooks.ts"
import { narrowOrchestration, type OrchestrationConfig } from "../orchestration/config.ts"
import { redactSensitiveText } from "../redaction.ts"
import { digest } from "../session/files.ts"
import { readTrustDecision } from "../trust.ts"
import type { ConfigResolutionOptions, ConfigScope, ConfigSource, ManagedConstraints } from "./contracts.ts"
import { assertManagedPolicy } from "./policy.ts"
import schema from "./schema.json"
import { checkConfigBounds, isTable, readConfigSource, stableValue } from "./source.ts"

type Schema = {
  type?: string | string[]
  enum?: unknown[]
  const?: unknown
  properties?: Record<string, Schema>
  additionalProperties?: boolean | Schema
  items?: Schema
}
function validateLayerShape(value: unknown, shape: Schema = schema as Schema, path = "config"): void {
  if (shape.const !== undefined && value !== shape.const)
    throw new Error(`${path}: unsupported schema version`)
  if (shape.enum && !shape.enum.includes(value)) throw new Error(`${path}: unsupported value`)
  if (
    shape.type &&
    !(Array.isArray(shape.type) ? shape.type : [shape.type]).some((type) =>
      type === "object"
        ? isTable(value)
        : type === "array"
          ? Array.isArray(value)
          : type === "integer"
            ? Number.isInteger(value)
            : typeof value === type,
    )
  )
    throw new Error(`${path}: expected ${shape.type}`)
  if (Array.isArray(value) && shape.items)
    value.forEach((entry, i) => {
      validateLayerShape(entry, shape.items, `${path}[${i}]`)
    })
  if (isTable(value))
    for (const [key, entry] of Object.entries(value)) {
      const child =
        shape.properties?.[key] ??
        (typeof shape.additionalProperties === "object" ? shape.additionalProperties : undefined)
      if (child) validateLayerShape(entry, child, `${path}.${key}`)
    }
}

export function unknownConfigFields(value: unknown, shape: Schema = schema as Schema, path = ""): string[] {
  if (Array.isArray(value))
    return shape.items ? value.flatMap((v, i) => unknownConfigFields(v, shape.items, `${path}[${i}]`)) : []
  if (!isTable(value)) return []
  return Object.entries(value).flatMap(([key, child]) => {
    const name = path ? `${path}.${key}` : key
    const next =
      shape.properties?.[key] ??
      (typeof shape.additionalProperties === "object" ? shape.additionalProperties : undefined)
    return next ? unknownConfigFields(child, next, name) : shape.additionalProperties === false ? [name] : []
  })
}

function merge(target: Record<string, unknown>, layer: Record<string, unknown>, path = ""): void {
  for (const [key, value] of Object.entries(layer)) {
    const name = path ? `${path}.${key}` : key
    if (
      /^hooks\.continuation\.(maxCount|maxDurationMs|maxTokens)$/.test(name) &&
      typeof value === "number" &&
      typeof target[key] === "number"
    ) {
      target[key] = Math.min(value, target[key] as number)
    } else if (
      (["permissions.deny", "permissions.ask"].includes(name) ||
        /^mcp\.servers\.[^.]+\.denyTools$/.test(name)) &&
      Array.isArray(value) &&
      Array.isArray(target[key])
    )
      target[key] = [...new Set([...(target[key] as unknown[]), ...value])]
    else if (
      /^mcp\.servers\.[^.]+\.(allowTools|readOnlyTools)$/.test(name) &&
      Array.isArray(value) &&
      Array.isArray(target[key])
    ) {
      target[key] = value.filter((entry) => (target[key] as unknown[]).includes(entry))
    } else if (isTable(value)) {
      const child = isTable(target[key]) ? target[key] : {}
      merge(child, value, name)
      target[key] = child
    } else target[key] = structuredClone(value)
  }
}

function ordinary(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(raw).filter(([key]) => !["profiles", "profile", "extends"].includes(key)),
  )
}

function managed(raw: Record<string, unknown>): ManagedConstraints {
  const result: ManagedConstraints = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === "required") {
      if (!isTable(value) || unknownConfigFields(value).length || "profiles" in value || "profile" in value)
        throw new Error("Invalid managed required settings")
      validateLayerShape(value)
      result.required = value
    } else if (key === "hooksManagedOnly") {
      if (typeof value !== "boolean") throw new Error("Invalid managed hooksManagedOnly")
      result.hooksManagedOnly = value
    } else if (
      [
        "sandboxModes",
        "permissionModes",
        "deny",
        "allowedHosts",
        "environment",
        "mcpServers",
        "extensionIds",
        "pluginIds",
        "marketplaceIds",
        "pluginPins",
        "mcpTools",
        "hookHandlers",
        "hookEvents",
      ].includes(key)
    ) {
      if (
        !Array.isArray(value) ||
        !value.every((v) => typeof v === "string" && v.length > 0) ||
        value.length > (key === "mcpTools" ? 5000 : 1024)
      )
        throw new Error(`Invalid managed ${key}`)
      if (
        key === "sandboxModes" &&
        (!value.length ||
          value.some((v) => !["read-only", "workspace-write", "danger-full-access"].includes(v)))
      )
        throw new Error("Invalid managed sandboxModes")
      if (
        key === "permissionModes" &&
        (!value.length || value.some((v) => !["plan", "default", "accept-edits", "bypass"].includes(v)))
      )
        throw new Error("Invalid managed permissionModes")
      if (key === "deny" && value.some((v) => !isValidPermissionRule(v)))
        throw new Error("Invalid managed deny rules")
      if (key === "environment") for (const name of value) validateEnvironmentName(name)
      if (
        ["pluginIds", "marketplaceIds"].includes(key) &&
        value.some((name) => !/^[a-z][a-z0-9_-]{0,31}$/.test(name))
      )
        throw new Error("Invalid managed plugin/marketplace id")
      if (key === "pluginPins" && value.some((name) => !/^[a-z][a-z0-9_-]{0,31}\/[a-f0-9]{64}$/.test(name)))
        throw new Error("Invalid managed plugin pin")
      if (key === "extensionIds" && value.some((name) => !/^[a-z][a-z0-9_-]{0,31}$/.test(name)))
        throw new Error("Invalid managed extension id")
      if (key === "mcpServers" && value.some((name) => !/^[a-z][a-z0-9_-]{0,31}$/.test(name)))
        throw new Error("Invalid managed MCP server id")
      if (key === "hookHandlers" && value.some((name) => !/^[a-z][a-z0-9_-]{0,31}$/.test(name)))
        throw new Error("Invalid managed hook handler id")
      if (
        key === "hookEvents" &&
        value.some((name) => !HOOK_EVENTS.includes(name as (typeof HOOK_EVENTS)[number]))
      )
        throw new Error("Invalid managed hook event")
      if (key === "mcpTools" && value.some((name) => !/^[a-z][a-z0-9_-]{0,31}\/.{1,256}$/.test(name)))
        throw new Error("Invalid managed MCP tool identity; use server/original-tool-name")
      Object.assign(result, { [key]: key === "allowedHosts" ? value.map(canonicalHost) : value })
    } else throw new Error(`Unknown managed setting: ${key}`)
  }
  return result
}

export async function resolveConfig(
  userPath: string,
  overrides: readonly string[] = [],
  options: ConfigResolutionOptions = {},
): Promise<AgentConfig> {
  if (overrides.length > 128) throw new Error("At most 128 config overrides are supported")
  const env = options.env ?? process.env
  const sources: ConfigSource[] = []
  const provenance: Record<string, string[]> = Object.create(null)
  const diagnostics: string[] = []
  const effective: Record<string, unknown> = {}
  const add = (
    scope: ConfigScope,
    raw: Record<string, unknown>,
    path?: string,
    fingerprint = digest(stableValue(raw)),
    id = scope as string,
  ) => {
    checkConfigBounds(raw)
    sources.push({ id, scope, path, fingerprint })
    const visit = (value: Record<string, unknown>, prefix = "") => {
      for (const [key, child] of Object.entries(value)) {
        const name = prefix ? `${prefix}.${key}` : key
        if (isTable(child)) visit(child, name)
        else {
          provenance[name] ??= []
          provenance[name].push(id)
        }
      }
    }
    visit(raw)
    merge(effective, raw)
  }
  const inspect = (raw: Record<string, unknown>, label: string) => {
    validateLayerShape(raw, schema as Schema, label)
    const unknown = unknownConfigFields(raw)
    if (unknown.length) {
      const message = `${label}: unknown settings: ${unknown.join(", ")}`
      if (options.strict) throw new Error(message)
      diagnostics.push(message)
    }
  }
  add("defaults", { ...defaultConfig, providers: {} })
  userPath = resolve(userPath)
  const user = readConfigSource(userPath)
  inspect(user.raw, userPath)
  add("user", ordinary(user.raw), userPath, user.fingerprint)
  const definitions: Record<
    string,
    { raw: Record<string, unknown>; layers: Array<{ raw: Record<string, unknown>; source: string }> }
  > = Object.create(null)
  const profiles = (raw: Record<string, unknown>, source: string) => {
    if (raw.profiles === undefined) return
    if (!isTable(raw.profiles) || Object.keys(raw.profiles).length > 32)
      throw new Error(`Invalid profiles at ${source}`)
    for (const [name, value] of Object.entries(raw.profiles)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) || !isTable(value))
        throw new Error(`Invalid profile at ${source}`)
      const combined = structuredClone(definitions[name]?.raw ?? {})
      merge(combined, value)
      definitions[name] = {
        raw: combined,
        layers: [...(definitions[name]?.layers ?? []), { raw: value, source }],
      }
    }
    if (Object.keys(definitions).length > 32) throw new Error("At most 32 profiles are supported")
  }
  profiles(user.raw, "user")
  let selection = user.raw.profile
  let cwd: string | undefined
  if (options.cwd) {
    cwd = realpathSync(options.cwd)
    const projectPath = join(cwd, ".codesplash", "config.toml")
    const trusted =
      options.workspaceTrusted ??
      (await readTrustDecision(cwd, options.dataDir ?? dataDirectory(env)))?.trusted === true
    if (!trusted)
      sources.push({
        id: "project",
        scope: "project",
        path: projectPath,
        fingerprint: "disabled",
        disabledReason: "Workspace is not trusted",
      })
    else {
      const project = readConfigSource(projectPath)
      inspect(project.raw, projectPath)
      add("project", ordinary(project.raw), projectPath, project.fingerprint)
      profiles(project.raw, "project")
      selection = project.raw.profile ?? selection
    }
  }
  selection = options.profile ?? env.CODESPLASH_PROFILE ?? selection
  if (
    selection !== undefined &&
    (typeof selection !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(selection))
  )
    throw new Error("Invalid selected profile")
  const chain = (name: string, seen: string[] = []): string[] => {
    if (seen.includes(name) || seen.length >= 16) throw new Error("Profile inheritance cycle or depth limit")
    const definition = definitions[name]
    if (!definition) throw new Error(`Unknown configuration profile: ${name}`)
    const parent = definition.raw.extends
    if (parent !== undefined && typeof parent !== "string")
      throw new Error(`Invalid extends in profile ${name}`)
    return [...(parent ? chain(parent, [...seen, name]) : []), name]
  }
  // Validate every definition, even an unselected cycle, without activating it.
  for (const name of Object.keys(definitions)) {
    const candidate = structuredClone(effective)
    for (const parent of chain(name)) {
      const definition = definitions[parent]
      if (definition) merge(candidate, ordinary(definition.raw))
    }
    try {
      validateConfig(candidate, `profile:${name}`)
    } catch (error) {
      throw new Error(redactSensitiveText(error instanceof Error ? error.message : "Invalid profile"))
    }
  }
  for (const name of typeof selection === "string" ? chain(selection) : []) {
    const definition = definitions[name]
    if (!definition) throw new Error("Profile disappeared during resolution")
    for (const layer of definition.layers)
      add("profile", ordinary(layer.raw), undefined, undefined, `profile:${layer.source}:${name}`)
  }
  const environmentOverrides: string[] = []
  let environment: Record<string, unknown> = {}
  if (env.CODESPLASH_CONFIG !== undefined) {
    if (Buffer.byteLength(env.CODESPLASH_CONFIG) > 64 * 1024)
      throw new Error("Environment configuration exceeds 64 KiB")
    let parsed: unknown
    try {
      parsed = env.CODESPLASH_CONFIG.trimStart().startsWith("{")
        ? JSON.parse(env.CODESPLASH_CONFIG)
        : Bun.TOML.parse(env.CODESPLASH_CONFIG)
    } catch {
      throw new Error("Invalid CODESPLASH_CONFIG; expected JSON or TOML")
    }
    if (!isTable(parsed)) throw new Error("CODESPLASH_CONFIG requires a table")
    checkConfigBounds(parsed)
    const allowed = new Set(["theme", "models.codesplash", "history.enabled", "permissions.mode"])
    const visit = (raw: Record<string, unknown>, prefix = "") => {
      for (const [key, value] of Object.entries(raw)) {
        const path = prefix ? `${prefix}.${key}` : key
        if (isTable(value) && ["models", "history", "permissions"].includes(path)) visit(value, path)
        else if (!allowed.has(path))
          throw new Error("CODESPLASH_CONFIG contains a setting outside its allowlist")
      }
    }
    visit(parsed)
    validateLayerShape(parsed, schema as Schema, "CODESPLASH_CONFIG")
    environment = parsed
  }
  for (const [variable, key] of Object.entries({
    CODESPLASH_THEME: "theme",
    CODESPLASH_MODEL: "models.codesplash",
    CODESPLASH_HISTORY: "history.enabled",
    CODESPLASH_PERMISSION_MODE: "permissions.mode",
  })) {
    const value = env[variable]
    if (value !== undefined)
      environmentOverrides.push(`${key}=${key === "history.enabled" ? value : JSON.stringify(value)}`)
  }
  add("environment", applyConfigOverrides(environment, environmentOverrides) as Record<string, unknown>)
  const cli = applyConfigOverrides({}, overrides) as Record<string, unknown>
  if (["profiles", "profile", "extends", "resolution", "managed"].some((key) => key in cli))
    throw new Error("Config overrides cannot change resolution controls; use --profile")
  inspect(cli, "CLI")
  add("cli", cli)
  const managedPath = join(dirname(userPath), "managed.toml")
  const policySource = readConfigSource(managedPath)
  const constraints = managed(policySource.raw)
  const requestedOrchestration = structuredClone(effective.orchestration) as
    | Partial<OrchestrationConfig>
    | undefined
  add("managed", constraints.required ?? {}, managedPath, policySource.fingerprint)
  if (requestedOrchestration !== undefined || constraints.required?.orchestration !== undefined)
    effective.orchestration = narrowOrchestration(
      requestedOrchestration,
      constraints.required?.orchestration as Partial<OrchestrationConfig> | undefined,
    )
  if (options.pluginSnapshot) effective.plugins = structuredClone(options.pluginSnapshot)
  if (isTable(constraints.required?.plugins) && isTable(effective.plugins))
    merge(effective.plugins, constraints.required.plugins)
  const plugins = effective.plugins === undefined ? undefined : validatePlugins(effective.plugins)
  const contributed = options.inspectPlugins
    ? { sources: [], resources: [] }
    : await pluginLayers(plugins, constraints)
  for (const { source, raw } of contributed.sources) {
    for (const [section, table] of Object.entries(raw)) {
      const entries = section === "hooks" ? "handlers" : section === "mcp" ? "servers" : "entries"
      const existing = effective[section] as Record<string, Record<string, unknown>> | undefined
      for (const id of Object.keys((table as Record<string, Record<string, unknown>>)[entries]!))
        if (existing?.[entries]?.[id])
          throw new Error(`Plugin component collides with ordinary configuration: ${id}`)
    }
    add("plugin", raw, source.path, source.fingerprint, source.id)
  }
  checkConfigBounds(effective)
  let config: AgentConfig
  try {
    config = validateConfig(effective, userPath)
  } catch (error) {
    throw new Error(redactSensitiveText(error instanceof Error ? error.message : "Invalid configuration"))
  }
  config.permissions.deny = [...new Set([...config.permissions.deny, ...(constraints.deny ?? [])])]
  if (constraints.deny) {
    provenance["permissions.deny"] ??= []
    if (!provenance["permissions.deny"].includes("managed")) provenance["permissions.deny"].push("managed")
  }
  if (constraints.allowedHosts || constraints.environment) {
    config.sandbox ??= {}
    for (const key of ["allowedHosts", "environment"] as const) {
      const allowed = constraints[key]
      if (allowed) {
        config.sandbox[key] = (config.sandbox[key] ?? []).filter((value) => allowed.includes(value))
        const name = `sandbox.${key}`
        provenance[name] ??= []
        if (!provenance[name].includes("managed")) provenance[name].push("managed")
      }
    }
  }
  config.pluginResources = contributed.resources
  config.resolution = {
    generation: digest(stableValue({ sources, effective: config, cwd, selection })),
    cwd,
    profile: selection as string | undefined,
    profiles: Object.keys(definitions).sort(),
    sources,
    provenance,
    diagnostics,
    constraints,
    request: {
      userPath,
      overrides: [...overrides],
      options: {
        ...options,
        pluginSnapshot: plugins,
        dataDir: options.dataDir ?? dataDirectory(env),
        env: Object.fromEntries(
          Object.entries(env).filter(([name]) =>
            [
              "CODESPLASH_PROFILE",
              "CODESPLASH_CONFIG",
              "CODESPLASH_THEME",
              "CODESPLASH_MODEL",
              "CODESPLASH_HISTORY",
              "CODESPLASH_PERMISSION_MODE",
            ].includes(name),
          ),
        ),
      },
    },
  }
  assertManagedPolicy(config, { ...config.codex, permissionMode: config.permissions.mode })
  return config
}

export async function resolveConfigForWorkspace(
  config: AgentConfig,
  cwd: string,
  workspaceTrusted?: boolean,
  refreshPlugins = false,
): Promise<AgentConfig> {
  const request = config.resolution?.request
  if (!request) return config
  return resolveConfig(request.userPath, request.overrides, {
    ...request.options,
    pluginSnapshot:
      refreshPlugins ||
      resolve(cwd) !== config.resolution?.cwd ||
      (workspaceTrusted === false &&
        config.resolution?.sources.some((source) => source.scope === "project" && !source.disabledReason))
        ? undefined
        : request.options.pluginSnapshot,
    cwd,
    workspaceTrusted,
  })
}
