import { describe, expect, test } from "bun:test"
import type { AgentEvent, SessionPolicy } from "../../../src/core/index.ts"
import type {
  HarnessTool,
  ModelInfo,
  ProviderClient,
  ProviderRequest,
  ProviderStreamEvent,
  ToolOutcome,
  ToolPermission,
} from "../../../src/engines/codesplash/contracts.ts"
import { ProviderHttpError } from "../../../src/engines/codesplash/contracts.ts"
import {
  APPROVAL_CHOICES,
  CodesplashEventFactory,
  CodesplashLoop,
  MAX_TOOL_ROUNDS,
  type TurnRequest,
} from "../../../src/engines/codesplash/loop.ts"
import { askUserTool } from "../../../src/engines/codesplash/tools/question.ts"
import { createToolRegistry } from "../../../src/engines/codesplash/tools/registry.ts"

const MODEL: ModelInfo = {
  id: "test-model",
  displayName: "Test Model",
  provider: "anthropic",
  protocol: "anthropic",
  contextWindow: 200_000,
  maxOutputTokens: 1_000,
  isDefault: true,
  supportsReasoning: true,
}

const POLICY: SessionPolicy = { sandbox: "workspace-write", approvalPolicy: "on-request" }

type Script = ProviderStreamEvent[] | ((signal: AbortSignal) => AsyncIterable<ProviderStreamEvent>)

function scriptedProvider(scripts: Script[]): ProviderClient & { requests: ProviderRequest[] } {
  const remaining = [...scripts]
  const requests: ProviderRequest[] = []
  return {
    id: "anthropic",
    models: [MODEL],
    requests,
    stream(request, signal) {
      requests.push(request)
      const script = remaining.shift()
      if (!script) throw new Error("scripted provider ran out of responses")
      if (typeof script === "function") return script(signal)
      return (async function* () {
        for (const event of script) yield event
      })()
    },
  }
}

/** A provider that answers every request with the same response events. */
function repeatingProvider(makeEvents: (call: number) => ProviderStreamEvent[]): ProviderClient & {
  requests: ProviderRequest[]
} {
  const requests: ProviderRequest[] = []
  return {
    id: "anthropic",
    models: [MODEL],
    requests,
    stream(request) {
      requests.push(request)
      const events = makeEvents(requests.length)
      return (async function* () {
        for (const event of events) yield event
      })()
    },
  }
}

function fakeTool(options: {
  name: string
  readOnly?: boolean
  permission?: ToolPermission
  run?: HarnessTool["run"]
}): HarnessTool & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    name: options.name,
    description: `fake ${options.name}`,
    inputSchema: { type: "object" },
    calls,
    isReadOnly: () => options.readOnly ?? false,
    permission: () => options.permission ?? { kind: "none" },
    run: async (input, context) => {
      calls.push(input)
      if (options.run) return options.run(input, context)
      return { text: `${options.name} ok`, label: `${options.name} label` } satisfies ToolOutcome
    },
  }
}

function makeLoop(
  options: {
    tools?: HarnessTool[]
    firstSequence?: number
    maxToolRounds?: number
    collectDiff?: (cwd: string, paths: string[]) => Promise<string>
  } = {},
) {
  const events: AgentEvent[] = []
  const loop = new CodesplashLoop({
    cwd: "/tmp/harness-test",
    policy: POLICY,
    registry: createToolRegistry(options.tools ?? []),
    events: new CodesplashEventFactory("session-1", options.firstSequence ?? 0),
    emit: (event) => events.push(event),
    maxToolRounds: options.maxToolRounds,
    collectDiff: options.collectDiff ?? (async () => ""),
  })
  return { loop, events }
}

function turnRequest(provider: ProviderClient, userText = "do the thing"): TurnRequest {
  return {
    provider,
    model: MODEL,
    reasoningEffort: "medium",
    system: "system prompt",
    userText,
    userContent: [{ type: "text", text: userText }],
  }
}

function ofKind<K extends AgentEvent["kind"]>(
  events: AgentEvent[],
  kind: K,
): Extract<AgentEvent, { kind: K }>[] {
  return events.filter((event): event is Extract<AgentEvent, { kind: K }> => event.kind === kind)
}

function expectEnvelope(events: AgentEvent[], firstSequence = 0): void {
  expect(events.length).toBeGreaterThan(0)
  for (const [index, event] of events.entries()) {
    expect(event.engine).toBe("codesplash")
    expect(event.localSessionId).toBe("session-1")
    expect(event.schemaVersion).toBe(1)
    expect(event.sequence).toBe(firstSequence + index)
  }
}

async function until<T>(get: () => T | undefined, label: string, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = get()
    if (value !== undefined) return value
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

describe("CodesplashLoop text turns", () => {
  test("streams a text turn with stable per-response ids and records history", async () => {
    const provider = scriptedProvider([
      [
        { type: "reasoning_delta", text: "thinking " },
        { type: "reasoning_delta", text: "hard" },
        { type: "text_delta", text: "Hel" },
        { type: "text_delta", text: "lo" },
        { type: "usage", usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 } },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const { loop, events } = makeLoop()
    await loop.runTurn(turnRequest(provider, "hi there"))

    expect(events.map((event) => event.kind)).toEqual([
      "user.message",
      "turn.started",
      "reasoning.delta",
      "reasoning.delta",
      "message.delta",
      "message.delta",
      "usage.updated",
      "reasoning.completed",
      "message.completed",
      "turn.completed",
    ])

    const userMessages = ofKind(events, "user.message")
    expect(userMessages[0]?.payload.text).toBe("hi there")

    const deltas = ofKind(events, "message.delta")
    expect(deltas).toHaveLength(2)
    expect(deltas[0]?.payload.id).toBe(deltas[1]?.payload.id ?? "")
    const completed = ofKind(events, "message.completed")
    expect(completed[0]?.payload.id).toBe(deltas[0]?.payload.id ?? "")
    expect(completed[0]?.payload.text).toBe("Hello")

    const reasoningDeltas = ofKind(events, "reasoning.delta")
    expect(reasoningDeltas[0]?.payload.id).toBe(reasoningDeltas[1]?.payload.id ?? "")
    expect(reasoningDeltas[0]?.payload.id).not.toBe(deltas[0]?.payload.id ?? "")
    expect(ofKind(events, "reasoning.completed")[0]?.payload.text).toBe("thinking hard")

    const usage = ofKind(events, "usage.updated")
    expect(usage[0]?.payload).toEqual({
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 5,
      contextTokens: 17,
      modelContextWindow: 200_000,
      // MODEL has no pricing: cost is still emitted (0) and the loop flags the usage unpriced.
      estimatedCostUsd: 0,
      hasUnpricedUsage: true,
    })

    expect(ofKind(events, "turn.completed")[0]?.payload.status).toBe("completed")
    expect(loop.history).toEqual([
      { role: "user", content: [{ type: "text", text: "hi there" }] },
      { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    ])
    expectEnvelope(events)
  })

  test("sequence numbering starts at firstSequence and stays monotonic", async () => {
    const provider = scriptedProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const { loop, events } = makeLoop({ firstSequence: 41 })
    await loop.runTurn(turnRequest(provider))
    expectEnvelope(events, 41)
    expect(events[0]?.sequence).toBe(41)
  })

  test("max_tokens completes the turn with a warning", async () => {
    const provider = scriptedProvider([
      [
        { type: "text_delta", text: "partial" },
        { type: "done", stopReason: "max_tokens" },
      ],
    ])
    const { loop, events } = makeLoop()
    await loop.runTurn(turnRequest(provider))
    expect(ofKind(events, "warning")[0]?.payload.message).toContain("output token limit")
    expect(ofKind(events, "turn.completed")[0]?.payload.status).toBe("completed")
  })

  test("max_tokens with collected tool calls settles them as isError results so history stays valid", async () => {
    const tool = fakeTool({ name: "spin", readOnly: true })
    const provider = scriptedProvider([
      [
        { type: "text_delta", text: "partial" },
        { type: "tool_call", id: "call-1", name: "spin", input: {} },
        { type: "done", stopReason: "max_tokens" },
      ],
    ])
    const { loop, events } = makeLoop({ tools: [tool] })
    await loop.runTurn(turnRequest(provider))

    expect(tool.calls).toHaveLength(0)
    expect(ofKind(events, "warning")[0]?.payload.message).toContain("output token limit")
    expect(ofKind(events, "turn.completed")[0]?.payload.status).toBe("completed")

    // Every tool_call left in history carries a matching result; otherwise both providers
    // reject the next request and the session is permanently wedged.
    const last = loop.history.at(-1)
    expect(last?.role).toBe("user")
    const result = last?.content[0]
    expect(result?.type).toBe("tool_result")
    if (result?.type === "tool_result") {
      expect(result.toolCallId).toBe("call-1")
      expect(result.isError).toBe(true)
      expect(result.text).toContain("output token limit")
    }
  })

  test("thinking blocks are stored in history ahead of tool calls and replayed next round", async () => {
    const tool = fakeTool({ name: "probe", readOnly: true })
    const provider = scriptedProvider([
      [
        { type: "reasoning_delta", text: "hmm" },
        { type: "thinking", text: "hmm", signature: "sig-1" },
        { type: "tool_call", id: "call-1", name: "probe", input: {} },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const { loop } = makeLoop({ tools: [tool] })
    await loop.runTurn(turnRequest(provider))

    expect(loop.history[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", text: "hmm", signature: "sig-1" },
        { type: "tool_call", id: "call-1", name: "probe", input: {} },
      ],
    })
    // The follow-up request replays the stored history with the thinking block first — the
    // shape Anthropic requires for tool continuations under extended thinking.
    expect(provider.requests[1]?.messages[1]?.content[0]).toEqual({
      type: "thinking",
      text: "hmm",
      signature: "sig-1",
    })
  })
})

describe("CodesplashLoop tool rounds", () => {
  test("tool round-trip with approval accept runs the tool and diffs mutated paths", async () => {
    const tool = fakeTool({
      name: "write_thing",
      permission: { kind: "approval", title: "Apply file changes?", detail: "/tmp/harness-test/x.txt" },
      run: async () => ({
        text: "Wrote 5 bytes to /tmp/harness-test/x.txt",
        label: "write_thing /tmp/harness-test/x.txt",
        mutatedPaths: ["/tmp/harness-test/x.txt"],
      }),
    })
    const diffCalls: string[][] = []
    const provider = scriptedProvider([
      [
        { type: "tool_call", id: "call-1", name: "write_thing", input: { path: "/tmp/harness-test/x.txt" } },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "Done." },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const { loop, events } = makeLoop({
      tools: [tool],
      collectDiff: async (_cwd, paths) => {
        diffCalls.push(paths)
        return "diff --git a/x.txt b/x.txt\n+hello\n"
      },
    })

    const turn = loop.runTurn(turnRequest(provider))
    const request = await until(() => ofKind(events, "request.opened")[0], "request.opened")
    expect(request.payload).toEqual({
      id: request.payload.id,
      requestKind: "approval",
      title: "Apply file changes?",
      detail: "/tmp/harness-test/x.txt",
      choices: [...APPROVAL_CHOICES],
    })
    expect(tool.calls).toHaveLength(0)

    loop.resolveRequest(request.payload.id, "accept")
    await turn

    expect(ofKind(events, "request.resolved")[0]?.payload).toEqual({
      id: request.payload.id,
      decision: "accept",
    })
    const items = ofKind(events, "item.updated")
    expect(items[0]?.payload.status).toBe("running")
    expect(items[1]?.payload).toEqual({
      id: "call-1",
      label: "write_thing /tmp/harness-test/x.txt",
      output: "Wrote 5 bytes to /tmp/harness-test/x.txt",
      status: "completed",
    })
    expect(diffCalls).toEqual([["/tmp/harness-test/x.txt"]])
    const diff = ofKind(events, "diff.updated")[0]
    expect(diff?.payload.path).toBe("/tmp/harness-test/x.txt")
    expect(diff?.payload.unified).toContain("+hello")

    expect(tool.calls).toHaveLength(1)
    expect(loop.history).toHaveLength(4)
    expect(loop.history[1]).toEqual({
      role: "assistant",
      content: [
        { type: "tool_call", id: "call-1", name: "write_thing", input: { path: "/tmp/harness-test/x.txt" } },
      ],
    })
    expect(loop.history[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", toolCallId: "call-1", text: "Wrote 5 bytes to /tmp/harness-test/x.txt" },
      ],
    })
    expect(ofKind(events, "turn.completed")[0]?.payload.status).toBe("completed")
    expectEnvelope(events)
  })

  test("decline produces an isError tool_result without running the tool", async () => {
    const tool = fakeTool({
      name: "write_thing",
      permission: { kind: "approval", title: "Apply file changes?", detail: "/tmp/x" },
    })
    const provider = scriptedProvider([
      [
        { type: "tool_call", id: "call-1", name: "write_thing", input: {} },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "Understood." },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const { loop, events } = makeLoop({ tools: [tool] })

    const turn = loop.runTurn(turnRequest(provider))
    const request = await until(() => ofKind(events, "request.opened")[0], "request.opened")
    loop.resolveRequest(request.payload.id, "decline")
    await turn

    expect(tool.calls).toHaveLength(0)
    const result = loop.history[2]?.content[0]
    expect(result).toEqual({
      type: "tool_result",
      toolCallId: "call-1",
      text: "The user declined the request to run write_thing.",
      isError: true,
    })
    const items = ofKind(events, "item.updated")
    expect(items[1]?.payload.status).toBe("failed")
    expect(items[1]?.payload.output).toContain("The user declined")
    expect(ofKind(events, "turn.completed")[0]?.payload.status).toBe("completed")
  })

  test("acceptForSession caches by sessionKey and skips the next approval", async () => {
    const tool = fakeTool({
      name: "bash_like",
      permission: { kind: "approval", title: "Run command?", detail: "ls\n/tmp", sessionKey: "bash:ls" },
    })
    const provider = scriptedProvider([
      [
        { type: "tool_call", id: "call-1", name: "bash_like", input: { command: "ls" } },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "tool_call", id: "call-2", name: "bash_like", input: { command: "ls -la" } },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const { loop, events } = makeLoop({ tools: [tool] })

    const turn = loop.runTurn(turnRequest(provider))
    const request = await until(() => ofKind(events, "request.opened")[0], "request.opened")
    loop.resolveRequest(request.payload.id, "acceptForSession")
    await turn

    expect(tool.calls).toHaveLength(2)
    expect(ofKind(events, "request.opened")).toHaveLength(1)
    expect(ofKind(events, "request.resolved")[0]?.payload.decision).toBe("acceptForSession")
  })

  test("ask_user opens a user-input request whose decision becomes the tool result", async () => {
    const provider = scriptedProvider([
      [
        {
          type: "tool_call",
          id: "call-ask",
          name: "ask_user",
          input: { question: "Deploy to production?", options: ["Yes", "No"] },
        },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "Deploying." },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const { loop, events } = makeLoop({ tools: [askUserTool] })

    const turn = loop.runTurn(turnRequest(provider))
    const request = await until(() => ofKind(events, "request.opened")[0], "request.opened")
    expect(request.payload.requestKind).toBe("user-input")
    expect(request.payload.title).toBe("Deploy to production?")
    expect(request.payload.choices).toEqual(["Yes", "No"])

    loop.resolveRequest(request.payload.id, "Yes")
    await turn

    expect(ofKind(events, "request.resolved")[0]?.payload.decision).toBe("Yes")
    expect(loop.history[2]?.content[0]).toEqual({
      type: "tool_result",
      toolCallId: "call-ask",
      text: "The user chose: Yes",
    })
    const items = ofKind(events, "item.updated")
    expect(items.at(-1)?.payload.status).toBe("completed")
    expect(items.at(-1)?.payload.output).toBe("Yes")
  })

  test("invalid ask_user input becomes an isError result without opening a request", async () => {
    const provider = scriptedProvider([
      [
        {
          type: "tool_call",
          id: "call-ask",
          name: "ask_user",
          input: { question: "Hm?", options: ["only-one"] },
        },
        { type: "done", stopReason: "tool_use" },
      ],
      [{ type: "done", stopReason: "end_turn" }],
    ])
    const { loop, events } = makeLoop({ tools: [askUserTool] })
    await loop.runTurn(turnRequest(provider))

    expect(ofKind(events, "request.opened")).toHaveLength(0)
    const result = loop.history[2]?.content[0]
    expect(result?.type).toBe("tool_result")
    if (result?.type === "tool_result") {
      expect(result.isError).toBe(true)
      expect(result.text).toContain("between 2 and 6")
    }
  })

  test("unknown tools produce isError results and the turn continues", async () => {
    const provider = scriptedProvider([
      [
        { type: "tool_call", id: "call-1", name: "nope", input: {} },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "sorry" },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const { loop, events } = makeLoop()
    await loop.runTurn(turnRequest(provider))

    expect(loop.history[2]?.content[0]).toEqual({
      type: "tool_result",
      toolCallId: "call-1",
      text: "Unknown tool: nope",
      isError: true,
    })
    expect(ofKind(events, "item.updated")[0]?.payload.status).toBe("failed")
    expect(ofKind(events, "turn.completed")[0]?.payload.status).toBe("completed")
  })

  test("todo planSteps become plan.updated", async () => {
    const tool = fakeTool({
      name: "todo_write",
      readOnly: true,
      run: async () => ({
        text: "Plan updated",
        label: "Plan: 1/2 steps complete",
        planSteps: [
          { text: "a", completed: true },
          { text: "b", completed: false },
        ],
      }),
    })
    const provider = scriptedProvider([
      [
        { type: "tool_call", id: "call-1", name: "todo_write", input: { todos: [] } },
        { type: "done", stopReason: "tool_use" },
      ],
      [{ type: "done", stopReason: "end_turn" }],
    ])
    const { loop, events } = makeLoop({ tools: [tool] })
    await loop.runTurn(turnRequest(provider))
    expect(ofKind(events, "plan.updated")[0]?.payload.steps).toEqual([
      { text: "a", completed: true },
      { text: "b", completed: false },
    ])
  })
})

describe("CodesplashLoop concurrency", () => {
  test("read-only calls overlap up to the cap of 4", async () => {
    let active = 0
    let maxActive = 0
    const spans: Array<{ start: number; end: number }> = []
    const tool = fakeTool({
      name: "probe",
      readOnly: true,
      run: async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        const start = Date.now()
        await Bun.sleep(20)
        active -= 1
        spans.push({ start, end: Date.now() })
        return { text: "ok", label: "probe" }
      },
    })
    // Distinct inputs: identical repeated calls would (correctly) trip doom-loop detection.
    const calls: ProviderStreamEvent[] = Array.from({ length: 6 }, (_, index) => ({
      type: "tool_call",
      id: `call-${index}`,
      name: "probe",
      input: { index },
    }))
    const provider = scriptedProvider([
      [...calls, { type: "done", stopReason: "tool_use" }],
      [{ type: "done", stopReason: "end_turn" }],
    ])
    const { loop } = makeLoop({ tools: [tool] })
    await loop.runTurn(turnRequest(provider))

    expect(tool.calls).toHaveLength(6)
    expect(maxActive).toBe(4)
    const first = spans[0]
    const second = spans[1]
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    if (first && second) {
      expect(Math.max(first.start, second.start)).toBeLessThan(Math.min(first.end, second.end) + 1)
    }
  })

  test("a mutating call is a barrier: a later read-only call waits for it in order", async () => {
    const order: string[] = []
    const readTool = fakeTool({
      name: "read_thing",
      readOnly: true,
      run: async () => {
        order.push("read")
        return { text: "r", label: "read" }
      },
    })
    const editTool = fakeTool({
      name: "edit_thing",
      run: async () => {
        order.push("edit-start")
        await Bun.sleep(20)
        order.push("edit-done")
        return { text: "e", label: "edit" }
      },
    })
    const provider = scriptedProvider([
      [
        { type: "tool_call", id: "call-1", name: "edit_thing", input: {} },
        { type: "tool_call", id: "call-2", name: "read_thing", input: {} },
        { type: "done", stopReason: "tool_use" },
      ],
      [{ type: "done", stopReason: "end_turn" }],
    ])
    const { loop } = makeLoop({ tools: [readTool, editTool] })
    await loop.runTurn(turnRequest(provider))

    // The read must observe post-edit state: results are returned in call order, so running
    // it early would hand the model stale content it believes is fresh.
    expect(order).toEqual(["edit-start", "edit-done", "read"])
    const results = loop.history[2]?.content
    expect(results?.map((block) => (block.type === "tool_result" ? block.toolCallId : block.type))).toEqual([
      "call-1",
      "call-2",
    ])
  })

  test("mutating calls run sequentially", async () => {
    let active = 0
    let maxActive = 0
    const tool = fakeTool({
      name: "mutate",
      run: async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await Bun.sleep(10)
        active -= 1
        return { text: "ok", label: "mutate" }
      },
    })
    const provider = scriptedProvider([
      [
        { type: "tool_call", id: "call-1", name: "mutate", input: {} },
        { type: "tool_call", id: "call-2", name: "mutate", input: {} },
        { type: "done", stopReason: "tool_use" },
      ],
      [{ type: "done", stopReason: "end_turn" }],
    ])
    const { loop } = makeLoop({ tools: [tool] })
    await loop.runTurn(turnRequest(provider))
    expect(tool.calls).toHaveLength(2)
    expect(maxActive).toBe(1)
  })
})

describe("CodesplashLoop interrupts and limits", () => {
  test("interrupt mid-stream aborts the provider and completes the turn interrupted", async () => {
    const provider = scriptedProvider([
      (signal) =>
        (async function* () {
          yield { type: "text_delta", text: "Par" } as const
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve()
            signal.addEventListener("abort", () => resolve(), { once: true })
          })
          yield { type: "done", stopReason: "aborted" } as const
        })(),
    ])
    const { loop, events } = makeLoop()

    const turn = loop.runTurn(turnRequest(provider))
    await until(() => ofKind(events, "message.delta")[0], "first delta")
    expect(loop.isTurnActive).toBe(true)
    loop.interrupt()
    await turn

    expect(ofKind(events, "message.completed")[0]?.payload.text).toBe("Par")
    expect(ofKind(events, "turn.completed")[0]?.payload.status).toBe("interrupted")
    expect(loop.history.at(-1)).toEqual({ role: "assistant", content: [{ type: "text", text: "Par" }] })
    expect(loop.isTurnActive).toBe(false)
    expectEnvelope(events)
  })

  test("interrupt while an approval is pending cancels the request and the turn", async () => {
    const tool = fakeTool({
      name: "write_thing",
      permission: { kind: "approval", title: "Apply file changes?", detail: "/tmp/x" },
    })
    const provider = scriptedProvider([
      [
        { type: "tool_call", id: "call-1", name: "write_thing", input: {} },
        { type: "done", stopReason: "tool_use" },
      ],
    ])
    const { loop, events } = makeLoop({ tools: [tool] })

    const turn = loop.runTurn(turnRequest(provider))
    const request = await until(() => ofKind(events, "request.opened")[0], "request.opened")
    loop.interrupt()
    await turn

    expect(ofKind(events, "request.resolved")[0]?.payload).toEqual({
      id: request.payload.id,
      decision: "cancel",
    })
    expect(tool.calls).toHaveLength(0)
    const result = loop.history[2]?.content[0]
    expect(result?.type).toBe("tool_result")
    if (result?.type === "tool_result") expect(result.isError).toBe(true)
    expect(ofKind(events, "turn.completed")[0]?.payload.status).toBe("interrupted")
  })

  test("forces the turn to end after the maximum tool rounds", async () => {
    const tool = fakeTool({ name: "spin", readOnly: true })
    // Distinct inputs per round: identical calls would trip doom-loop detection long before the cap.
    const provider = repeatingProvider((call) => [
      { type: "tool_call", id: `call-${call}`, name: "spin", input: { call } },
      { type: "done", stopReason: "tool_use" },
    ])
    const { loop, events } = makeLoop({ tools: [tool] })
    await loop.runTurn(turnRequest(provider))

    expect(tool.calls).toHaveLength(MAX_TOOL_ROUNDS)
    expect(provider.requests).toHaveLength(MAX_TOOL_ROUNDS + 1)
    const warning = ofKind(events, "warning")[0]
    expect(warning?.payload.message).toContain(`${MAX_TOOL_ROUNDS} tool rounds`)
    expect(ofKind(events, "turn.completed")[0]?.payload.status).toBe("completed")

    const lastMessage = loop.history.at(-1)
    expect(lastMessage?.role).toBe("user")
    const lastResult = lastMessage?.content[0]
    expect(lastResult?.type).toBe("tool_result")
    if (lastResult?.type === "tool_result") {
      expect(lastResult.isError).toBe(true)
      expect(lastResult.text).toContain("limit")
    }
    expectEnvelope(events)
  })

  test("a smaller maxToolRounds override is honored", async () => {
    const tool = fakeTool({ name: "spin", readOnly: true })
    const provider = repeatingProvider((call) => [
      { type: "tool_call", id: `call-${call}`, name: "spin", input: {} },
      { type: "done", stopReason: "tool_use" },
    ])
    const { loop, events } = makeLoop({ tools: [tool], maxToolRounds: 2 })
    await loop.runTurn(turnRequest(provider))
    expect(tool.calls).toHaveLength(2)
    expect(ofKind(events, "warning")[0]?.payload.message).toContain("2 tool rounds")
  })
})

describe("CodesplashLoop provider errors", () => {
  test("ProviderHttpError surfaces as a recoverable error event and a failed turn", async () => {
    const provider = scriptedProvider([
      () =>
        (async function* () {
          yield { type: "text_delta", text: "oops " } as const
          throw new ProviderHttpError("anthropic: HTTP 500", 500)
        })(),
    ])
    const { loop, events } = makeLoop()
    await loop.runTurn(turnRequest(provider))

    const error = ofKind(events, "error")[0]
    expect(error?.payload.recoverable).toBe(true)
    expect(error?.payload.message).toContain("HTTP 500")
    expect(ofKind(events, "message.completed")[0]?.payload.text).toBe("oops ")
    expect(ofKind(events, "turn.completed")[0]?.payload.status).toBe("failed")
  })

  test("non-HTTP provider failures are not recoverable", async () => {
    const provider = scriptedProvider([
      () =>
        (async function* () {
          if (Math.random() < 2) throw new Error("connection reset by fairies")
          yield { type: "done", stopReason: "end_turn" } as const
        })(),
    ])
    const { loop, events } = makeLoop()
    await loop.runTurn(turnRequest(provider))
    const error = ofKind(events, "error")[0]
    expect(error?.payload.recoverable).toBe(false)
    expect(error?.payload.message).toContain("fairies")
    expect(ofKind(events, "turn.completed")[0]?.payload.status).toBe("failed")
  })

  test("the loop can run a fresh turn after a failed one", async () => {
    const failing = scriptedProvider([
      () =>
        (async function* () {
          if (Math.random() < 2) throw new ProviderHttpError("boom", 503)
          yield { type: "done", stopReason: "end_turn" } as const
        })(),
      [
        { type: "text_delta", text: "recovered" },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const { loop, events } = makeLoop()
    await loop.runTurn(turnRequest(failing, "first"))
    await loop.runTurn(turnRequest(failing, "second"))

    const completions = ofKind(events, "turn.completed")
    expect(completions.map((event) => event.payload.status)).toEqual(["failed", "completed"])
    expect(ofKind(events, "message.completed")[0]?.payload.text).toBe("recovered")
    expectEnvelope(events)
  })
})
