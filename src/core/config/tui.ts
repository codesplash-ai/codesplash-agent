import { isTable } from "./source.ts"

export const tuiDefaults = {
  vim: false,
  mouseScroll: "accelerated" as "linear" | "accelerated",
  copyOnSelect: false,
  notificationIdleMs: 1000,
  mouse: "auto" as "auto" | "on" | "off",
  clipboard: "auto" as "auto" | "native" | "osc52",
  screen: "alternate" as "alternate" | "inline",
  theme: "" as string,
  thinking: "show" as "show" | "collapse" | "hide",
  notifications: false,
  title: true,
  reducedMotion: false,
  spinner: true,
  sleepInhibitor: false,
  pet: "none" as "none" | "cat",
  suggestions: false,
  tips: true,
  onboarding: true,
  statusSegments: ["model", "context", "state"] as string[],
}
export type TuiConfig = typeof tuiDefaults
export const tuiChoices: Partial<Record<keyof TuiConfig, readonly string[]>> = {
  mouseScroll: ["linear", "accelerated"],
  mouse: ["auto", "on", "off"],
  clipboard: ["auto", "native", "osc52"],
  screen: ["alternate", "inline"],
  thinking: ["show", "collapse", "hide"],
  pet: ["none", "cat"],
}
export const statusSegmentNames = ["model", "context", "state", "project", "tokens", "cost", "clock"]

export function validateTuiConfig(raw: unknown): TuiConfig {
  if (!isTable(raw)) throw new Error("[tui] must be a table")
  const config = structuredClone(tuiDefaults)
  for (const [name, value] of Object.entries(raw)) {
    if (!Object.hasOwn(config, name)) throw new Error(`Unknown tui setting ${name}`)
    const key = name as keyof TuiConfig
    const choices = tuiChoices[key]
    if (
      choices
        ? typeof value !== "string" || !choices.includes(value)
        : key === "notificationIdleMs"
          ? typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 60000
          : key === "theme"
            ? typeof value !== "string" || !/^(?:[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?$/.test(value)
            : key === "statusSegments"
              ? !Array.isArray(value) ||
                value.length > 7 ||
                value.some((item) => !statusSegmentNames.includes(item)) ||
                new Set(value).size !== value.length
              : typeof value !== "boolean"
    )
      throw new Error(`Invalid tui.${name}`)
    Object.assign(config, { [name]: value })
  }
  return config
}
