import { redactConfigValue } from "../commands/config.ts"
import { editConfigSource, isTable, readConfigSource } from "../core/config/source.ts"
import { type TuiConfig, tuiChoices, tuiDefaults } from "../core/config/tui.ts"
import { type AgentConfig, configFilePath, loadConfig, validateConfig } from "../core/config.ts"

export type SettingRow = {
  key: string
  value: unknown
  source: string
  locked: boolean
  editable: boolean
  choices?: readonly unknown[]
  tab: string
}
export function settingsRows(config: AgentConfig): SettingRow[] {
  const configValues = { ...config, tui: { ...tuiDefaults, ...config.tui } }
  const rows: SettingRow[] = []
  const flatten = (value: unknown, key = "") => {
    if (isTable(value))
      for (const [name, child] of Object.entries(value)) {
        if (["resolution", "pluginResources"].includes(name) || rows.length >= 300) continue
        flatten(child, key ? `${key}.${name}` : name)
      }
    else {
      const sources = config.resolution?.provenance[key] ?? ["defaults"]
      const locked = sources.includes("managed")
      const uiKey = key.slice(4) as keyof TuiConfig
      const editable =
        !locked && (key === "theme" || (key.startsWith("tui.") && Object.hasOwn(tuiDefaults, uiKey)))
      const choices =
        key === "theme"
          ? ["system", "dark", "light"]
          : typeof value === "boolean"
            ? [false, true]
            : tuiChoices[uiKey]
      const tab =
        !key.startsWith("tui.") && key !== "theme"
          ? "Agent"
          : /vim|mouse|clipboard|copyOnSelect/.test(key)
            ? "Input"
            : /notification|title|sleep|status|suggestion|tip|onboard/.test(key)
              ? "Attention"
              : "Appearance"
      rows.push({
        key,
        value: redactConfigValue(value, process.env),
        source: sources.join(" → "),
        locked,
        editable,
        choices,
        tab,
      })
    }
  }
  flatten(configValues)
  return rows
}
export async function settingsSnapshot(
  base: AgentConfig,
  cwd: string,
): Promise<{ config: AgentConfig; fingerprint: string }> {
  const request = base.resolution?.request
  const path = request?.userPath ?? configFilePath()
  const config = await loadConfig(path, request?.overrides ?? [], {
    ...request?.options,
    cwd,
    pluginSnapshot: base.plugins,
  })
  return { config, fingerprint: readConfigSource(path).fingerprint }
}
export async function changeSetting(
  base: AgentConfig,
  cwd: string,
  key: string,
  value: unknown,
  fingerprint: string,
): Promise<AgentConfig> {
  const snapshot = await settingsSnapshot(base, cwd)
  if (snapshot.fingerprint !== fingerprint) throw new Error("Settings changed; reload before editing")
  const row = settingsRows(snapshot.config).find((item) => item.key === key)
  if (!row?.editable) throw new Error("Setting is managed or requires its existing agent/session control")
  const path = snapshot.config.resolution!.request.userPath
  editConfigSource(
    path,
    (raw) => {
      if (key === "theme") raw.theme = value
      else {
        raw.tui = { ...(isTable(raw.tui) ? raw.tui : {}), [key.slice(4)]: value }
      }
      validateConfig(raw, path)
    },
    fingerprint,
  )
  return (await settingsSnapshot(base, cwd)).config
}
