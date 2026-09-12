export const orchestrationDefaults = {
  maxRunning: 4,
  maxQueued: 32,
  maxDepth: 3,
  maxTasks: 128,
  outputBytes: 1024 * 1024,
}
export type OrchestrationConfig = typeof orchestrationDefaults
const bounds: Record<keyof OrchestrationConfig, readonly [number, number]> = {
  maxRunning: [1, 16],
  maxQueued: [0, 128],
  maxDepth: [1, 8],
  maxTasks: [1, 128],
  outputBytes: [1024, 1024 * 1024],
}
export function validateOrchestration(value: unknown): OrchestrationConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("[orchestration]: expected a table")
  const result = { ...orchestrationDefaults }
  for (const [name, entry] of Object.entries(value)) {
    if (!Object.hasOwn(bounds, name)) throw new Error(`[orchestration].${name}: unknown setting`)
    const key = name as keyof OrchestrationConfig
    const [min, max] = bounds[key]
    if (!Number.isSafeInteger(entry) || entry < min || entry > max)
      throw new Error(`[orchestration].${name}: expected an integer from ${min} to ${max}`)
    result[key] = entry
  }
  return result
}
export function narrowOrchestration(
  ...layers: Array<Partial<OrchestrationConfig> | undefined>
): OrchestrationConfig {
  const result = { ...orchestrationDefaults }
  // The first layer can opt into a higher supported limit; subsequent layers are ceilings.
  Object.assign(result, validateOrchestration(layers[0] ?? {}))
  for (const layer of layers.slice(1))
    if (layer) {
      validateOrchestration(layer)
      for (const key of Object.keys(layer) as Array<keyof OrchestrationConfig>)
        result[key] = Math.min(result[key], layer[key]!)
    }
  return result
}
