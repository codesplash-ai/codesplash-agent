/** Inert catalog metadata selects reviewed, shipped instructions; catalogs cannot inject prompts. */
export const modelFamilies = [
  "generic",
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "qwen",
  "llama",
] as const
export type ModelFamily = (typeof modelFamilies)[number]
export function validModelFamily(value: unknown): value is ModelFamily {
  return typeof value === "string" && (modelFamilies as readonly string[]).includes(value)
}
export function modelFamily(model: {
  id: string
  provider: string
  promptFamily?: ModelFamily
}): ModelFamily {
  if (model.promptFamily) return model.promptFamily
  const id = model.id.toLowerCase().split("/").at(-1)!
  if (/^claude(?:-|$)/.test(id)) return "anthropic"
  if (/^(?:gpt-|o[1-9](?:-|$)|codex(?:-|$))/.test(id)) return "openai"
  for (const family of ["gemini", "deepseek", "qwen", "llama"] as const)
    if (id.startsWith(family)) return family
  return model.provider === "anthropic" ? "anthropic" : model.provider === "openai" ? "openai" : "generic"
}
