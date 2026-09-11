import { isTable } from "../core/config/source.ts"
import { digest } from "../core/session/files.ts"
import { safeSessionText } from "../core/session/repository.ts"
import type { SettingsPreview } from "./import-settings.ts"
/** Foreign source references stay inert. Import never downloads or validates executable code. */
export function previewPluginSettings(
  preview: SettingsPreview,
  key: string,
  raw: unknown,
  existing: unknown,
): void {
  const report = (name: string, reason: string) =>
    preview.unsupported.push({ key: safeSessionText(name).slice(0, 128), reason })
  const entries = isTable(raw)
    ? Object.entries(raw)
    : Array.isArray(raw)
      ? raw.map((value, i) => [String(i), value] as const)
      : []
  if (!entries.length || entries.length > 32) {
    report(key, "Unsupported or oversized plugin declarations")
    return
  }
  const pending =
    isTable(existing) && isTable(existing.plugins) && isTable(existing.plugins.pending)
      ? existing.plugins.pending
      : {}
  for (const [name, value] of entries) {
    const source =
      typeof value === "boolean"
        ? name
        : typeof value === "string"
          ? value
          : isTable(value) && typeof value.source === "string"
            ? value.source
            : undefined
    if (
      !source ||
      source.length > 4096 ||
      Array.from(source).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      safeSessionText(source) !== source
    ) {
      report(`${key}.${name}`, "Plugin source is unsupported or sensitive")
      continue
    }
    const id = `import_${digest(`${preview.vendor}/${source}`).slice(0, 24)}`
    if (
      pending[id] ||
      Object.keys(pending).length +
        preview.changes.filter((change) => change.target.startsWith("plugins.pending.")).length >=
        32
    ) {
      report(`${key}.${name}`, "Inactive plugin mapping already exists or limit reached")
      continue
    }
    preview.changes.push({
      sourceKey: `${key}.${name}`,
      target: `plugins.pending.${id}`,
      value: { source, enabled: false },
      effect:
        "Retain an inactive source reference only. Review the native manifest/source syntax and marketplace before explicit plugin install; foreign APIs and trust are not imported.",
    })
  }
}
