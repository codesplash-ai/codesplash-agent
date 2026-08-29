import { describe, expect, test } from "bun:test"
import { type AppViewState, initialAppViewState } from "../../src/core/index.ts"
import {
  buildUsageOverlayLines,
  contextRemainingPercent,
  costIsPartial,
  formatContextRemaining,
  formatEstimatedCost,
  parseSlashCommand,
  slashCommandHelp,
  usageOverlayNote,
} from "../../src/tui/codex-session.tsx"
import { sessionTranscriptPath, usageSnapshotOf } from "../../src/tui/run-codex-session.tsx"

function stateWith(usage: AppViewState["usage"], model?: string): AppViewState {
  return { ...initialAppViewState, usage, model }
}

describe("/usage slash command", () => {
  test("parses like the other overlay commands and ignores arguments", () => {
    expect(parseSlashCommand("/usage")).toEqual({ name: "usage", argument: undefined })
    expect(parseSlashCommand("  /USAGE  ")).toEqual({ name: "usage", argument: undefined })
  })

  test("is documented in the help overlay (F1 command reference)", () => {
    const documented = slashCommandHelp.map((entry) => entry.command.split(" ")[0])
    expect(documented).toContain("/usage")
  })
})

describe("estimated cost", () => {
  test("is always labelled estimated and formats USD to four places", () => {
    expect(formatEstimatedCost({ estimatedCostUsd: 0.01234, inputTokens: 100 })).toBe("$0.0123 (estimated)")
  })

  test("reports missing cost without inventing a number", () => {
    expect(formatEstimatedCost({ inputTokens: 500, outputTokens: 20 })).toBe("not reported")
  })

  test("labels the cost partial when the loop flags unpriced usage", () => {
    // The flag rides the usage.updated payload; the reducer spreads unknown payload fields into
    // state.usage, so the overlay reads it leniently until the typed payload carries it.
    const flagged = {
      estimatedCostUsd: 0.42,
      inputTokens: 100,
      hasUnpricedUsage: true,
    } as AppViewState["usage"]
    expect(costIsPartial(flagged)).toBe(true)
    expect(formatEstimatedCost(flagged)).toBe("$0.4200 (estimated, partial)")
  })

  test("treats a zero cost with observed tokens as partial only when no flag was recorded", () => {
    // Legacy sessions (recorded before the flag existed) fall back to the heuristic.
    expect(costIsPartial({ estimatedCostUsd: 0, inputTokens: 1200, outputTokens: 50 })).toBe(true)
    expect(costIsPartial({ estimatedCostUsd: 0 })).toBe(false)
    expect(costIsPartial({ estimatedCostUsd: 0.5, inputTokens: 1200 })).toBe(false)
    expect(costIsPartial({ inputTokens: 1200 })).toBe(false)
  })

  test("an explicit hasUnpricedUsage: false is authoritative — $0-priced models are NOT partial", () => {
    // A local model priced at 0.0/0.0 is fully priced: the loop emits the flag as false and the
    // overlay must not slap "(estimated, partial)" on a legitimately zero-dollar session.
    const zeroPriced = {
      estimatedCostUsd: 0,
      inputTokens: 1200,
      outputTokens: 50,
      hasUnpricedUsage: false,
    } as AppViewState["usage"]
    expect(costIsPartial(zeroPriced)).toBe(false)
    expect(formatEstimatedCost(zeroPriced)).toBe("$0.0000 (estimated)")
    expect(usageOverlayNote(zeroPriced)).not.toContain("partial")
  })

  test("explains the partial label in the overlay note", () => {
    expect(usageOverlayNote({ estimatedCostUsd: 0.5, inputTokens: 10 })).not.toContain("partial")
    expect(usageOverlayNote({ estimatedCostUsd: 0, inputTokens: 10 })).toContain("partial")
  })
})

describe("context remaining", () => {
  test("derives the percentage from contextTokens against the model window", () => {
    const state = stateWith({ contextTokens: 150_000, modelContextWindow: 200_000 })
    expect(contextRemainingPercent(state)).toBe(25)
    expect(formatContextRemaining(state)).toBe("25% context left")
  })

  test("falls back to input+output tokens and clamps at zero", () => {
    expect(
      contextRemainingPercent(stateWith({ inputTokens: 90, outputTokens: 20, modelContextWindow: 100 })),
    ).toBe(0)
    expect(contextRemainingPercent(stateWith({}))).toBeUndefined()
    expect(formatContextRemaining(stateWith({}))).toBeUndefined()
  })
})

describe("usage overlay lines", () => {
  test("shows cumulative tokens, context, cost, model, and the rate limit when known", () => {
    const state = stateWith(
      {
        inputTokens: 12_345,
        cachedInputTokens: 2_000,
        outputTokens: 678,
        contextTokens: 50_000,
        modelContextWindow: 200_000,
        estimatedCostUsd: 0.1234,
        rateLimit: { usedPercent: 41.6, label: "weekly" },
      },
      "claude-fable-5:high",
    )
    const lines = buildUsageOverlayLines(state)
    expect(lines.map((line) => line.label)).toEqual([
      "Model",
      "Input tokens",
      "Output tokens",
      "Total tokens",
      "Context left",
      "Estimated cost",
      "Rate limit",
    ])
    const byLabel = Object.fromEntries(lines.map((line) => [line.label, line.value]))
    expect(byLabel.Model).toBe("claude-fable-5:high")
    expect(byLabel["Input tokens"]).toBe("12,345 (2,000 cached)")
    expect(byLabel["Output tokens"]).toBe("678")
    expect(byLabel["Total tokens"]).toBe("13,023")
    expect(byLabel["Context left"]).toBe("75% of 200,000 tokens")
    expect(byLabel["Estimated cost"]).toBe("$0.1234 (estimated)")
    expect(byLabel["Rate limit"]).toBe("weekly limit 42% used")
  })

  test("prefers the engine-reported total over the input+output sum", () => {
    const lines = buildUsageOverlayLines(stateWith({ inputTokens: 100, outputTokens: 50, totalTokens: 400 }))
    expect(lines.find((line) => line.label === "Total tokens")?.value).toBe("400")
  })

  test("renders placeholders before any usage arrives and omits the rate-limit line", () => {
    const lines = buildUsageOverlayLines(stateWith({}))
    const byLabel = Object.fromEntries(lines.map((line) => [line.label, line.value]))
    expect(byLabel.Model).toBe("engine default")
    expect(byLabel["Input tokens"]).toBe("—")
    expect(byLabel["Total tokens"]).toBe("—")
    expect(byLabel["Context left"]).toBe("unknown")
    expect(byLabel["Estimated cost"]).toBe("not reported")
    expect(lines.some((line) => line.label === "Rate limit")).toBe(false)
    // Key material must never surface in the overlay.
    expect(JSON.stringify(lines)).not.toMatch(/api[-_]?key|sk-/i)
  })
})

describe("codesplash resume wiring", () => {
  test("the transcript lives next to the session's event log", () => {
    expect(sessionTranscriptPath("/data/sessions/proj/local-1")).toBe(
      "/data/sessions/proj/local-1/transcript.jsonl",
    )
  })

  test("replayed cumulative usage is snapshotted for the resumed engine session", () => {
    // The engine seeds its counters from this so a resumed session's usage never restarts at 0.
    expect(
      usageSnapshotOf(
        stateWith({
          inputTokens: 1200,
          cachedInputTokens: 100,
          outputTokens: 40,
          contextTokens: 900,
          modelContextWindow: 200_000,
          estimatedCostUsd: 0.5,
          hasUnpricedUsage: false,
        }),
      ),
    ).toEqual({
      inputTokens: 1200,
      cachedInputTokens: 100,
      outputTokens: 40,
      estimatedCostUsd: 0.5,
      hasUnpricedUsage: false,
    })
    expect(usageSnapshotOf(stateWith({}))).toBeUndefined()
  })
})
