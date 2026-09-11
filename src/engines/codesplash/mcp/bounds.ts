export const MCP_FRAME_BYTES = 16 * 1024 * 1024
export const MCP_SCHEMA_BYTES = 128 * 1024
export const MCP_INPUT_BYTES = 1024 * 1024

/** Bound work before serialization/validation. Only JSON values cross an external boundary. */
export function boundedJson(
  value: unknown,
  maxBytes = MCP_FRAME_BYTES,
  maxNodes = 20_000,
  omitUndefinedObjectFields = false,
): string {
  let nodes = 0
  let bytes = 0
  const active = new Set<object>()
  const visit = (entry: unknown, depth: number): void => {
    if (++nodes > maxNodes || depth > 32) throw new Error("MCP data exceeds structural limits")
    if (typeof entry === "string") bytes += Buffer.byteLength(entry)
    else if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw new Error("MCP data contains a non-finite number")
    } else if (entry !== null && typeof entry === "object") {
      if (active.has(entry)) throw new Error("MCP data contains a cycle")
      if (
        !Array.isArray(entry) &&
        Object.getPrototypeOf(entry) !== Object.prototype &&
        Object.getPrototypeOf(entry) !== null
      )
        throw new Error("MCP data must contain only JSON objects")
      active.add(entry)
      for (const [key, child] of Object.entries(entry)) {
        if (omitUndefinedObjectFields && !Array.isArray(entry) && child === undefined) continue
        bytes += Buffer.byteLength(key)
        visit(child, depth + 1)
      }
      active.delete(entry)
    } else if (entry !== null && typeof entry !== "boolean")
      throw new Error("MCP data must contain only JSON values")
    if (bytes > maxBytes) throw new Error("MCP data exceeds its byte limit")
  }
  visit(value, 0)
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text) > maxBytes) throw new Error("MCP data exceeds its byte limit")
  return text
}

export function jsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
