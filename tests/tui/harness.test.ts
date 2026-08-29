import { describe, expect, test } from "bun:test"
import { defaultConfig, initialAppViewState } from "../../src/core/index.ts"
import type { CodesplashDriver } from "../../src/engines/codesplash/index.ts"
import {
  composerRows,
  engineDisplayName,
  engineStatusLabel,
  errorRecoveryHint,
  formatRateLimit,
  keyboardHelpEntries,
  parseSlashCommand,
  showPlanPanel,
  slashCommandHelp,
} from "../../src/tui/codex-session.tsx"
import { createEngineDriver } from "../../src/tui/run-codex-session.tsx"

describe("slash commands", () => {
  test("ordinary prompts are not commands", () => {
    expect(parseSlashCommand("fix the bug")).toBeUndefined()
    expect(parseSlashCommand("  what does / mean in regex?")).toBeUndefined()
    expect(parseSlashCommand("")).toBeUndefined()
  })

  test("parses every documented command with optional arguments", () => {
    expect(parseSlashCommand("/help")).toEqual({ name: "help", argument: undefined })
    expect(parseSlashCommand("/new")).toEqual({ name: "new", argument: undefined })
    expect(parseSlashCommand("/resume")).toEqual({ name: "resume", argument: undefined })
    expect(parseSlashCommand("/engine")).toEqual({ name: "engine", argument: undefined })
    expect(parseSlashCommand("/model gpt-test-mini")).toEqual({ name: "model", argument: "gpt-test-mini" })
    expect(parseSlashCommand("/permissions")).toEqual({ name: "permissions", argument: undefined })
    expect(parseSlashCommand("/history")).toEqual({ name: "history", argument: undefined })
    expect(parseSlashCommand("/quit")).toEqual({ name: "quit", argument: undefined })
    expect(parseSlashCommand("  /MODEL  gpt-x  ")).toEqual({ name: "model", argument: "gpt-x" })
  })

  test("flags unknown commands instead of sending them as prompts", () => {
    expect(parseSlashCommand("/frobnicate now")).toEqual({ name: "unknown", raw: "/frobnicate now" })
  })

  test("every command in the M4 spec is documented in the help overlay", () => {
    const documented = slashCommandHelp.map((entry) => entry.command.split(" ")[0])
    for (const required of ["/new", "/resume", "/engine", "/model", "/permissions", "/history", "/quit"]) {
      expect(documented).toContain(required)
    }
    expect(keyboardHelpEntries.length).toBeGreaterThan(5)
  })
})

describe("harness status and layout", () => {
  test("compacts the composer and hides the plan panel on small terminals", () => {
    expect(composerRows(24)).toBe(5)
    expect(composerRows(19)).toBe(3)
    expect(showPlanPanel(24, 3)).toBe(true)
    expect(showPlanPanel(19, 3)).toBe(false)
    expect(showPlanPanel(24, 0)).toBe(false)
  })

  test("hides plans that cannot fit without overlapping their rows", () => {
    expect(showPlanPanel(20, 4)).toBe(false)
    expect(showPlanPanel(21, 4)).toBe(false)
    expect(showPlanPanel(22, 4)).toBe(true)
  })

  test("formats rate-limit usage and flags near-exhaustion", () => {
    expect(formatRateLimit(initialAppViewState)).toBeUndefined()
    const relaxed = {
      ...initialAppViewState,
      usage: { rateLimit: { usedPercent: 41.6, label: "weekly" } },
    }
    expect(formatRateLimit(relaxed)).toEqual({ text: "weekly limit 42% used", critical: false })
    const critical = { ...initialAppViewState, usage: { rateLimit: { usedPercent: 97 } } }
    expect(formatRateLimit(critical)).toEqual({ text: "limit 97% used", critical: true })
  })

  test("maps known failure shapes to actionable recovery hints", () => {
    expect(errorRecoveryHint("401 Unauthorized")).toContain("Reauthenticate")
    expect(errorRecoveryHint("usage limit reached for plan")).toContain("limit reached")
    expect(errorRecoveryHint("unsupported protocol version")).toContain("0.147.0")
    expect(errorRecoveryHint("some novel explosion")).toBeUndefined()
  })
})

describe("engine labels", () => {
  test("status line shows the session's engine id with the active model selector", () => {
    expect(engineStatusLabel("codex", undefined)).toBe("codex")
    expect(engineStatusLabel("codex", "gpt-5.3-codex")).toBe("codex/gpt-5.3-codex")
    expect(engineStatusLabel("codesplash", undefined)).toBe("codesplash")
    expect(engineStatusLabel("codesplash", "claude-sonnet-4-5:high")).toBe(
      "codesplash/claude-sonnet-4-5:high",
    )
  })

  test("transcript headers use the human-facing engine name", () => {
    expect(engineDisplayName("codex")).toBe("Codex")
    expect(engineDisplayName("claude")).toBe("Claude")
    expect(engineDisplayName("codesplash")).toBe("CodeSplash")
  })

  test("the session runner constructs the driver matching the requested engine", () => {
    expect(createEngineDriver("codex").id).toBe("codex")
    expect(createEngineDriver("codesplash").id).toBe("codesplash")
  })

  test("the loaded config (with -c overrides) reaches the codesplash driver", () => {
    // Without this the interactive TUI's engine reloads config from disk and silently drops the
    // root command's -c overrides (fallbackModel, custom providers, ...).
    const config = structuredClone(defaultConfig)
    config.codesplash.fallbackModel = "gpt-5.1"
    const driver = createEngineDriver("codesplash", config) as CodesplashDriver
    expect(driver.options.config).toBe(config)
  })
})
