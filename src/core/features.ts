import { existsSync } from "node:fs"
import { join } from "node:path"
import { APP_VERSION } from "../version.ts"
import { isTable } from "./config/source.ts"
import { configDirectory } from "./config.ts"
import { type FleetSource, readFleetSources } from "./distribution/fleet.ts"
import { assertVersion } from "./distribution/versions.ts"
import { atomic, json, lease } from "./session/files.ts"

export const advancedFeatures: Record<string, readonly string[]> = {
  generation: ["generate_media"],
  environments: ["environment_exec"],
  plugins: ["plugin_suggestions"],
  browser: ["browser"],
  notebook: ["notebook_edit"],
  anchors: ["read_anchors", "edit_anchors"],
  clock: ["clock"],
  code: ["code_mode"],
}
export const featureRegistry = Object.fromEntries(
  Object.entries(advancedFeatures).map(([id, tools]) => [
    id,
    { id, stage: "experimental" as const, default: false, tools },
  ]),
)
type FeaturePreferences = {
  version: 1
  values: Record<string, boolean>
  campaigns: boolean
  dismissed: string[]
}
export function featurePreferences(root = configDirectory()): FeaturePreferences {
  const path = join(root, "features.json")
  if (!existsSync(path)) return { version: 1, values: {}, campaigns: false, dismissed: [] }
  const state = json<FeaturePreferences>(path, 65536)
  if (
    !isTable(state) ||
    state.version !== 1 ||
    !isTable(state.values) ||
    typeof state.campaigns !== "boolean" ||
    !Array.isArray(state.dismissed) ||
    state.dismissed.length > 128 ||
    state.dismissed.some((id) => typeof id !== "string" || id.length > 128) ||
    Object.entries(state.values).some(
      ([key, value]) => !Object.hasOwn(featureRegistry, key) || typeof value !== "boolean",
    )
  )
    throw new Error("Invalid feature preferences")
  return state
}
export function setFeature(name: string, enabled: boolean | undefined, root = configDirectory()): void {
  if (!Object.hasOwn(featureRegistry, name)) throw new Error("Unknown feature")
  const release = lease(root, "features.lease")
  try {
    const state = featurePreferences(root)
    if (enabled === undefined) delete state.values[name]
    else state.values[name] = enabled
    atomic(join(root, "features.json"), JSON.stringify(state))
  } finally {
    release()
  }
}
export function resolveFeatures(
  requested: readonly string[] = [],
  root = configDirectory(),
  fleet: FleetSource[] = readFleetSources(root),
): string[] {
  const preferences = featurePreferences(root)
  const desired = new Set([
    ...requested,
    ...Object.entries(preferences.values)
      .filter(([, value]) => value)
      .map(([key]) => key),
  ])
  for (const name of desired) if (!Object.hasOwn(featureRegistry, name)) throw new Error("Unknown feature")
  return [...desired].filter(
    (name) =>
      preferences.values[name] !== false &&
      !fleet.some((source) => {
        const ceiling = source.payload.constraints?.featureIds
        return (
          (Array.isArray(ceiling) && !ceiling.includes(name)) ||
          (Array.isArray(source.payload.settings?.disableFeatures) &&
            source.payload.settings.disableFeatures.includes(name))
        )
      }),
  )
}
export function featureAnnouncements(
  root = configDirectory(),
  fleet = readFleetSources(root),
): Array<{ id: string; text: string }> {
  const preferences = featurePreferences(root),
    out: Array<{ id: string; text: string }> = []
  for (const source of fleet)
    for (const item of Array.isArray(source.payload.settings?.announcements)
      ? source.payload.settings.announcements
      : []) {
      if (out.length >= 32) return out
      if (
        !item ||
        typeof item.id !== "string" ||
        !/^[\w.-]{1,128}$/.test(item.id) ||
        typeof item.text !== "string" ||
        item.text.length > 2000 ||
        preferences.dismissed.includes(item.id)
      )
        continue
      try {
        assertVersion(APP_VERSION, item)
        out.push({ id: item.id, text: item.text.replace(/[\p{Cc}\p{Cf}]/gu, " ") })
      } catch {}
    }
  return out
}

export function featureCampaign(
  root = configDirectory(),
  fleet = readFleetSources(root),
): { id: string; theme: "dark" | "light" } | undefined {
  if (!featurePreferences(root).campaigns) return
  for (const source of fleet) {
    const campaign = source.payload.settings?.campaign
    if (
      campaign &&
      /^[\w.-]{1,128}$/.test(campaign.id) &&
      (campaign.theme === "dark" || campaign.theme === "light")
    )
      return { id: campaign.id, theme: campaign.theme }
  }
}
