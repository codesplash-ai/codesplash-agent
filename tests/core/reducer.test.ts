import { describe, expect, test } from "bun:test"
import { createAgentEvent } from "../../src/core/events.ts"
import { initialAppViewState, reduceAgentEvent } from "../../src/core/reducer.ts"

const base = { engine: "codex" as const, localSessionId: "local-1" }

describe("reduceAgentEvent", () => {
  test("coalesces message deltas and completes the message", () => {
    let state = initialAppViewState
    state = reduceAgentEvent(
      state,
      createAgentEvent(
        { ...base, sequence: 0 },
        { kind: "message.delta", payload: { id: "m1", text: "Hello" } },
      ),
    )
    state = reduceAgentEvent(
      state,
      createAgentEvent(
        { ...base, sequence: 1 },
        { kind: "message.delta", payload: { id: "m1", text: " world" } },
      ),
    )
    state = reduceAgentEvent(
      state,
      createAgentEvent({ ...base, sequence: 2 }, { kind: "message.completed", payload: { id: "m1" } }),
    )

    expect(state.transcript).toEqual([
      { id: "m1", kind: "message", text: "Hello world", status: "completed" },
    ])
  })

  test("ignores duplicate and out-of-order events", () => {
    const state = reduceAgentEvent(
      initialAppViewState,
      createAgentEvent({ ...base, sequence: 3 }, { kind: "warning", payload: { message: "first" } }),
    )
    const unchanged = reduceAgentEvent(
      state,
      createAgentEvent({ ...base, sequence: 2 }, { kind: "warning", payload: { message: "stale" } }),
    )

    expect(unchanged).toBe(state)
  })

  test("tracks approval request lifecycle", () => {
    let state = reduceAgentEvent(
      initialAppViewState,
      createAgentEvent(
        { ...base, sequence: 0 },
        {
          kind: "request.opened",
          payload: {
            id: "approval-1",
            requestKind: "approval",
            title: "Run command?",
            detail: "bun test",
            choices: ["accept", "decline"],
          },
        },
      ),
    )

    expect(state.pendingRequest?.id).toBe("approval-1")
    expect(state.sessionStatus).toBe("waiting")

    state = reduceAgentEvent(
      state,
      createAgentEvent(
        { ...base, sequence: 1 },
        { kind: "request.resolved", payload: { id: "approval-1", decision: "decline" } },
      ),
    )

    expect(state.pendingRequest).toBeUndefined()
  })
})
