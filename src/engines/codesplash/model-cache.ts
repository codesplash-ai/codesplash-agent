import { existsSync } from "node:fs"
import { join } from "node:path"
import { dataDirectory } from "../../core/config.ts"
import { networkFetch } from "../../core/network.ts"
import { atomic, bytes, digest } from "../../core/session/files.ts"
import type { ModelInfo } from "./contracts.ts"
export const modelCachePath = () => join(dataDirectory(), "catalog", "models.json")
export function modelManifest(raw: unknown): { version: 1; models: ModelInfo[] } {
  const value = raw as { version: number; models: ModelInfo[] }
  if (value?.version !== 1 || !Array.isArray(value.models) || value.models.length > 4096)
    throw new Error("Invalid model catalog manifest")
  const ids = new Set<string>()
  for (const m of value.models) {
    if (
      !m ||
      typeof m.id !== "string" ||
      !m.id ||
      m.id.length > 256 ||
      ids.has(m.id) ||
      typeof m.provider !== "string" ||
      !m.provider ||
      m.provider.length > 128 ||
      !["openai", "anthropic"].includes(m.protocol) ||
      typeof m.displayName !== "string" ||
      m.displayName.length > 256 ||
      !Number.isSafeInteger(m.contextWindow) ||
      m.contextWindow < 512 ||
      m.contextWindow > 10000000 ||
      !Number.isSafeInteger(m.maxOutputTokens) ||
      m.maxOutputTokens < 16 ||
      m.maxOutputTokens > m.contextWindow ||
      typeof m.supportsReasoning !== "boolean" ||
      typeof m.isDefault !== "boolean"
    )
      throw new Error("Invalid model catalog entry")
    if (
      m.pricing &&
      Object.values(m.pricing).some(
        (n) => typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 100000,
      )
    )
      throw new Error("Invalid model pricing")
    if (m.pricing && (m.pricing.inputPerMTok === undefined || m.pricing.outputPerMTok === undefined))
      throw new Error("Incomplete model pricing")
    ids.add(m.id)
  }
  return {
    version: 1,
    models: value.models.map((m) => ({
      id: m.id,
      provider: m.provider,
      protocol: m.protocol,
      displayName: m.displayName,
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
      supportsReasoning: m.supportsReasoning,
      isDefault: m.isDefault,
      ...(m.pricing
        ? {
            pricing: {
              inputPerMTok: m.pricing.inputPerMTok,
              outputPerMTok: m.pricing.outputPerMTok,
              ...(m.pricing.cachedInputPerMTok === undefined
                ? {}
                : { cachedInputPerMTok: m.pricing.cachedInputPerMTok }),
            },
          }
        : {}),
    })),
  }
}
export function cachedModels(path = modelCachePath()): ModelInfo[] {
  if (!existsSync(path)) return []
  const record = JSON.parse(bytes(path, 8 * 1024 * 1024 + 4096).toString())
  if (record.version !== 1 || typeof record.source !== "string" || digest(record.source) !== record.sha256)
    throw new Error("Model cache checksum mismatch; refresh explicitly")
  return modelManifest(JSON.parse(record.source)).models
}
export async function refreshModels(url: string, sha256: string, path = modelCachePath()) {
  if (process.env.CODESPLASH_OFFLINE === "1") throw new Error("Model refresh is disabled offline")
  const target = new URL(url)
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.hash ||
    !/^[a-f0-9]{64}$/.test(sha256)
  )
    throw new Error("Catalog refresh requires HTTPS and an exact reviewed SHA256")
  const response = await networkFetch(target, { redirect: "error", signal: AbortSignal.timeout(15000) })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Catalog HTTP ${response.status}`)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Catalog body missing")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.length
      if (size > 4 * 1024 * 1024) throw new Error("Catalog exceeds 4 MiB")
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const source = Buffer.concat(chunks).toString()
  if (digest(source) !== sha256) throw new Error("Catalog checksum mismatch")
  const manifest = modelManifest(JSON.parse(source))
  atomic(path, JSON.stringify({ version: 1, source, sha256, fetched: new Date().toISOString() }))
  return { models: manifest.models.length, sha256 }
}
