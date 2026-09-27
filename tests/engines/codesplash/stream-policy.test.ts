import { expect, test } from "bun:test"
import type { AgentEvent } from "../../../src/core/events.ts"
import { initialAppViewState, reduceAgentEvent } from "../../../src/core/reducer.ts"
import {
  type HarnessTool,
  type ProviderClient,
  ProviderHttpError,
  type ProviderRequest,
  type ProviderStreamEvent,
} from "../../../src/engines/codesplash/contracts.ts"
import {
  CodesplashEventFactory,
  CodesplashLoop,
  type CodesplashLoopOptions,
} from "../../../src/engines/codesplash/loop.ts"
import { StreamLoopGuard } from "../../../src/engines/codesplash/stream-policy.ts"
import { createToolRegistry } from "../../../src/engines/codesplash/tools/registry.ts"

const model = {
  id: "first",
  displayName: "First",
  provider: "anthropic",
  protocol: "anthropic" as const,
  contextWindow: 200000,
  maxOutputTokens: 1000,
  isDefault: true,
  supportsReasoning: false,
}
function fixture(
  stream: (request: ProviderRequest, signal: AbortSignal) => AsyncIterable<ProviderStreamEvent>,
  policy: CodesplashLoopOptions["streamPolicy"],
  tools: HarnessTool[] = [],
  fallback?: ProviderClient,
) {
  const events: AgentEvent[] = [],
    requests: ProviderRequest[] = []
  const provider: ProviderClient = {
    id: "anthropic",
    models: [model],
    stream(request, signal) {
      requests.push(structuredClone(request))
      return stream(request, signal)
    },
  }
  const loop = new CodesplashLoop({
    cwd: "/tmp",
    policy: { sandbox: "workspace-write", approvalPolicy: "on-request" },
    registry: createToolRegistry(tools),
    events: new CodesplashEventFactory("policy"),
    emit: (e) => events.push(e),
    streamPolicy: policy,
    fallbackModel: fallback ? "second" : undefined,
    resolveModel: () => (fallback ? { provider: fallback, model: { ...model, id: "second" } } : undefined),
  })
  return {
    loop,
    events,
    requests,
    run: () =>
      loop.runTurn({
        provider,
        model,
        system: "system",
        userText: "request",
        userContent: [
          { type: "text", text: "request" },
          { type: "image", mediaType: "image/png", base64Data: "AA==" },
        ],
      }),
  }
}
test("413 image adaptation retries once with a visible wire omission and preserves original history", async () => {
  let calls = 0
  const f = fixture(
    async function* () {
      if (calls++ === 0) throw new ProviderHttpError("too large", 413)
      yield { type: "text_delta", text: "answer" }
      yield { type: "done", stopReason: "end_turn" }
    },
    { stripImagesOn413: true },
  )
  await f.run()
  expect(calls).toBe(2)
  expect(f.requests[0]?.messages[0]?.content.some((b) => b.type === "image")).toBe(true)
  expect(f.requests[1]?.messages[0]?.content.some((b) => b.type === "image")).toBe(false)
  expect(f.loop.historySnapshot()[0]?.content.some((b) => b.type === "image")).toBe(true)
  expect(f.events.some((e) => e.kind === "warning" && e.payload.message.includes("image blocks"))).toBe(true)
})
test("partial fallback replaces visible text and reasoning, charges both attempts, and never replays tools", async () => {
  let fallbackCalls = 0
  const fallback: ProviderClient = {
    id: "anthropic",
    models: [model],
    async *stream() {
      fallbackCalls++
      yield { type: "text_delta", text: "complete answer" }
      yield { type: "usage", usage: { inputTokens: 7, outputTokens: 2 } }
      yield { type: "done", stopReason: "end_turn" }
    },
  }
  const f = fixture(
    async function* () {
      yield { type: "text_delta", text: "partial untrusted answer" }
      yield { type: "reasoning_delta", text: "partial reason" }
      yield { type: "usage", usage: { inputTokens: 5, outputTokens: 1 } }
      throw new ProviderHttpError("stream failed", 500)
    },
    { partialFallback: true },
    [],
    fallback,
  )
  await f.run()
  expect(fallbackCalls).toBe(1)
  const state = f.events.reduce(reduceAgentEvent, initialAppViewState)
  expect(state.transcript.filter((t) => t.kind === "message").map((t) => t.text)).toEqual([
    "[Superseded: incomplete provider output. A fallback response follows.]",
    "complete answer",
  ])
  expect(state.usage.inputTokens).toBe(12)
  expect(JSON.stringify(f.loop.historySnapshot())).not.toContain("partial untrusted")
  const g = fixture(
    async function* () {
      yield { type: "tool_call", id: "call", name: "unknown", input: {} }
      throw new ProviderHttpError("stream failed", 500)
    },
    { partialFallback: true },
    [],
    fallback,
  )
  await g.run()
  expect(fallbackCalls).toBe(1)
})
test("incremental dispatch starts after a complete call before done, executes once, and stops at a mutation barrier", async () => {
  let reads = 0,
    writes = 0,
    round = 0
  const read: HarnessTool = {
    name: "read_file",
    description: "read",
    inputSchema: { type: "object" },
    isReadOnly: () => true,
    permission: () => ({ kind: "none" }),
    async run() {
      reads++
      return { text: "result", label: "read" }
    },
  }
  const write: HarnessTool = {
    ...read,
    name: "write_file",
    isReadOnly: () => false,
    async run() {
      writes++
      return { text: "written", label: "write" }
    },
  }
  const f = fixture(
    async function* () {
      if (round++ === 0) {
        yield { type: "tool_call", id: "read", name: "read_file", input: {} }
        expect(reads).toBe(1)
        yield { type: "tool_call", id: "write", name: "write_file", input: {} }
        yield { type: "tool_call", id: "read2", name: "read_file", input: {} }
        expect(reads).toBe(1)
        expect(writes).toBe(0)
        yield { type: "done", stopReason: "tool_use" }
      } else yield { type: "done", stopReason: "end_turn" }
    },
    { incrementalTools: true },
    [read, write],
  )
  await f.run()
  expect(reads).toBe(2)
  expect(writes).toBe(1)
  const results = f.loop
    .historySnapshot()
    .flatMap((m) => m.content)
    .filter((b) => b.type === "tool_result")
  expect(results.map((r) => r.toolCallId)).toEqual(["read", "write", "read2"])
})
test("early results are settled after stream failure and neither fallback nor reexecution occurs", async () => {
  let reads = 0,
    fallbackCalls = 0
  const read: HarnessTool = {
    name: "read_file",
    description: "read",
    inputSchema: { type: "object" },
    isReadOnly: () => true,
    permission: () => ({ kind: "none" }),
    async run() {
      reads++
      return { text: "read result", label: "read" }
    },
  }
  const fallback: ProviderClient = {
    id: "anthropic",
    models: [model],
    async *stream() {
      fallbackCalls++
      yield { type: "done", stopReason: "end_turn" }
    },
  }
  const f = fixture(
    async function* () {
      yield { type: "tool_call", id: "read", name: "read_file", input: {} }
      throw new ProviderHttpError("failed", 500)
    },
    { incrementalTools: true, partialFallback: true },
    [read],
    fallback,
  )
  await f.run()
  expect(reads).toBe(1)
  expect(fallbackCalls).toBe(0)
  expect(f.loop.historySnapshot().at(-1)?.content).toEqual([
    { type: "tool_result", toolCallId: "read", text: "read result" },
  ])
})
test("empty response retry is bounded and exact long stream repetition is stopped", async () => {
  let calls = 0
  const f = fixture(
    async function* () {
      calls++
      yield { type: "done", stopReason: "end_turn" }
    },
    { retryEmptyResponse: true },
  )
  await f.run()
  expect(calls).toBe(2)
  const guard = new StreamLoopGuard()
  const block = Array.from({ length: 128 }, (_, i) => String.fromCharCode(33 + (i % 90))).join("")
  for (let i = 0; i < 7; i++) guard.push(block)
  expect(() => guard.push(block)).toThrow("repeated")
  const prose = new StreamLoopGuard()
  for (let i = 0; i < 100; i++) prose.push(`Distinct line ${i}: ${"ordinary ".repeat(4)}\n`)
})
