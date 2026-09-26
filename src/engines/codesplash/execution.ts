import Ajv from "ajv"
import type { SessionUsageSnapshot } from "../../core/engine.ts"
import type { ProviderClient, ProviderUsage } from "./contracts.ts"
import { type ExecutionEnvironment, validateEnvironments } from "./tools/environments.ts"
import type { ToolRegistry } from "./tools/registry.ts"
export const toolsets: Record<string, readonly string[]> = {
  concise: ["read_file", "write_file", "edit_file", "bash", "glob", "grep"],
  plan: [
    "read_file",
    "glob",
    "grep",
    "web_fetch",
    "web_search",
    "ask_user",
    "enter_plan_mode",
    "exit_plan_mode",
  ],
  "read-only": ["read_file", "glob", "grep", "read_anchors", "lsp", "clock"],
  anchors: ["read_anchors", "edit_anchors", "read_file", "glob", "grep"],
}
export const advancedFeatures: Record<string, readonly string[]> = {
  generation: ["generate_media"],
  environments: ["environment_exec"],
  plugins: ["plugin_suggestions"],
  browser: ["browser"],
  notebook: ["notebook_edit"],
  anchors: ["read_anchors", "edit_anchors"],
  clock: ["clock"],
  code: ["code_mode"],
}
export type ExecutionLimits = {
  allowedTools?: string[]
  excludedTools?: string[]
  maxBudgetUsd?: number
  environments?: ExecutionEnvironment[]
  browserOrigins?: string[]
  toolset?: string
  features?: string[]
}
export function validateLimits(limits: ExecutionLimits | undefined) {
  if (!limits) return
  if (limits.environments) validateEnvironments(limits.environments)
  if (
    limits.browserOrigins &&
    (!Array.isArray(limits.browserOrigins) ||
      limits.browserOrigins.length > 32 ||
      limits.browserOrigins.some((origin) => {
        try {
          const url = new URL(origin)
          return url.origin !== origin || !["http:", "https:"].includes(url.protocol)
        } catch {
          return true
        }
      }))
  )
    throw new Error("Browser origins must be exact HTTP(S) origins")
  if (limits.toolset && !Object.hasOwn(toolsets, limits.toolset)) throw new Error("Unknown toolset preset")
  if (
    limits.features &&
    (!Array.isArray(limits.features) ||
      limits.features.length > 32 ||
      limits.features.some((name) => !Object.hasOwn(advancedFeatures, name)))
  )
    throw new Error("Unknown advanced feature")
  for (const names of [limits.allowedTools, limits.excludedTools])
    if (
      names !== undefined &&
      (!Array.isArray(names) ||
        names.length > 256 ||
        names.some((n) => typeof n !== "string" || !/^[\w./:-]{1,256}$/.test(n)))
    )
      throw new Error("Tool selectors must be bounded literal tool names")
  if (
    limits.maxBudgetUsd !== undefined &&
    (!Number.isFinite(limits.maxBudgetUsd) || limits.maxBudgetUsd <= 0)
  )
    throw new Error("Dollar budget must be positive and finite")
}
export function toolSelected(name: string, limits?: ExecutionLimits) {
  return (
    (!limits?.toolset || toolsets[limits.toolset]?.includes(name)) &&
    !limits?.excludedTools?.includes(name) &&
    (!limits?.allowedTools || limits.allowedTools.includes(name))
  )
}
export function selectedRegistry(registry: ToolRegistry, limits?: ExecutionLimits): ToolRegistry {
  if (!limits?.allowedTools && !limits?.excludedTools && !limits?.toolset) return registry
  // Hidden context readers are fixed host operations; explicit exclusions still apply.
  const allowed = (name: string) =>
    !limits.excludedTools?.includes(name) && (registry.get(name)?.hidden || toolSelected(name, limits))
  return {
    get generation() {
      return registry.generation
    },
    specs: () => registry.specs().filter((s) => allowed(s.name)),
    get: (name, generation) => (allowed(name) ? registry.get(name, generation) : undefined),
    source: (name) => (allowed(name) ? registry.source(name) : undefined),
    ...(registry.resolve
      ? {
          resolve(call: Parameters<NonNullable<ToolRegistry["resolve"]>>[0]) {
            const result = registry.resolve!(call)
            if (!allowed(result.call.name)) throw new Error("Tool excluded by execution limits")
            return result
          },
        }
      : {}),
  }
}
export type DollarState = { used: number; uncertain: boolean }
export class DollarBudget {
  used: number
  reserved = 0
  uncertain: boolean
  constructor(
    readonly limit: number,
    usage: SessionUsageSnapshot = {},
    readonly changed?: (state: DollarState) => void,
    prior?: DollarState,
  ) {
    if (!Number.isFinite(limit) || limit <= 0) throw new Error("Invalid dollar budget")
    this.used = Math.max(usage.estimatedCostUsd ?? 0, prior?.used ?? 0)
    this.uncertain = !!(
      usage.hasUnpricedUsage ||
      prior?.uncertain ||
      (usage.estimatedCostUsd === undefined &&
        (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.embeddingInputTokens ?? 0) > 0)
    )
  }
  save() {
    this.changed?.({ used: this.used + this.reserved, uncertain: this.uncertain || this.reserved > 0 })
  }
  wrap(provider: ProviderClient): ProviderClient {
    const budget = this
    return {
      id: provider.id,
      models: provider.models,
      async *stream(request, signal) {
        const prices = request.model.pricing
        if (
          budget.uncertain ||
          !prices ||
          [prices.inputPerMTok, prices.outputPerMTok, prices.cachedInputPerMTok ?? 0].some(
            (n) => !Number.isFinite(n) || n < 0,
          )
        )
          throw new Error("Dollar budget cannot admit unpriced or uncertain usage")
        const input =
          Buffer.byteLength(JSON.stringify([request.system, request.messages, request.tools])) + 4096
        const inputCost = (input * Math.max(prices.inputPerMTok, prices.cachedInputPerMTok ?? 0)) / 1000000
        const remaining = budget.limit - budget.used - budget.reserved - inputCost
        const output = Math.min(
          request.model.maxOutputTokens,
          prices.outputPerMTok
            ? Math.floor((remaining * 1000000) / prices.outputPerMTok)
            : request.model.maxOutputTokens,
        )
        if (remaining <= 0 || output < 1)
          throw new Error("Dollar budget cannot admit another provider request")
        const reservation = inputCost + (output * prices.outputPerMTok) / 1000000
        budget.reserved += reservation
        try {
          budget.save()
        } catch (e) {
          budget.reserved -= reservation
          budget.uncertain = true
          throw e
        }
        let usage: ProviderUsage | undefined
        try {
          for await (const event of provider.stream(
            { ...request, model: { ...request.model, maxOutputTokens: output } },
            signal,
          )) {
            if (event.type === "usage") {
              if (Object.values(event.usage).some((n) => !Number.isSafeInteger(n) || n < 0))
                throw new Error("Invalid provider usage for dollar budget")
              usage = event.usage
            }
            yield event
          }
        } finally {
          budget.reserved -= reservation
          if (usage?.inputTokens === undefined || usage.outputTokens === undefined) {
            budget.used += reservation
            budget.uncertain = true
          } else
            budget.used +=
              (usage.inputTokens * prices.inputPerMTok +
                (usage.cachedInputTokens ?? 0) * (prices.cachedInputPerMTok ?? prices.inputPerMTok / 10) +
                usage.outputTokens * prices.outputPerMTok) /
              1000000
          budget.save()
        }
        if (budget.uncertain || budget.used > budget.limit)
          throw new Error("Dollar budget exhausted or usage uncertain; continuation stopped")
      },
    }
  }
}
export function outputValidator(schema: unknown) {
  if (schema === undefined) return undefined
  if (Buffer.byteLength(JSON.stringify(schema)) > 65536) throw new Error("Output schema exceeds 64 KiB")
  const validate = new Ajv({ strict: false, allErrors: false }).compile(schema as object)
  return (text: string) => {
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("Structured output exceeds 1 MiB")
    const value: unknown = JSON.parse(text)
    let nodes = 0
    const bounded = (v: unknown, depth: number) => {
      if (++nodes > 100000 || depth > 64) throw new Error("Structured output exceeds nesting/node limits")
      if (v && typeof v === "object") for (const item of Object.values(v)) bounded(item, depth + 1)
    }
    bounded(value, 0)
    if (!validate(value))
      throw new Error(
        `Output schema validation failed: ${validate.errors?.[0]?.message ?? "invalid output"}. No automatic retry was performed.`,
      )
    return value
  }
}
