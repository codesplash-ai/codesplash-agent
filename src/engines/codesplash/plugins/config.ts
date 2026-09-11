import { isAbsolute } from "node:path"
import { isTable } from "../../../core/config/source.ts"
export const PLUGIN_ID = /^[a-z][a-z0-9_-]{0,31}$/
export type PluginSelection = { root: string; integrity: string; source: string; enabled: boolean }
export type MarketplaceSelection = Omit<PluginSelection, "enabled">
export type PluginConfig = {
  pending?: Record<string, { source: string; enabled: false }>
  entries: Record<string, PluginSelection>
  marketplaces: Record<string, MarketplaceSelection>
}
export function validatePlugins(raw: unknown): PluginConfig {
  if (!isTable(raw) || Object.keys(raw).some((key) => !["entries", "marketplaces", "pending"].includes(key)))
    throw new Error("Invalid plugins configuration")
  const result: PluginConfig = { entries: Object.create(null), marketplaces: Object.create(null) }
  for (const kind of ["entries", "marketplaces"] as const) {
    const entries = raw[kind] ?? {}
    if (!isTable(entries) || Object.keys(entries).length > 32)
      throw new Error("At most 32 plugin/marketplace selections are supported")
    for (const [id, value] of Object.entries(entries)) {
      if (
        !PLUGIN_ID.test(id) ||
        !isTable(value) ||
        Object.keys(value).some(
          (key) => !["root", "integrity", "source", ...(kind === "entries" ? ["enabled"] : [])].includes(key),
        )
      )
        throw new Error("Invalid plugin selection")
      if (
        typeof value.root !== "string" ||
        !isAbsolute(value.root) ||
        value.root.length > 4096 ||
        Array.from(value.root).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
        typeof value.integrity !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.integrity) ||
        typeof value.source !== "string" ||
        !value.source ||
        value.source.length > 4096 ||
        Array.from(value.source).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      )
        throw new Error("Plugin selection requires an absolute root, immutable integrity and source")
      if (value.enabled !== undefined && typeof value.enabled !== "boolean")
        throw new Error("Plugin enabled must be boolean")
      Object.assign(result[kind], {
        [id]: {
          root: value.root,
          integrity: value.integrity,
          source: value.source,
          ...(kind === "entries" ? { enabled: value.enabled === true } : {}),
        },
      })
    }
  }
  if (raw.pending !== undefined) {
    if (
      !isTable(raw.pending) ||
      Object.keys(raw.pending).length > 32 ||
      Object.entries(raw.pending).some(
        ([id, value]) =>
          !PLUGIN_ID.test(id) ||
          !isTable(value) ||
          value.enabled !== false ||
          typeof value.source !== "string" ||
          !value.source ||
          value.source.length > 4096 ||
          Object.keys(value).some((key) => !["enabled", "source"].includes(key)),
      )
    )
      throw new Error("Invalid inactive plugin import")
    result.pending = raw.pending as NonNullable<PluginConfig["pending"]>
  }
  return result
}
