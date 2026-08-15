import { describe, expect, test } from "bun:test"
import { initialAppViewState, reduceAgentEvent } from "../../../src/core/index.ts"
import type { JsonRpcNotification } from "../../../src/engines/codex/json-rpc.ts"
import { CodexEventNormalizer } from "../../../src/engines/codex/normalize.ts"

const fixture = new URL("../../fixtures/codex/live-turn-redacted.jsonl", import.meta.url)

describe("CodexEventNormalizer", () => {
  test("replays the redacted 0.147.0 live-turn fixture into provider-independent view state", async () => {
    const source = await Bun.file(fixture).text()
    const notifications = source
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonRpcNotification)
    const normalizer = new CodexEventNormalizer("local-fixture")
    const events = notifications.flatMap((notification) => normalizer.normalize(notification))
    const state = events.reduce(reduceAgentEvent, initialAppViewState)

    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index))
    expect(state.turnStatus).toBe("completed")
    expect(state.transcript.find((item) => item.kind === "message")?.text).toBe("The workspace is ready.")
    expect(state.transcript.some((item) => item.kind === "tool" && item.label === "pwd")).toBe(true)
    expect(state.transcript.some((item) => item.kind === "diff")).toBe(true)
    expect(state.transcript.find((item) => item.kind === "reasoning")).toMatchObject({
      text: "Inspecting the workspace.",
      status: "completed",
    })
    expect(state.usage).toMatchObject({
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 12,
      contextTokens: 132,
      totalTokens: 132,
      modelContextWindow: 258_400,
    })
  })
})
