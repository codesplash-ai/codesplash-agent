import { describe, expect, test } from "bun:test"
import type { EngineProbe } from "../../src/core/index.ts"
import { activateAgent, agentChoices } from "../../src/tui/welcome.tsx"

describe("welcome engine list", () => {
  test("lists CodeSplash as the third engine choice", () => {
    expect(agentChoices).toEqual(["codex", "claude", "codesplash"])
  })

  test("opens a codesplash session when API keys were probed", () => {
    const probe: EngineProbe = {
      available: true,
      authenticated: true,
      version: "0.1.4",
      detail: "Anthropic API key · OpenAI API key",
    }
    expect(activateAgent("codesplash", probe)).toEqual({ action: "open-codesplash" })
  })

  test("surfaces the missing-key detail instead of opening codesplash without keys", () => {
    const probe: EngineProbe = {
      available: false,
      authenticated: false,
      version: "0.1.4",
      detail: "No API keys found — set ANTHROPIC_API_KEY or OPENAI_API_KEY",
    }
    expect(activateAgent("codesplash", probe)).toEqual({
      error: "No API keys found — set ANTHROPIC_API_KEY or OPENAI_API_KEY",
    })
    expect(activateAgent("codesplash", { available: false })).toEqual({
      error: "No API keys found — set ANTHROPIC_API_KEY or OPENAI_API_KEY",
    })
  })

  test("ignores Enter on the codesplash row while the probe is still in flight", () => {
    expect(activateAgent("codesplash", undefined)).toBeUndefined()
  })

  test("keeps the existing codex and claude activations", () => {
    expect(activateAgent("claude", undefined)).toEqual({ action: "launch-claude" })
    expect(activateAgent("codex", undefined)).toEqual({ action: "login-codex" })
    expect(activateAgent("codex", { available: true, authenticated: false })).toEqual({
      action: "login-codex",
    })
    expect(activateAgent("codex", { available: true, authenticated: true })).toEqual({
      action: "open-codex",
    })
    expect(
      activateAgent("codex", {
        available: true,
        authenticated: true,
        compatible: false,
        detail: "Codex CLI 0.100.0 is older than the supported baseline",
      }),
    ).toEqual({ error: "Codex CLI 0.100.0 is older than the supported baseline" })
    expect(activateAgent("codex", { available: true, authenticated: true, compatible: false })).toEqual({
      error: "The installed Codex CLI version is not supported.",
    })
  })
})
