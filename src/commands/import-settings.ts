import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { configFilePath, validateConfig } from "../core/config.ts"
import { atomic, bytes, digest, directory, lease } from "../core/session/files.ts"
import type { ForeignVendor } from "../core/session/foreign.ts"
import { safeSessionText } from "../core/session/repository.ts"
import { stringifyToml, type TomlTable } from "../core/toml.ts"
import { findModel } from "../engines/codesplash/catalog.ts"

export type SettingsPreview = {
  vendor: ForeignVendor
  source: string
  destination: string
  sourceHash: string
  destinationHash: string | null
  changes: Array<{ sourceKey: string; target: string; value: string | boolean; effect: string }>
  unsupported: Array<{ key: string; reason: string }>
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
export function previewSettings(
  vendor: ForeignVendor,
  source: string,
  destination = configFilePath(),
): SettingsPreview {
  const data = bytes(resolve(source), 1024 * 1024),
    parsed: unknown = vendor === "codex" ? Bun.TOML.parse(data.toString()) : JSON.parse(data.toString())
  if (!object(parsed)) throw new Error("Settings must be an object/table")
  const preview: SettingsPreview = {
    vendor,
    source: resolve(source),
    destination: resolve(destination),
    sourceHash: digest(data),
    destinationHash: existsSync(destination) ? digest(bytes(destination)) : null,
    changes: [],
    unsupported: [],
  }
  for (const [key, value] of Object.entries(parsed)) {
    const report = (reason: string) =>
      preview.unsupported.push({ key: safeSessionText(key).slice(0, 128), reason })
    if (key === "model") {
      if (
        typeof value !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value) ||
        safeSessionText(value) !== value
      ) {
        report("Unsupported model selector")
        continue
      }
      const target = vendor === "cursor" ? "codesplash" : vendor
      if (vendor === "cursor" && !findModel(value)) {
        report("Cursor-only or unknown models have no native catalog equivalent")
        continue
      }
      preview.changes.push({
        sourceKey: key,
        target: `models.${target}`,
        value,
        effect: `Default model on ${target} launch; explicit launch model wins`,
      })
    } else if (vendor === "codex" && key === "history" && object(value)) {
      for (const nested of Object.keys(value))
        if (nested !== "persistence")
          preview.unsupported.push({
            key: `history.${safeSessionText(nested)}`,
            reason: "No equivalent retention/history setting",
          })
      if (value.persistence === "none" || value.persistence === "save-all")
        preview.changes.push({
          sourceKey: "history.persistence",
          target: "history.enabled",
          value: value.persistence === "save-all",
          effect: "Harness history default for all engines; existing history is preserved",
        })
      else report("Unsupported history.persistence value")
    } else if (vendor === "claude" && key === "autoCompactEnabled" && typeof value === "boolean")
      preview.changes.push({
        sourceKey: key,
        target: "codesplash.autoCompact",
        value,
        effect: "Native automatic compaction switch; vendor thresholds are not migrated",
      })
    else
      report(
        /permission|sandbox|approval/i.test(key)
          ? "Permission settings are proposals only; use local permission controls after review"
          : /auth|token|secret|password|env|key/i.test(key)
            ? "Credential/environment settings are never migrated; values omitted"
            : "No implemented equivalent; values omitted",
      )
  }
  return preview
}
export function applySettings(preview: SettingsPreview): void {
  if (!preview.changes.length) throw new Error("No supported settings to apply")
  // Recompute the proposal from its source; callers cannot smuggle additional config keys.
  const fresh = previewSettings(preview.vendor, preview.source, preview.destination)
  if (JSON.stringify(fresh) !== JSON.stringify(preview)) throw new Error("Settings changed since preview")
  directory(dirname(preview.destination), true)
  const release = lease(dirname(preview.destination), "settings-import.lease")
  try {
    const old = existsSync(preview.destination) ? bytes(preview.destination) : undefined
    if (
      (old ? digest(old) : null) !== preview.destinationHash ||
      digest(bytes(preview.source)) !== preview.sourceHash
    )
      throw new Error("Settings source/destination changed since preview")
    const parsed = old ? (Bun.TOML.parse(old.toString()) as TomlTable) : { schemaVersion: 1 }
    for (const change of preview.changes) {
      const [table, key] = change.target.split(".") as [string, string]
      const section = object(parsed[table]) ? (parsed[table] as TomlTable) : {}
      section[key] = change.value
      parsed[table] = section
    }
    validateConfig(parsed, preview.destination)
    if (old) {
      const backup = `${preview.destination}.before-import-${digest(old).slice(0, 16)}`
      if (!existsSync(backup)) atomic(backup, old)
      else if (digest(bytes(backup)) !== digest(old)) throw new Error("Settings backup collision")
    }
    atomic(preview.destination, stringifyToml(parsed))
  } finally {
    release()
  }
}
export async function runSettingsImport(args: string[], output: (text: string) => void): Promise<number> {
  const [vendor, source, ...rest] = args
  if (!source || !["claude", "codex", "cursor"].includes(vendor ?? ""))
    throw new Error("Use import settings <claude|codex|cursor> FILE [--destination CONFIG] [--apply]")
  let destination = configFilePath(),
    apply = false
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--apply") apply = true
    else if (rest[i] === "--destination" && rest[i + 1]) destination = resolve(rest[++i] as string)
    else throw new Error(`Unknown settings import option ${rest[i]}`)
  }
  const preview = previewSettings(vendor as ForeignVendor, source, destination)
  output(`${JSON.stringify(preview, null, 2)}\n`)
  if (apply) {
    applySettings(preview)
    output("Supported settings applied; credentials and permissions were not imported.\n")
  } else output("Use --apply after reviewing the mappings.\n")
  return 0
}
