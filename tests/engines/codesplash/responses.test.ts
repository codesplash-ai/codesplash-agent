import { expect, test } from "bun:test"
import type { ProviderRequest } from "../../../src/engines/codesplash/contracts.ts"
import { createOpenAiProvider } from "../../../src/engines/codesplash/providers/openai.ts"

const request: ProviderRequest = {
  model: {
    id: "fixture",
    provider: "openai",
    protocol: "openai",
    displayName: "fixture",
    contextWindow: 32000,
    maxOutputTokens: 512,
    isDefault: true,
    supportsReasoning: true,
  },
  system: "system",
  messages: [{ role: "user", content: [{ type: "text", text: "question" }] }],
  tools: [{ name: "read_file", description: "read", inputSchema: { type: "object" } }],
  reasoningEffort: "low",
}
const events = [
  { type: "response.output_text.delta", delta: "answer" },
  {
    type: "response.output_item.done",
    item: { type: "reasoning", id: "r", encrypted_content: "opaque", summary: [] },
  },
  {
    type: "response.output_item.done",
    item: { type: "function_call", call_id: "call", name: "read_file", arguments: '{"path":"file"}' },
  },
  {
    type: "response.completed",
    response: {
      status: "completed",
      usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 3 }, output_tokens: 4 },
    },
  },
]
test("Responses SSE converts tools, opaque reasoning and exclusive cached usage; 429 retries only before streaming", async () => {
  let calls = 0,
    body: Record<string, unknown> | undefined
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      body = await req.json()
      if (++calls === 1) return new Response("", { status: 429, headers: { "retry-after": "0" } })
      return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  try {
    const provider = createOpenAiProvider({
        api: "responses",
        baseUrl: `http://127.0.0.1:${server.port}`,
        keyEnvVar: "M10_ABSENT_KEY",
        serviceTier: "flex",
      }),
      result = await Array.fromAsync(provider.stream(request, new AbortController().signal))
    expect(calls).toBe(2)
    expect(body).toMatchObject({ store: false, service_tier: "flex", stream: true })
    expect(result).toContainEqual({
      type: "usage",
      usage: { inputTokens: 7, cachedInputTokens: 3, outputTokens: 4 },
    })
    expect(result).toContainEqual({
      type: "tool_call",
      id: "call",
      name: "read_file",
      input: { path: "file" },
    })
    expect(result.at(-1)).toEqual({ type: "done", stopReason: "tool_use" })
  } finally {
    await server.stop(true)
  }
})
test("Responses WebSocket uses response.create and cannot silently replay a truncated response", async () => {
  let creates = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, s) {
      if (s.upgrade(req)) return
      return new Response("", { status: 400 })
    },
    websocket: {
      message(ws, data) {
        const request = JSON.parse(String(data))
        expect(request.type).toBe("response.create")
        expect(request.stream).toBeUndefined()
        creates++
        for (const event of events) ws.send(JSON.stringify(event))
      },
    },
  })
  try {
    const provider = createOpenAiProvider({
      api: "responses",
      transport: "websocket",
      baseUrl: `http://127.0.0.1:${server.port}`,
      keyEnvVar: "M10_ABSENT_KEY",
    })
    const result = await Array.fromAsync(provider.stream(request, new AbortController().signal))
    expect(creates).toBe(1)
    expect(result.at(-1)).toEqual({ type: "done", stopReason: "tool_use" })
  } finally {
    await server.stop(true)
  }
  const truncated = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n')
    },
  })
  try {
    await expect(
      Array.fromAsync(
        createOpenAiProvider({
          api: "responses",
          baseUrl: `http://127.0.0.1:${truncated.port}`,
          keyEnvVar: "M10_ABSENT_KEY",
        }).stream(request, new AbortController().signal),
      ),
    ).rejects.toThrow("before completion")
  } finally {
    await truncated.stop(true)
  }
})
