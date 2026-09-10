import { expect, test } from "bun:test"
import type {
  ModelInfo,
  ProviderClient,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderUsage,
} from "../../../src/engines/codesplash/contracts.ts"
import { generatePresentation } from "../../../src/engines/codesplash/presentation.ts"

const model: ModelInfo = {
  id: "fixture",
  provider: "openai",
  protocol: "openai",
  displayName: "fixture",
  contextWindow: 100000,
  maxOutputTokens: 2000,
  supportsReasoning: false,
  isDefault: true,
}
function fixture(stream: ProviderClient["stream"], timeoutMs = 1000) {
  const usage: Array<ProviderUsage | undefined> = [],
    requests: ProviderRequest[] = [],
    abort = new AbortController()
  const promise = generatePresentation({
    kind: "title",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Fix parser sk-private-canary" },
          { type: "thinking", text: "SECRET_REASONING", signature: "SIGNATURE" },
        ],
      },
    ],
    model,
    provider: {
      id: "openai",
      models: [],
      stream: (request, signal) => {
        requests.push(request)
        return stream(request, signal)
      },
    },
    signal: abort.signal,
    sanitize: (text) => text.replaceAll("sk-private-canary", "[redacted]"),
    onUsage: (value) => usage.push(value),
    timeoutMs,
  })
  return { promise, usage, requests, abort }
}
test("generated title has no tools, bounded output/context, sanitized visible evidence and exactly one usage charge", async () => {
  const f = fixture(async function* () {
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 1 } }
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } }
    yield { type: "text_delta", text: "Parser repair" }
    yield { type: "done", stopReason: "end_turn" }
  })
  expect(await f.promise).toBe("Parser repair")
  expect(f.usage).toEqual([{ inputTokens: 10, outputTokens: 2 }])
  expect(f.requests[0]?.tools).toEqual([])
  expect(f.requests[0]?.model.maxOutputTokens).toBe(512)
  expect(JSON.stringify(f.requests)).not.toContain("SECRET_REASONING")
  expect(JSON.stringify(f.requests)).not.toContain("SIGNATURE")
  expect(JSON.stringify(f.requests)).not.toContain("sk-private-canary")
})
test("timeout and cancellation settle noncooperative streams and mark unknown usage", async () => {
  let signal: AbortSignal | undefined
  const f = fixture((_request, s) => {
    signal = s
    return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }
  }, 10)
  await expect(f.promise).rejects.toThrow("timed out")
  expect(f.usage).toEqual([undefined])
  expect(signal?.aborted).toBe(true)
  const cancelled = fixture(() => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }))
  cancelled.abort.abort(new Error("Foreground work"))
  await expect(cancelled.promise).rejects.toThrow("Foreground")
  expect(cancelled.usage).toEqual([undefined])
})
test("tool calls, excessive output and incomplete responses fail without applying results and still account usage", async () => {
  for (const response of [
    [{ type: "tool_call", id: "bad", name: "bash", input: {} }],
    [{ type: "text_delta", text: "X".repeat(16385) }],
    [
      { type: "text_delta", text: "Incomplete" },
      { type: "done", stopReason: "max_tokens" },
    ],
  ] as ProviderStreamEvent[][]) {
    const f = fixture(async function* () {
      yield { type: "usage", usage: { inputTokens: 4 } }
      yield* response
    })
    await expect(f.promise).rejects.toThrow()
    expect(f.usage).toEqual([{ inputTokens: 4 }])
  }
})
