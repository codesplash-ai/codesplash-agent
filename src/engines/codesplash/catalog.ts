/**
 * Static model catalog for the CodeSplash engine, composed from the provider adapters. The
 * session default provider is anthropic when ANTHROPIC_API_KEY is set, else openai.
 */
import type { ModelInfo, ProviderId, ReasoningEffort } from "./contracts.ts"
import { anthropicModels } from "./providers/anthropic.ts"
import { openaiModels } from "./providers/openai.ts"

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
  return modelCatalog.filter((model) => providers.includes(model.provider))
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

/** Parses a model selector: `<model-id>` or `<model-id>:<low|medium|high>`. */
export function parseModelSelector(selector: string): ModelSelection {
  const parts = selector.trim().split(":")
  if (parts.length > 2) {
    throw new Error(
      `Invalid model selector "${selector}"; use "<model-id>" or "<model-id>:<low|medium|high>"`,
    )
  }
  const [id, effort] = parts
  if (!id) throw new Error(`Invalid model selector "${selector}"; the model id is empty`)
  const model = findModel(id)
  if (!model) throw new Error(`Unknown model "${id}"`)
  if (effort === undefined) return { model }
  if (!isReasoningEffort(effort)) {
    throw new Error(`Invalid reasoning effort "${effort}"; use low, medium, or high`)
  }
  return { model, effort }
}

export function formatModelSelector(model: ModelInfo, effort?: ReasoningEffort): string {
  return effort ? `${model.id}:${effort}` : model.id
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return value === "low" || value === "medium" || value === "high"
}
