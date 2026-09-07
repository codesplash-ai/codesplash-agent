import type { HarnessTool } from "../contracts.ts"
import type { MemoryConfig } from "./contracts.ts"
import { memoryHash } from "./identity.ts"
import { validVector } from "./retrieval.ts"

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel = () => {}
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        cancel = () => reject(signal.reason ?? new Error("Embedding interrupted"))
        signal.addEventListener("abort", cancel, { once: true })
        if (signal.aborted) cancel()
      }),
    ])
  } finally {
    signal.removeEventListener("abort", cancel)
  }
}
export const embeddingKey = (config: NonNullable<MemoryConfig["embedding"]>) =>
  memoryHash(JSON.stringify([config.url, config.model, config.dimensions]))
export function embeddingTool(
  config?: MemoryConfig["embedding"],
  onUsage: (tokens: number, cost: number | undefined) => void = () => {},
): HarnessTool {
  return {
    name: "memory_embed",
    hidden: true,
    permissionName: "web_fetch",
    description: "Embed bounded memory text using the configured endpoint",
    inputSchema: { type: "object" },
    isReadOnly: () => true,
    permission: () => ({ kind: "none" }),
    permissionTargets() {
      return config ? { urlHost: new URL(config.url).hostname } : {}
    },
    async run(input, context) {
      if (!config) throw new Error("No memory embedding provider configured")
      const texts = (input as { texts?: unknown })?.texts
      if (
        !Array.isArray(texts) ||
        !texts.length ||
        texts.length > 16 ||
        texts.some((t) => typeof t !== "string") ||
        Buffer.byteLength(JSON.stringify(texts)) > 65536
      )
        throw new Error("Embedding input exceeds 16 texts/64 KiB")
      context.signal.throwIfAborted()
      context.checkNetwork?.(config.url)
      if (!context.fetchNetwork) throw new Error("Memory embeddings require the governed network transport")
      const key = process.env[config.keyEnvVar]
      if (!key) throw new Error(`Set ${config.keyEnvVar} for memory embeddings`)
      const abort = new AbortController(),
        cancel = () => abort.abort(context.signal.reason)
      context.signal.addEventListener("abort", cancel, { once: true })
      const timer = setTimeout(() => abort.abort(new Error("Embedding request timed out")), 10000)
      try {
        const clean = texts.map((text) => {
          const redacted = text.replaceAll(key, "[REDACTED]")
          return context.sanitizeOutput?.(redacted) ?? redacted
        })
        const response = await abortable(
          context.fetchNetwork(config.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify({ model: config.model, input: clean, dimensions: config.dimensions }),
            redirect: "error",
            signal: abort.signal,
          }),
          abort.signal,
        )
        if (!response.ok) {
          void response.body?.cancel().catch(() => {})
          throw new Error(`Embedding endpoint returned HTTP ${response.status}`)
        }
        const reader = response.body?.getReader()
        if (!reader) throw new Error("Empty embedding response")
        const chunks: Uint8Array[] = []
        let bytes = 0
        try {
          while (true) {
            const part = await abortable(reader.read(), abort.signal)
            if (part.done) break
            bytes += part.value.length
            if (bytes > 512 * 1024) throw new Error("Embedding response exceeds 512 KiB")
            chunks.push(part.value)
          }
        } finally {
          void reader.cancel().catch(() => {})
        }
        const value = JSON.parse(Buffer.concat(chunks).toString()) as {
          data?: Array<{ index: number; embedding: unknown }>
          usage?: { prompt_tokens?: number }
        }
        const usage = value.usage?.prompt_tokens
        if (typeof usage === "number" && Number.isSafeInteger(usage) && usage >= 0)
          onUsage(usage, config.inputPerMTok === undefined ? undefined : (usage * config.inputPerMTok) / 1e6)
        else onUsage(0, undefined)
        if (
          !Array.isArray(value.data) ||
          value.data.length !== texts.length ||
          new Set(value.data.map((v) => v.index)).size !== texts.length
        )
          throw new Error("Malformed embedding count")
        const vectors = value.data
          .sort((a, b) => a.index - b.index)
          .map((v, i) => {
            if (v.index !== i || !validVector(v.embedding, config.dimensions))
              throw new Error("Invalid embedding dimensions or values")
            return v.embedding
          })
        return { text: JSON.stringify({ vectors }), label: "Memory embeddings" }
      } finally {
        clearTimeout(timer)
        context.signal.removeEventListener("abort", cancel)
      }
    },
  }
}
