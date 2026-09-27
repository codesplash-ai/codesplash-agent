import { createHash } from "node:crypto"
import { diagnosticContext } from "../../../core/diagnostics.ts"

export const cacheDiagnosticKinds = [
  "cache.break.model",
  "cache.break.tools",
  "cache.break.system",
  "cache.break.parameters",
  "cache.break.policy",
  "cache.break.history",
  "cache.hit-loss",
] as const
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value) ?? "null")
    .digest("hex")
/** Keep hashes only; distinguish normal history append from an edited cache prefix. */
export class WireCacheTracker {
  #previous?: { fields: string[]; messages: string[] }
  #lastReads?: number
  inspect(body: Record<string, unknown>): void {
    const {
      model,
      tools,
      system,
      instructions,
      messages,
      input,
      cache_control,
      prompt_cache_key,
      prompt_cache_retention,
      ...parameters
    } = body
    const history = Array.isArray(messages) ? messages : Array.isArray(input) ? input : []
    const systemBlocks = history.filter((item) => item?.role === "system" || item?.role === "developer")
    const current = {
      fields: [
        model,
        tools,
        system ?? instructions ?? systemBlocks,
        parameters,
        { cache_control, prompt_cache_key, prompt_cache_retention },
      ].map(hash),
      messages: (Array.isArray(messages) ? messages : Array.isArray(input) ? input : [])
        .slice(0, 10000)
        .map(hash),
    }
    if (this.#previous) {
      for (let i = 0; i < current.fields.length; i++)
        if (current.fields[i] !== this.#previous.fields[i])
          diagnosticContext.getStore()?.record(cacheDiagnosticKinds[i]!, { count: 1 })
      if (this.#previous.messages.some((value, index) => current.messages[index] !== value))
        diagnosticContext.getStore()?.record("cache.break.history", { count: 1 })
    }
    this.#previous = current
  }
  usage(reads: number | undefined): void {
    if (reads === undefined) return
    if (this.#lastReads && reads === 0) diagnosticContext.getStore()?.record("cache.hit-loss", { count: 1 })
    this.#lastReads = reads
  }
}
