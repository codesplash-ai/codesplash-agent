/**
 * Model catalog and provider registry for the CodeSplash engine. The registry composes the
 * built-in adapters with custom [providers.*] entries from the harness config; the thin static
 * exports below cover callers that only need the built-in catalog.
 */
import type { AgentConfig, CustomProviderConfig } from "../../core/index.ts"
import { resolveApiKey } from "./auth.ts"
import type { ModelInfo, ProviderId, ProviderRuntime, ReasoningEffort } from "./contracts.ts"
import { anthropicModels, createAnthropicProvider } from "./providers/anthropic.ts"
import { createOpenAiProvider, openaiModels } from "./providers/openai.ts"

export const modelCatalog: ModelInfo[] = [...anthropicModels, ...openaiModels]

export const PROVIDER_KEY_VARIABLES: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
}

export const PROVIDER_DISPLAY_NAMES: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
}

const PROVIDER_ORDER: readonly ProviderId[] = ["anthropic", "openai"]

/** Providers whose API key environment variable is set (never inspects key values). */
export function availableProviders(env: NodeJS.ProcessEnv = process.env): ProviderId[] {
  return PROVIDER_ORDER.filter((id) => Boolean(env[PROVIDER_KEY_VARIABLES[id]]))
}

/** Session default provider: anthropic when its key is set, else openai. */
export function defaultProvider(env: NodeJS.ProcessEnv = process.env): ProviderId {
  return env[PROVIDER_KEY_VARIABLES.anthropic] ? "anthropic" : "openai"
}

export function catalogModels(providers: readonly ProviderId[]): ModelInfo[] {
  return modelCatalog.filter((model) => (providers as readonly string[]).includes(model.provider))
}

export function findModel(id: string): ModelInfo | undefined {
  return modelCatalog.find((model) => model.id === id)
}

export function defaultModelFor(provider: ProviderId): ModelInfo {
  const model = modelCatalog.find((entry) => entry.provider === provider && entry.isDefault)
  if (!model) throw new Error(`No default model for provider ${provider}`)
  return model
}

export type ModelSelection = {
  model: ModelInfo
  effort?: ReasoningEffort
}

/** Parses a model selector against the built-in catalog: `<id>` or `<id>:<low|medium|high>`. */
export function parseModelSelector(selector: string): ModelSelection {
  return parseSelectorWith(selector, findModel)
}

export function formatModelSelector(model: ModelInfo, effort?: ReasoningEffort): string {
  return effort ? `${model.id}:${effort}` : model.id
}

/* --------------------------------- provider registry --------------------------------- */

export type ProviderRegistry = {
  /** Available providers only, built-ins first, then customs in config order. */
  providers: ProviderRuntime[]
  /** Models across the available providers. */
  models: ModelInfo[]
  /** Session default model: anthropic > openai > first custom provider. */
  defaultModel(): ModelInfo
  find(id: string): ModelInfo | undefined
  runtimeFor(model: ModelInfo): ProviderRuntime
  /** Parses `<id>` or `<id>:<low|medium|high>` against the registry's models. */
  parseSelector(selector: string): ModelSelection
}

/**
 * Builds the registry of available providers. Built-ins are available when their API key
 * resolves (env var or credential store); a custom provider is available when it requires no
 * key or its key env var is set. Key values are read only by the adapters, never surfaced here.
 */
export function buildProviderRegistry(
  config: AgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): ProviderRegistry {
  const providers: ProviderRuntime[] = []

  for (const id of PROVIDER_ORDER) {
    if (!resolveApiKey(id, env)) continue
    providers.push({
      id,
      protocol: id,
      displayName: PROVIDER_DISPLAY_NAMES[id],
      keyEnvVar: PROVIDER_KEY_VARIABLES[id],
      requiresKey: true,
      client: id === "anthropic" ? createAnthropicProvider() : createOpenAiProvider(),
    })
  }

  for (const custom of config.providers) {
    if (!customProviderAvailable(custom, env)) continue
    providers.push(customRuntime(custom))
  }

  const models = providers.flatMap((runtime) => runtime.client.models)
  const runtimesById = new Map(providers.map((runtime) => [runtime.id, runtime]))
  const find = (id: string): ModelInfo | undefined => models.find((model) => model.id === id)

  return {
    providers,
    models,
    defaultModel(): ModelInfo {
      const preferred = runtimesById.get("anthropic") ?? runtimesById.get("openai") ?? providers[0]
      if (!preferred) {
        throw new Error(
          "No providers available — set ANTHROPIC_API_KEY or OPENAI_API_KEY, or configure [providers.*] in config.toml",
        )
      }
      const model = preferred.client.models.find((entry) => entry.isDefault) ?? preferred.client.models[0]
      if (!model) throw new Error(`Provider "${preferred.id}" has no models`)
      return model
    },
    find,
    runtimeFor(model: ModelInfo): ProviderRuntime {
      const runtime = runtimesById.get(model.provider)
      if (!runtime)
        throw new Error(`No provider runtime for model "${model.id}" (provider "${model.provider}")`)
      return runtime
    },
    parseSelector(selector: string): ModelSelection {
      return parseSelectorWith(selector, find)
    },
  }
}

/** Available when the provider requires no key or its key env var is set (values never read). */
export function customProviderAvailable(
  custom: CustomProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !custom.requiresKey || Boolean(env[custom.keyEnvVar])
}

function customRuntime(custom: CustomProviderConfig): ProviderRuntime {
  const models: ModelInfo[] = custom.models.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    provider: custom.id,
    protocol: custom.protocol,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    isDefault: model.isDefault,
    supportsReasoning: model.supportsReasoning,
    ...(model.pricing ? { pricing: { ...model.pricing } } : {}),
  }))
  const factory = custom.protocol === "anthropic" ? createAnthropicProvider : createOpenAiProvider
  return {
    id: custom.id,
    protocol: custom.protocol,
    displayName: custom.displayName,
    keyEnvVar: custom.keyEnvVar,
    requiresKey: custom.requiresKey,
    baseUrl: custom.baseUrl,
    client: factory({ baseUrl: custom.baseUrl, keyEnvVar: custom.keyEnvVar, models }),
  }
}

function parseSelectorWith(selector: string, find: (id: string) => ModelInfo | undefined): ModelSelection {
  const trimmed = selector.trim()
  // A model id may itself contain ":" (e.g. "qwen3:8b"); an exact id match wins over splitting.
  const whole = find(trimmed)
  if (whole) return { model: whole }
  const parts = trimmed.split(":")
  if (parts.length > 2) {
    throw new Error(
      `Invalid model selector "${selector}"; use "<model-id>" or "<model-id>:<low|medium|high>"`,
    )
  }
  const [id, effort] = parts
  if (!id) throw new Error(`Invalid model selector "${selector}"; the model id is empty`)
  const model = find(id)
  if (!model) throw new Error(`Unknown model "${id}"`)
  if (effort === undefined) return { model }
  if (!isReasoningEffort(effort)) {
    throw new Error(`Invalid reasoning effort "${effort}"; use low, medium, or high`)
  }
  return { model, effort }
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return value === "low" || value === "medium" || value === "high"
}
