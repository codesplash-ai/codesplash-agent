import { isTable } from "../../../core/config/source.ts"

export const EXTENSION_ID = /^[a-z][a-z0-9_-]{0,31}$/
export type ExtensionEntry = {
  root: string
  entry: string
  enabled: boolean
  overrides: string[]
  flags: Record<string, string | boolean | number>
}
export type ExtensionConfig = { disabled: boolean; entries: Record<string, ExtensionEntry> }
export function validateExtensions(value: unknown): ExtensionConfig {
  if (!isTable(value) || Object.keys(value).some((key) => !["disabled", "entries"].includes(key)))
    throw new Error("Invalid extensions configuration")
  if (value.disabled !== undefined && typeof value.disabled !== "boolean")
    throw new Error("extensions.disabled must be boolean")
  const entries = value.entries ?? {}
  if (!isTable(entries) || Object.keys(entries).length > 32)
    throw new Error("Expected at most 32 extension entries")
  const result: ExtensionConfig = { disabled: value.disabled === true, entries: {} }
  for (const [id, entry] of Object.entries(entries)) {
    if (
      !EXTENSION_ID.test(id) ||
      !isTable(entry) ||
      Object.keys(entry).some((key) => !["root", "entry", "enabled", "overrides", "flags"].includes(key))
    )
      throw new Error("Invalid extension entry")
    if (
      typeof entry.root !== "string" ||
      !entry.root ||
      entry.root.length > 4096 ||
      Array.from(entry.root).some((char) => char.charCodeAt(0) < 32)
    )
      throw new Error("Extension root must be a literal directory")
    if (
      typeof entry.entry !== "string" ||
      entry.entry.length > 1024 ||
      !/\.(?:[cm]?[jt]s|tsx|jsx)$/.test(entry.entry) ||
      entry.entry.includes("\\") ||
      Array.from(entry.entry).some((char) => char.charCodeAt(0) < 32) ||
      entry.entry.startsWith("/") ||
      entry.entry.split("/").some((part) => !part || part === "..")
    )
      throw new Error("Extension entry must be a relative TS/JS file")
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean")
      throw new Error("Extension enabled must be boolean")
    const overrides = entry.overrides ?? [],
      flags = entry.flags ?? {}
    if (
      !Array.isArray(overrides) ||
      overrides.length > 16 ||
      new Set(overrides).size !== overrides.length ||
      overrides.some((name) => typeof name !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(name))
    )
      throw new Error("Invalid extension overrides")
    if (
      !isTable(flags) ||
      Object.keys(flags).length > 32 ||
      Object.entries(flags).some(
        ([name, v]) =>
          !EXTENSION_ID.test(name) ||
          !["string", "boolean", "number"].includes(typeof v) ||
          (typeof v === "number" && !Number.isFinite(v)) ||
          (typeof v === "string" && v.length > 4096),
      )
    )
      throw new Error("Invalid extension flags")
    result.entries[id] = {
      root: entry.root,
      entry: entry.entry,
      enabled: entry.enabled === true,
      overrides: overrides as string[],
      flags: flags as ExtensionEntry["flags"],
    }
  }
  return result
}
