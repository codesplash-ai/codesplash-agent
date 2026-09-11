import { dirname } from "node:path"
import { atomic, bytes, digest, lease } from "../session/files.ts"
import { stringifyToml, type TomlTable } from "../toml.ts"

export const isTable = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

export function checkConfigBounds(value: unknown): void {
  let nodes = 0
  const visit = (entry: unknown, depth: number): void => {
    if (++nodes > 20_000 || depth > 32) throw new Error("Configuration exceeds structural limits")
    if (entry && typeof entry === "object") {
      if (!Array.isArray(entry) && !isTable(entry)) throw new Error("Unsupported configuration value")
      for (const [key, child] of Object.entries(entry)) {
        if (["__proto__", "prototype", "constructor"].includes(key))
          throw new Error("Unsafe configuration key")
        visit(child, depth + 1)
      }
    }
    if (typeof entry === "number" && !Number.isFinite(entry))
      throw new Error("Non-finite configuration value")
  }
  visit(value, 0)
}

export function readConfigSource(path: string): {
  raw: Record<string, unknown>
  source: string
  fingerprint: string
} {
  let source: string
  try {
    source = bytes(path).toString("utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { raw: {}, source: "", fingerprint: digest("") }
    throw new Error(`Could not read configuration source ${path}`, { cause: error })
  }
  let raw: unknown
  try {
    raw = Bun.TOML.parse(source)
  } catch {
    throw new Error(`Could not parse configuration source ${path}`)
  }
  if (!isTable(raw)) throw new Error(`Expected configuration table at ${path}`)
  checkConfigBounds(raw)
  return { raw, source, fingerprint: digest(source) }
}

/** Source-specific edit: preserve unknown fields/profiles, never accept a resolved snapshot. */
export function editConfigSource(
  path: string,
  edit: (raw: Record<string, unknown>) => void,
  expectedFingerprint?: string,
): { fingerprint: string; backupPath?: string } {
  const release = lease(dirname(path), "config-edit.lease")
  try {
    const previous = readConfigSource(path)
    if (expectedFingerprint !== undefined && expectedFingerprint !== previous.fingerprint)
      throw new Error("Configuration changed since review; reload before editing")
    const next = structuredClone(previous.raw)
    edit(next)
    checkConfigBounds(next)
    const source = stringifyToml(next as TomlTable)
    const roundtrip = Bun.TOML.parse(source)
    if (stableValue(roundtrip) !== stableValue(next))
      throw new Error("Configuration cannot roundtrip without losing values; edit it manually")
    if (readConfigSource(path).fingerprint !== previous.fingerprint)
      throw new Error("Configuration changed during edit; retry")
    const backupPath = previous.source ? `${path}.backup` : undefined
    if (backupPath) {
      // Validate the target before atomic replacement; do not follow links.
      try {
        bytes(backupPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      atomic(backupPath, previous.source)
    }
    atomic(path, source)
    return { fingerprint: digest(source), backupPath }
  } finally {
    release()
  }
}

export function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`
  if (isTable(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}
