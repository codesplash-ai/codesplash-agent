/**
 * Phase-2 loop behavior: session-cumulative cost accounting, doom-loop detection, turn fallback
 * on zero-event provider failures, and history seeding for resume.
 */
import { describe, expect, test } from "bun:test"
import type { AgentEvent, SessionPolicy } from "../../../src/core/index.ts"
import type {
  ChatMessage,
  HarnessTool,
  ModelInfo,
  ProviderClient,
  ProviderRequest,
  ProviderStreamEvent,
  ToolOutcome,
} from "../../../src/engines/codesplash/contracts.ts"
import { ProviderHttpError } from "../../../src/engines/codesplash/contracts.ts"
import {
  CodesplashEventFactory,
  CodesplashLoop,
  type ResolvedModel,
  type TurnRequest,
} from "../../../src/engines/codesplash/loop.ts"
import { createToolRegistry } from "../../../src/engines/codesplash/tools/registry.ts"

const POLICY: SessionPolicy = { sandbox: "workspace-write", approvalPolicy: "on-request" }

function model(overrides: Partial<ModelInfo> & { id: string }): ModelInfo {
  return {
    displayName: overrides.id,
    provider: "anthropic",
    protocol: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 1_000,
    isDefault: false,
    supportsReasoning: true,
    ...overrides,
  }
}

/** cachedInputPerMTok omitted: the loop must default it to inputPerMTok / 10 (= 1). */
const PRICED_MODEL = model({ id: "priced-model", pricing: { inputPerMTok: 10, outputPerMTok: 20 } })
const EXPLICIT_CACHE_MODEL = model({
  id: "explicit-cache-model",
  pricing: { inputPerMTok: 10, outputPerMTok: 20, cachedInputPerMTok: 5 },
})
const UNPRICED_MODEL = model({ id: "unpriced-model" })
const PRIMARY_MODEL = model({ id: "primary-model", pricing: { inputPerMTok: 10, outputPerMTok: 20 } })
const FALLBACK_MODEL = model({ id: "fallback-model", pricing: { inputPerMTok: 1, outputPerMTok: 2 } })

type Script = ProviderStreamEvent[] | ((signal: AbortSignal) => AsyncIterable<ProviderStreamEvent>)

function scriptedProvider(scripts: Script[]): ProviderClient & { requests: ProviderRequest[] } {
  const remaining = [...scripts]
  const requests: ProviderRequest[] = []
  return {
    id: "anthropic",
    models: [],
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

/** A provider that answers every request from the same script factory. */
function repeatingProvider(makeEvents: (call: number) => ProviderStreamEvent[]): ProviderClient & {
  requests: ProviderRequest[]
} {
  const requests: ProviderRequest[] = []
  return {
    id: "anthropic",
    models: [],
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

/** An adapter whose every stream attempt throws before emitting any event. */
function failingProvider(makeError: () => Error): ProviderClient & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = []
  return {
    id: "anthropic",
    models: [],
    requests,
    stream(request) {
      requests.push(request)
      return (async function* () {
        if (Math.random() < 2) throw makeError()
        yield { type: "done", stopReason: "end_turn" } as const
      })()
    },
  }
}

function fakeTool(options: {
  name: string
  readOnly?: boolean
  run?: HarnessTool["run"]
}): HarnessTool & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    name: options.name,
    description: `fake ${options.name}`,
    inputSchema: { type: "object" },
    calls,
    isReadOnly: () => options.readOnly ?? false,
    permission: () => ({ kind: "none" }),
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
    fallbackModel?: string
    resolveModel?: (id: string) => ResolvedModel | undefined
    initialUsage?: NonNullable<ConstructorParameters<typeof CodesplashLoop>[0]["initialUsage"]>
  } = {},
) {
  const events: AgentEvent[] = []
  const loop = new CodesplashLoop({
    cwd: "/tmp/harness-test",
    policy: POLICY,
    registry: createToolRegistry(options.tools ?? []),
    events: new CodesplashEventFactory("session-1"),
    emit: (event) => events.push(event),
    collectDiff: async () => "",
    fallbackModel: options.fallbackModel,
    resolveModel: options.resolveModel,
    initialUsage: options.initialUsage,
  })
  return { loop, events }
}

function turnRequest(provider: ProviderClient, turnModel: ModelInfo, userText = "go"): TurnRequest {
  return {
    provider,
    model: turnModel,
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

function toolResults(message: ChatMessage | undefined) {
  return (message?.content ?? []).flatMap((block) => (block.type === "tool_result" ? [block] : []))
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

describe("cost accounting", () => {
  test("a multi-request turn emits session-cumulative tokens and cost with cached pricing", async () => {
    const tool = fakeTool({ name: "probe", readOnly: true })
    const provider = scriptedProvider([
      [
        { type: "tool_call", id: "call-1", name: "probe", input: {} },
        { type: "usage", usage: { inputTokens: 1_000, cachedInputTokens: 500, outputTokens: 100 } },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "usage", usage: { inputTokens: 2_000, outputTokens: 50 } },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const { loop, events } = makeLoop({ tools: [tool] })
    await loop.runTurn(turnRequest(provider, PRICED_MODEL))

    const usage = ofKind(events, "usage.updated")
    expect(usage).toHaveLength(2)
    // Request 1: (1000·10 + 500·1 + 100·20) / 1e6 — cached rate defaults to inputPerMTok / 10.
    expect(usage[0]?.payload.inputTokens).toBe(1_000)
    expect(usage[0]?.payload.cachedInputTokens).toBe(500)
    expect(usage[0]?.payload.outputTokens).toBe(100)
    expect(usage[0]?.payload.contextTokens).toBe(1_600)
    expect(usage[0]?.payload.modelContextWindow).toBe(200_000)
    expect(usage[0]?.payload.estimatedCostUsd).toBeCloseTo(0.0125, 10)
    // Priced-only usage carries an explicit false so $0-priced models are distinguishable.
    expect(usage[0]?.payload.hasUnpricedUsage).toBe(false)
    // Request 2 accumulates: tokens sum across requests, cost adds (2000·10 + 50·20) / 1e6.
    expect(usage[1]?.payload.inputTokens).toBe(3_000)
    expect(usage[1]?.payload.cachedInputTokens).toBe(500)
    expect(usage[1]?.payload.outputTokens).toBe(150)
    // contextTokens keeps per-request semantics: the size of THIS request, not a session sum.
    expect(usage[1]?.payload.contextTokens).toBe(2_050)
    expect(usage[1]?.payload.estimatedCostUsd).toBeCloseTo(0.0335, 10)
    expect(loop.hasUnpricedUsage).toBe(false)
  })

  test("usage accumulates across turns and unpriced models contribute 0 while flagging partial cost", async () => {
    const provider = scriptedProvider([
      [
        { type: "text_delta", text: "one" },
        { type: "usage", usage: { inputTokens: 1_000_000, outputTokens: 0 } },
        { type: "done", stopReason: "end_turn" },
      ],
      [
        { type: "text_delta", text: "two" },
        { type: "usage", usage: { inputTokens: 100, outputTokens: 10 } },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const { loop, events } = makeLoop()
    await loop.runTurn(turnRequest(provider, PRICED_MODEL, "first"))
    expect(loop.hasUnpricedUsage).toBe(false)

    await loop.runTurn(turnRequest(provider, UNPRICED_MODEL, "second"))
    const usage = ofKind(events, "usage.updated")
    expect(usage[0]?.payload.estimatedCostUsd).toBeCloseTo(10, 10)
    // The unpriced model's tokens still accumulate; its cost contribution is 0.
    expect(usage[1]?.payload.inputTokens).toBe(1_000_100)
    expect(usage[1]?.payload.outputTokens).toBe(10)
    expect(usage[1]?.payload.estimatedCostUsd).toBeCloseTo(10, 10)
    expect(usage[1]?.payload.modelContextWindow).toBe(UNPRICED_MODEL.contextWindow)
    expect(loop.hasUnpricedUsage).toBe(true)
  })

  test("initialUsage seeds the cumulative totals so a resumed session continues, not restarts", async () => {
    const provider = scriptedProvider([
      [
        { type: "text_delta", text: "resumed" },
        { type: "usage", usage: { inputTokens: 1_000, outputTokens: 100 } },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const { loop, events } = makeLoop({
      initialUsage: {
        inputTokens: 5_000,
        cachedInputTokens: 200,
        outputTokens: 400,
        estimatedCostUsd: 0.5,
      },
    })
    await loop.runTurn(turnRequest(provider, PRICED_MODEL))

    const usage = ofKind(events, "usage.updated")[0]?.payload
    expect(usage?.inputTokens).toBe(6_000)
    expect(usage?.cachedInputTokens).toBe(200)
    expect(usage?.outputTokens).toBe(500)
    // Prior cost + (1000·10 + 100·20)/1e6 for this request.
    expect(usage?.estimatedCostUsd).toBeCloseTo(0.512, 10)
    // contextTokens keeps per-request semantics even on a resumed session.
    expect(usage?.contextTokens).toBe(1_100)
  })

  test("a seeded hasUnpricedUsage keeps the resumed session's cost labelled partial", async () => {
    const provider = scriptedProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 1 } },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const { loop, events } = makeLoop({ initialUsage: { hasUnpricedUsage: true } })
    await loop.runTurn(turnRequest(provider, PRICED_MODEL))
    expect(loop.hasUnpricedUsage).toBe(true)
    expect(ofKind(events, "usage.updated")[0]?.payload.hasUnpricedUsage).toBe(true)
  })

  test("an explicit cachedInputPerMTok overrides the /10 default", async () => {
    const provider = scriptedProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "usage", usage: { inputTokens: 0, cachedInputTokens: 1_000_000, outputTokens: 0 } },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const { loop, events } = makeLoop()
    await loop.runTurn(turnRequest(provider, EXPLICIT_CACHE_MODEL))
    expect(ofKind(events, "usage.updated")[0]?.payload.estimatedCostUsd).toBeCloseTo(5, 10)
    expect(loop.hasUnpricedUsage).toBe(false)
  })
})

describe("doom-loop detection", () => {
  test("within one round: 3rd and 4th identical calls are synthetic, the 5th force-ends the turn", async () => {
    const tool = fakeTool({ name: "spin", readOnly: true })
    const calls: ProviderStreamEvent[] = Array.from({ length: 5 }, (_, index) => ({
      type: "tool_call",
      id: `call-${index}`,
      name: "spin",
      input: { path: "x" },
    }))
    const provider = scriptedProvider([[...calls, { type: "done", stopReason: "tool_use" }]])
    const { loop, events } = makeLoop({ tools: [tool] })
    await loop.runTurn(turnRequest(provider, PRICED_MODEL))

    expect(tool.calls).toHaveLength(2)
    expect(provider.requests).toHaveLength(1)
    expect(ofKind(events, "warning")[0]?.payload.message).toBe(
      "Repeated tool-call loop detected; ending the turn",
    )
    expect(ofKind(events, "turn.completed")[0]?.payload.status).toBe("completed")

    const results = toolResults(loop.history.at(-1))
    expect(results).toHaveLength(5)
    expect(results[0]?.isError).toBeUndefined()
    expect(results[1]?.isError).toBeUndefined()
    for (const index of [2, 3]) {
      expect(results[index]?.isError).toBe(true)
      expect(results[index]?.text).toBe(
        "This exact call was already made twice with the same result. Change your approach instead of repeating it.",
      )
    }
    expect(results[4]?.isError).toBe(true)
    expect(results[4]?.text).toContain("repeated tool-call loop")
    // The synthetic calls surface in the transcript as failed items.
    const failed = ofKind(events, "item.updated").filter((event) => event.payload.status === "failed")
    expect(failed).toHaveLength(2)
  })

  test("across rounds: the tool runs twice, rounds 3-4 are synthetic, round 5 ends the turn", async () => {
    const tool = fakeTool({ name: "spin", readOnly: true })
    const provider = repeatingProvider((call) => [
      { type: "tool_call", id: `call-${call}`, name: "spin", input: { path: "same" } },
      { type: "done", stopReason: "tool_use" },
    ])
    const { loop, events } = makeLoop({ tools: [tool] })
    await loop.runTurn(turnRequest(provider, PRICED_MODEL))

    expect(tool.calls).toHaveLength(2)
    expect(provider.requests).toHaveLength(5)
    expect(ofKind(events, "warning")[0]?.payload.message).toContain("Repeated tool-call loop")
    expect(ofKind(events, "turn.completed")[0]?.payload.status).toBe("completed")
    const results = toolResults(loop.history.at(-1))
    expect(results[0]?.isError).toBe(true)
    expect(results[0]?.text).toContain("repeated tool-call loop")
  })

  test("a different call resets the counter and key order does not make inputs different", async () => {
    const toolA = fakeTool({ name: "alpha", readOnly: true })
    const toolB = fakeTool({ name: "beta", readOnly: true })
    const provider = scriptedProvider([
      [
        // Canonical JSON: {a,b} and {b,a} are the same call.
        { type: "tool_call", id: "c1", name: "alpha", input: { a: 1, b: 2 } },
        { type: "tool_call", id: "c2", name: "alpha", input: { b: 2, a: 1 } },
        { type: "tool_call", id: "c3", name: "beta", input: { x: 1 } },
        { type: "tool_call", id: "c4", name: "alpha", input: { a: 1, b: 2 } },
        { type: "tool_call", id: "c5", name: "alpha", input: { a: 1, b: 2 } },
        { type: "tool_call", id: "c6", name: "alpha", input: { b: 2, a: 1 } },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "ok" },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const { loop, events } = makeLoop({ tools: [toolA, toolB] })
    await loop.runTurn(turnRequest(provider, PRICED_MODEL))

    // beta resets the run, so only the 6th call (the 3rd consecutive identical alpha) is synthetic.
    expect(toolA.calls).toHaveLength(4)
    expect(toolB.calls).toHaveLength(1)
    const results = toolResults(loop.history[2])
    expect(results[5]?.isError).toBe(true)
    expect(results[5]?.text).toContain("already made twice")
    expect(ofKind(events, "warning")).toHaveLength(0)
    expect(ofKind(events, "turn.completed")[0]?.payload.status).toBe("completed")
  })

  test("failed calls count toward the sequence", async () => {
    const tool = fakeTool({
      name: "flaky",
      readOnly: true,
      run: async () => ({ text: "boom", label: "flaky", isError: true }),
    })
    const provider = scriptedProvider([
      [
        { type: "tool_call", id: "c1", name: "flaky", input: {} },
        { type: "tool_call", id: "c2", name: "flaky", input: {} },
        { type: "tool_call", id: "c3", name: "flaky", input: {} },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "ok" },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const { loop } = makeLoop({ tools: [tool] })
    await loop.runTurn(turnRequest(provider, PRICED_MODEL))

    expect(tool.calls).toHaveLength(2)
    const results = toolResults(loop.history[2])
    expect(results[2]?.text).toContain("already made twice")
  })
})

describe("turn fallback", () => {
  const resolveTo = (fallbackProvider: ProviderClient): ((id: string) => ResolvedModel | undefined) => {
    return (id) =>
      id === "fallback-model" ? { model: FALLBACK_MODEL, provider: fallbackProvider } : undefined
  }

  test("a zero-event failure falls back once, strips thinking blocks, and the next turn reverts", async () => {
    const primary = scriptedProvider([
      () =>
        (async function* () {
          if (Math.random() < 2) throw new ProviderHttpError("anthropic: HTTP 529", 529)
          yield { type: "done", stopReason: "end_turn" } as const
        })(),
      [
        { type: "text_delta", text: "back on primary" },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const fallbackProvider = scriptedProvider([
      [
        { type: "text_delta", text: "saved by fallback" },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const { loop, events } = makeLoop({
      fallbackModel: "fallback-model",
      resolveModel: resolveTo(fallbackProvider),
    })
    loop.seedHistory([
      { role: "user", content: [{ type: "text", text: "earlier" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "hmm", signature: "sig-1" },
          { type: "text", text: "prior answer" },
        ],
      },
      { role: "assistant", content: [{ type: "redacted_thinking", data: "blob" }] },
    ])

    await loop.runTurn(turnRequest(primary, PRIMARY_MODEL, "please"))

    expect(ofKind(events, "warning")[0]?.payload.message).toBe(
      "Provider error on primary-model; falling back to fallback-model",
    )
    expect(ofKind(events, "error")).toHaveLength(0)
    expect(ofKind(events, "message.completed")[0]?.payload.text).toBe("saved by fallback")
    expect(ofKind(events, "turn.completed")[0]?.payload.status).toBe("completed")

    // The retried request went to the fallback model with thinking blocks stripped; the
    // assistant message that was only redacted thinking is dropped entirely.
    expect(primary.requests).toHaveLength(1)
    expect(fallbackProvider.requests).toHaveLength(1)
    const retried = fallbackProvider.requests[0]
    expect(retried?.model.id).toBe("fallback-model")
    expect(retried?.messages).toHaveLength(3)
    expect(retried?.messages[1]?.content).toEqual([{ type: "text", text: "prior answer" }])
    const blocks = (retried?.messages ?? []).flatMap((message) => message.content)
    expect(blocks.some((block) => block.type === "thinking" || block.type === "redacted_thinking")).toBe(
      false,
    )

    // The next turn uses the session's selected model again.
    await loop.runTurn(turnRequest(primary, PRIMARY_MODEL, "again"))
    expect(primary.requests).toHaveLength(2)
    expect(primary.requests[1]?.model.id).toBe("primary-model")
    expect(fallbackProvider.requests).toHaveLength(1)
    expect(ofKind(events, "warning")).toHaveLength(1)
  })

  test("a fallback's thinking-strip never shifts the turn boundary (lastTurnMessages stays intact)", async () => {
    // Seeded history contains an assistant message that is ONLY a thinking block (reachable when
    // max_tokens cut a response mid-thinking). The strip drops it entirely; a length-based
    // pre-turn slice would then skip the turn's own user message when persisting the transcript.
    const primary = failingProvider(() => new ProviderHttpError("anthropic: HTTP 529", 529))
    const fallbackProvider = scriptedProvider([
      [
        { type: "text_delta", text: "rescued" },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const { loop } = makeLoop({
      fallbackModel: "fallback-model",
      resolveModel: resolveTo(fallbackProvider),
    })
    loop.seedHistory([
      { role: "user", content: [{ type: "text", text: "earlier" }] },
      { role: "assistant", content: [{ type: "thinking", text: "only thinking", signature: "sig" }] },
      { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
    ])

    await loop.runTurn(turnRequest(primary, PRIMARY_MODEL, "please"))

    // The turn added exactly its own user message and the fallback's reply — the dropped
    // pre-turn message must not leak the seeded history into the turn's messages.
    expect(loop.lastTurnMessages).toEqual([
      { role: "user", content: [{ type: "text", text: "please" }] },
      { role: "assistant", content: [{ type: "text", text: "rescued" }] },
    ])
  })

  test("mid-turn round-start failure falls back for the remainder of the turn", async () => {
    const tool = fakeTool({ name: "probe", readOnly: true })
    const primary = scriptedProvider([
      [
        { type: "thinking", text: "planning", signature: "sig-2" },
        { type: "tool_call", id: "call-1", name: "probe", input: {} },
        { type: "done", stopReason: "tool_use" },
      ],
      () =>
        (async function* () {
          if (Math.random() < 2) throw new ProviderHttpError("anthropic: HTTP 500", 500)
          yield { type: "done", stopReason: "end_turn" } as const
        })(),
    ])
    const fallbackProvider = scriptedProvider([
      [
        { type: "text_delta", text: "finished elsewhere" },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const { loop, events } = makeLoop({
      tools: [tool],
      fallbackModel: "fallback-model",
      resolveModel: resolveTo(fallbackProvider),
    })
    await loop.runTurn(turnRequest(primary, PRIMARY_MODEL))

    expect(tool.calls).toHaveLength(1)
    expect(ofKind(events, "warning")[0]?.payload.message).toContain("falling back to fallback-model")
    expect(ofKind(events, "turn.completed")[0]?.payload.status).toBe("completed")
    const retried = fallbackProvider.requests[0]
    // History replayed to the fallback keeps the tool exchange but loses the thinking block.
    expect(retried?.messages[1]?.content).toEqual([
      { type: "tool_call", id: "call-1", name: "probe", input: {} },
    ])
  })

  test("a failure after the first emitted event does not fall back", async () => {
    const primary = scriptedProvider([
      () =>
        (async function* () {
          yield { type: "text_delta", text: "partial " } as const
          throw new ProviderHttpError("anthropic: HTTP 500", 500)
        })(),
    ])
    const fallbackProvider = scriptedProvider([])
    const { loop, events } = makeLoop({
      fallbackModel: "fallback-model",
      resolveModel: resolveTo(fallbackProvider),
    })
    await loop.runTurn(turnRequest(primary, PRIMARY_MODEL))

    expect(fallbackProvider.requests).toHaveLength(0)
    expect(ofKind(events, "warning")).toHaveLength(0)
    expect(ofKind(events, "error")[0]?.payload.message).toContain("HTTP 500")
    expect(ofKind(events, "turn.completed")[0]?.payload.status).toBe("failed")
  })

  test("a fallback failure surfaces the normal error path; only one fallback per turn", async () => {
    const primary = failingProvider(() => new ProviderHttpError("anthropic: HTTP 529", 529))
    const fallbackProvider = failingProvider(() => new ProviderHttpError("openai: HTTP 503", 503))
    const { loop, events } = makeLoop({
      fallbackModel: "fallback-model",
      resolveModel: resolveTo(fallbackProvider),
    })
    await loop.runTurn(turnRequest(primary, PRIMARY_MODEL))

    expect(primary.requests).toHaveLength(1)
    expect(fallbackProvider.requests).toHaveLength(1)
    expect(ofKind(events, "warning")).toHaveLength(1)
    const error = ofKind(events, "error")[0]
    expect(error?.payload.message).toContain("HTTP 503")
    expect(error?.payload.recoverable).toBe(true)
    expect(ofKind(events, "turn.completed")[0]?.payload.status).toBe("failed")
  })

  test("an unknown or unavailable fallback model warns once per session, then stays ignored", async () => {
    const primary = failingProvider(() => new ProviderHttpError("anthropic: HTTP 500", 500))
    const { loop, events } = makeLoop({ fallbackModel: "ghost", resolveModel: () => undefined })
    await loop.runTurn(turnRequest(primary, PRIMARY_MODEL, "first"))
    await loop.runTurn(turnRequest(primary, PRIMARY_MODEL, "second"))

    const warnings = ofKind(events, "warning")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.payload.message).toBe(
      'The configured fallback model "ghost" is unknown or unavailable; ignoring it.',
    )
    expect(ofKind(events, "turn.completed").map((event) => event.payload.status)).toEqual([
      "failed",
      "failed",
    ])
  })

  test("a fallback equal to the current model and non-provider errors do not fall back", async () => {
    const sameModel = failingProvider(() => new ProviderHttpError("anthropic: HTTP 500", 500))
    const { loop: sameLoop, events: sameEvents } = makeLoop({
      fallbackModel: "primary-model",
      resolveModel: (id) =>
        id === "primary-model" ? { model: PRIMARY_MODEL, provider: sameModel } : undefined,
    })
    await sameLoop.runTurn(turnRequest(sameModel, PRIMARY_MODEL))
    expect(sameModel.requests).toHaveLength(1)
    expect(ofKind(sameEvents, "warning")).toHaveLength(0)
    expect(ofKind(sameEvents, "turn.completed")[0]?.payload.status).toBe("failed")

    // A generic Error is not a provider-stream failure class; it never triggers fallback.
    const generic = failingProvider(() => new Error("connection reset by fairies"))
    const fallbackProvider = scriptedProvider([])
    const { loop, events } = makeLoop({
      fallbackModel: "fallback-model",
      resolveModel: resolveTo(fallbackProvider),
    })
    await loop.runTurn(turnRequest(generic, PRIMARY_MODEL))
    expect(fallbackProvider.requests).toHaveLength(0)
    expect(ofKind(events, "warning")).toHaveLength(0)
    expect(ofKind(events, "turn.completed")[0]?.payload.status).toBe("failed")
  })
})

describe("seedHistory and historySnapshot", () => {
  test("round-trips seeded history into the next provider request; snapshots are copies", async () => {
    const seeded: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "earlier question" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "let me think", signature: "sig-9" },
          { type: "text", text: "earlier answer" },
        ],
      },
    ]
    const provider = scriptedProvider([
      [
        { type: "text_delta", text: "continuing" },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const { loop } = makeLoop()
    loop.seedHistory(seeded)
    // Snapshot equals the seed (thinking blocks included) and is a copy, not a live view.
    expect(loop.historySnapshot()).toEqual(seeded)
    const snapshot = loop.historySnapshot()
    snapshot.push({ role: "user", content: [{ type: "text", text: "tampered" }] })
    expect(loop.historySnapshot()).toHaveLength(2)

    await loop.runTurn(turnRequest(provider, PRICED_MODEL, "next"))
    expect(provider.requests[0]?.messages).toEqual([
      ...seeded,
      { role: "user", content: [{ type: "text", text: "next" }] },
    ])
    expect(loop.historySnapshot()).toHaveLength(4)

    // Re-seeding between turns replaces the history wholesale.
    loop.seedHistory([])
    expect(loop.historySnapshot()).toEqual([])
  })

  test("seedHistory is refused while a turn is active", async () => {
    const provider = scriptedProvider([
      (signal) =>
        (async function* () {
          yield { type: "text_delta", text: "busy" } as const
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve()
            signal.addEventListener("abort", () => resolve(), { once: true })
          })
          yield { type: "done", stopReason: "aborted" } as const
        })(),
    ])
    const { loop, events } = makeLoop()
    const turn = loop.runTurn(turnRequest(provider, PRICED_MODEL))
    await until(() => ofKind(events, "message.delta")[0], "first delta")
    expect(() => loop.seedHistory([])).toThrow("turn is active")
    loop.interrupt()
    await turn
    expect(ofKind(events, "turn.completed")[0]?.payload.status).toBe("interrupted")
  })
})
