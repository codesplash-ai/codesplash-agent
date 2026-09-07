import type { MemoryConfig } from "./contracts.ts"
export function validateMemoryConfig(value: unknown): MemoryConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("[memory]: expected a table")
  const result: MemoryConfig = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === "enabled" || key === "autoLearn") {
      if (typeof entry !== "boolean") throw new Error(`[memory].${key}: expected a boolean`)
      result[key] = entry
    } else if (key === "embedding") {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw new Error("[memory.embedding]: expected a table")
      const item = entry as Record<string, unknown>
      if (
        Object.keys(item).some(
          (k) => !["url", "model", "keyEnvVar", "dimensions", "inputPerMTok"].includes(k),
        )
      )
        throw new Error("[memory.embedding]: unknown field; credentials belong in an environment variable")
      if (
        typeof item.url !== "string" ||
        typeof item.model !== "string" ||
        !item.model ||
        item.model.length > 200 ||
        typeof item.keyEnvVar !== "string" ||
        !/^[A-Z][A-Z0-9_]{0,127}$/.test(item.keyEnvVar) ||
        !Number.isInteger(item.dimensions) ||
        Number(item.dimensions) < 1 ||
        Number(item.dimensions) > 1536
      )
        throw new Error("[memory.embedding]: requires url, model, keyEnvVar and dimensions (1–1536)")
      const url = new URL(item.url)
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
        throw new Error("[memory.embedding].url: requires HTTPS without userinfo, query or fragment")
      if (
        item.inputPerMTok !== undefined &&
        (typeof item.inputPerMTok !== "number" ||
          !Number.isFinite(item.inputPerMTok) ||
          item.inputPerMTok < 0)
      )
        throw new Error("[memory.embedding].inputPerMTok: expected nonnegative price")
      result.embedding = {
        url: url.toString(),
        model: item.model,
        keyEnvVar: item.keyEnvVar,
        dimensions: Number(item.dimensions),
        ...(item.inputPerMTok === undefined ? {} : { inputPerMTok: Number(item.inputPerMTok) }),
      }
    } else throw new Error(`[memory].${key}: unknown setting`)
  }
  return result
}
