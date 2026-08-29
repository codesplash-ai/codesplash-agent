import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  type ChatMessage,
  type ModelInfo,
  ProviderHttpError,
  type ProviderRequest,
  type ProviderStreamEvent,
} from "../../../src/engines/codesplash/contracts.ts"
import { createOpenAiProvider, openaiModels } from "../../../src/engines/codesplash/providers/openai.ts"

const encoder = new TextEncoder()

type FixtureResponse =
  | { kind: "sse"; chunks: unknown[] }
  | { kind: "sse-unterminated"; chunks: unknown[] }
  | { kind: "sse-hang"; chunks: unknown[] }
  | { kind: "error"; status: number; body?: string; headers?: Record<string, string> }

type RecordedRequest = {
  path: string
  authorization: string | null
  body: Record<string, unknown>
}

type Fixture = {
  url: string
  requests: RecordedRequest[]
  stop(): void
}

function sseFrames(chunks: unknown[], terminated: boolean): string {
  const frames = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
  if (terminated) frames.push("data: [DONE]\n\n")
  return frames.join("")
}

/** Serves each scripted response once; the last script repeats for any extra requests. */
function startFixture(responses: FixtureResponse[]): Fixture {
  const requests: RecordedRequest[] = []
  let served = 0
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      requests.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body: (await request.json()) as Record<string, unknown>,
      })
      const script = responses[Math.min(served, responses.length - 1)]
      served += 1
      if (!script) return new Response("no script", { status: 500 })
      if (script.kind === "error") {
        return new Response(script.body ?? "", { status: script.status, headers: script.headers })
      }
      const headers = { "content-type": "text/event-stream" }
      if (script.kind === "sse") return new Response(sseFrames(script.chunks, true), { headers })
      if (script.kind === "sse-unterminated") {
        // Closes the connection after the chunks without ever sending [DONE].
        return new Response(sseFrames(script.chunks, false), { headers })
      }
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseFrames(script.chunks, false)))
        },
      })
      return new Response(body, { headers })
    },
  })
  return {
    url: `http://localhost:${server.port}`,
    requests,
    stop: () => server.stop(true),
  }
}

function requireModel(id: string): ModelInfo {
  const model = openaiModels.find((entry) => entry.id === id)
  if (!model) throw new Error(`model ${id} missing from the openai catalog`)
  return model
}

function recorded(requests: RecordedRequest[], index = 0): RecordedRequest {
  const request = requests[index]
  if (!request) throw new Error(`expected a recorded request at index ${index}`)
  return request
}

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: requireModel("gpt-5.1"),
    system: "You are the harness.",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    ...overrides,
  }
}

async function collect(
  iterable: AsyncIterable<ProviderStreamEvent>,
  onEvent?: (event: ProviderStreamEvent) => void,
): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = []
  for await (const event of iterable) {
    events.push(event)
    onEvent?.(event)
  }
  return events
}

const savedEnv = { key: process.env.OPENAI_API_KEY, base: process.env.OPENAI_BASE_URL }
let fixture: Fixture | undefined

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key-openai"
})

afterEach(() => {
  fixture?.stop()
  fixture = undefined
  if (savedEnv.key === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = savedEnv.key
  if (savedEnv.base === undefined) delete process.env.OPENAI_BASE_URL
  else process.env.OPENAI_BASE_URL = savedEnv.base
})

function serve(responses: FixtureResponse[]): Fixture {
  fixture = startFixture(responses)
  process.env.OPENAI_BASE_URL = fixture.url
  return fixture
}

describe("createOpenAiProvider factory options", () => {
  const textStop: FixtureResponse = {
    kind: "sse",
    chunks: [
      { choices: [{ delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ],
  }

  test("an explicit baseUrl option wins over the OPENAI_BASE_URL env override", async () => {
    const envFixture = serve([textStop])
    const optionFixture = startFixture([textStop])
    try {
      const provider = createOpenAiProvider({ baseUrl: optionFixture.url })
      const events = await collect(provider.stream(makeRequest(), new AbortController().signal))
      expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" })
      expect(optionFixture.requests).toHaveLength(1)
      expect(recorded(optionFixture.requests).path).toBe("/v1/chat/completions")
      expect(envFixture.requests).toHaveLength(0)
    } finally {
      optionFixture.stop()
    }
  })

  test("a keyEnvVar option reads the key from the named variable into the auth header", async () => {
    const served = serve([textStop])
    process.env.CUSTOM_OPENAI_TEST_KEY = "custom-openai-key-value"
    try {
      const provider = createOpenAiProvider({ keyEnvVar: "CUSTOM_OPENAI_TEST_KEY" })
      await collect(provider.stream(makeRequest(), new AbortController().signal))
      expect(recorded(served.requests).authorization).toBe("Bearer custom-openai-key-value")
    } finally {
      delete process.env.CUSTOM_OPENAI_TEST_KEY
    }
  })

  test("a keyEnvVar with no value sends no auth header instead of failing (requiresKey=false)", async () => {
    const served = serve([textStop])
    delete process.env.CUSTOM_OPENAI_MISSING_KEY
    const provider = createOpenAiProvider({ keyEnvVar: "CUSTOM_OPENAI_MISSING_KEY" })
    const events = await collect(provider.stream(makeRequest(), new AbortController().signal))
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" })
    expect(recorded(served.requests).authorization).toBeNull()
  })

  test("a models option replaces the client's catalog", () => {
    const custom: ModelInfo[] = [
      {
        id: "qwen3:8b",
        displayName: "Qwen3 8B",
        provider: "ollama",
        protocol: "openai",
        contextWindow: 32_768,
        maxOutputTokens: 8_192,
        isDefault: true,
        supportsReasoning: false,
      },
    ]
    expect(createOpenAiProvider({ models: custom }).models).toBe(custom)
  })
})

describe("createOpenAiProvider", () => {
  test("exposes the openai catalog with exactly one default model", () => {
    const provider = createOpenAiProvider()
    expect(provider.id).toBe("openai")
    expect(provider.models.filter((model) => model.isDefault)).toHaveLength(1)
    expect(provider.models[0]?.id).toBe("gpt-5.1")
    for (const entry of openaiModels) expect(entry.protocol).toBe("openai")
  })

  test("streams text deltas and maps finish_reason stop to end_turn", async () => {
    serve([
      {
        kind: "sse",
        chunks: [
          { choices: [{ delta: { role: "assistant", content: "Hel" }, finish_reason: null }] },
          { choices: [{ delta: { content: "lo" }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ],
      },
    ])
    const events = await collect(createOpenAiProvider().stream(makeRequest(), new AbortController().signal))
    expect(events).toEqual([
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      { type: "done", stopReason: "end_turn" },
    ])
  })

  test("assembles split tool_calls fragments keyed by index into parsed tool_call events", async () => {
    serve([
      {
        kind: "sse",
        chunks: [
          { choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_a",
                      type: "function",
                      function: { name: "read_file", arguments: "" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              {
                delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              {
                delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 1,
                      id: "call_b",
                      type: "function",
                      function: { name: "glob", arguments: '{"pattern":"**/*.ts"}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ],
      },
    ])
    const events = await collect(createOpenAiProvider().stream(makeRequest(), new AbortController().signal))
    expect(events).toEqual([
      { type: "tool_call", id: "call_a", name: "read_file", input: { path: "a.ts" } },
      { type: "tool_call", id: "call_b", name: "glob", input: { pattern: "**/*.ts" } },
      { type: "done", stopReason: "tool_use" },
    ])
  })

  test("maps finish_reason length to max_tokens", async () => {
    serve([
      {
        kind: "sse",
        chunks: [
          { choices: [{ delta: { content: "truncat" }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "length" }] },
        ],
      },
    ])
    const events = await collect(createOpenAiProvider().stream(makeRequest(), new AbortController().signal))
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "max_tokens" })
  })

  test("reports usage from the include_usage final chunk with cached tokens counted exclusively", async () => {
    serve([
      {
        kind: "sse",
        chunks: [
          { choices: [{ delta: { content: "ok" }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
          {
            choices: [],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 25,
              prompt_tokens_details: { cached_tokens: 40 },
            },
          },
        ],
      },
    ])
    const events = await collect(createOpenAiProvider().stream(makeRequest(), new AbortController().signal))
    // prompt_tokens includes the cached reads; the adapter reports them exclusively so the
    // loop's input + cached + output context sum matches Anthropic semantics.
    expect(events).toEqual([
      { type: "text_delta", text: "ok" },
      { type: "usage", usage: { inputTokens: 60, cachedInputTokens: 40, outputTokens: 25 } },
      { type: "done", stopReason: "end_turn" },
    ])
  })

  test("reports usage unchanged when no cached token detail is present", async () => {
    serve([
      {
        kind: "sse",
        chunks: [
          { choices: [{ delta: {}, finish_reason: "stop" }] },
          { choices: [], usage: { prompt_tokens: 80, completion_tokens: 5 } },
        ],
      },
    ])
    const events = await collect(createOpenAiProvider().stream(makeRequest(), new AbortController().signal))
    expect(events).toEqual([
      { type: "usage", usage: { inputTokens: 80, outputTokens: 5 } },
      { type: "done", stopReason: "end_turn" },
    ])
  })

  test("requests streaming with stream_options include_usage and the model's output cap", async () => {
    const { requests } = serve([
      { kind: "sse", chunks: [{ choices: [{ delta: {}, finish_reason: "stop" }] }] },
    ])
    await collect(createOpenAiProvider().stream(makeRequest(), new AbortController().signal))
    expect(requests).toHaveLength(1)
    const { path, authorization, body } = recorded(requests)
    expect(path).toBe("/v1/chat/completions")
    expect(authorization).toBe("Bearer test-key-openai")
    expect(body.model).toBe("gpt-5.1")
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.max_completion_tokens).toBe(32768)
  })

  test("maps chat history, tools, and reasoning effort onto the wire", async () => {
    const { requests } = serve([
      { kind: "sse", chunks: [{ choices: [{ delta: {}, finish_reason: "stop" }] }] },
    ])
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "read a file" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading." },
          { type: "tool_call", id: "call_1", name: "read_file", input: { path: "a.ts" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", toolCallId: "call_1", text: "contents" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mediaType: "image/png", base64Data: "QUJD" },
        ],
      },
    ]
    const request = makeRequest({
      messages,
      tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
      reasoningEffort: "high",
    })
    await collect(createOpenAiProvider().stream(request, new AbortController().signal))
    const body = recorded(requests).body
    expect(body.messages).toEqual([
      { role: "system", content: "You are the harness." },
      { role: "user", content: "read a file" },
      {
        role: "assistant",
        content: "Reading.",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "contents" },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
        ],
      },
    ])
    expect(body.tools).toEqual([
      {
        type: "function",
        function: { name: "read_file", description: "Read a file", parameters: { type: "object" } },
      },
    ])
    expect(body.reasoning_effort).toBe("high")
  })

  test("omits reasoning_effort when the model does not support reasoning", async () => {
    const { requests } = serve([
      { kind: "sse", chunks: [{ choices: [{ delta: {}, finish_reason: "stop" }] }] },
    ])
    const request = makeRequest({ model: requireModel("gpt-5.1-mini"), reasoningEffort: "high" })
    await collect(createOpenAiProvider().stream(request, new AbortController().signal))
    expect(recorded(requests).body.reasoning_effort).toBeUndefined()
  })

  test("retries a 500 through withRetries and then streams the successful response", async () => {
    const { requests } = serve([
      { kind: "error", status: 500, body: "upstream exploded" },
      {
        kind: "sse",
        chunks: [
          { choices: [{ delta: { content: "recovered" }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ],
      },
    ])
    const events = await collect(createOpenAiProvider().stream(makeRequest(), new AbortController().signal))
    expect(requests).toHaveLength(2)
    expect(events).toEqual([
      { type: "text_delta", text: "recovered" },
      { type: "done", stopReason: "end_turn" },
    ])
  }, 15000)

  test("throws ProviderHttpError with status and detail for a non-retriable non-2xx", async () => {
    const { requests } = serve([{ kind: "error", status: 400, body: '{"error":{"message":"bad request"}}' }])
    const stream = createOpenAiProvider().stream(makeRequest(), new AbortController().signal)
    const error = await collect(stream).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(ProviderHttpError)
    expect((error as ProviderHttpError).status).toBe(400)
    expect((error as ProviderHttpError).message).toContain("400")
    expect((error as ProviderHttpError).message).toContain("bad request")
    expect((error as ProviderHttpError).message).not.toContain("test-key-openai")
    expect(requests).toHaveLength(1)
  })

  test("redacts credential-shaped content echoed in a non-2xx body", async () => {
    // A debug proxy or gateway can echo the Authorization header (or key text) in its error page.
    serve([
      {
        kind: "error",
        status: 401,
        body: "Incorrect API key provided: sk-leak1234567890abcdef (Authorization: Bearer test-key-openai)",
      },
    ])
    const error = await collect(
      createOpenAiProvider().stream(makeRequest(), new AbortController().signal),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(ProviderHttpError)
    const message = (error as ProviderHttpError).message
    expect(message).toContain("401")
    expect(message).toContain("[REDACTED]")
    expect(message).not.toContain("sk-leak1234567890abcdef")
    expect(message).not.toContain("test-key-openai")
  })

  test("a custom key echoed bare in an error body is scrubbed even when its env name looks benign", async () => {
    // The env-name heuristic in redactSensitiveText would never match "CUSTOM_LLM_ACCESS", and
    // the value matches no credential pattern — the adapter must scrub the concrete resolved key.
    serve([{ kind: "error", status: 401, body: "gateway saw llm-access-value-123456 and refused" }])
    process.env.CUSTOM_LLM_ACCESS = "llm-access-value-123456"
    try {
      const error = await collect(
        createOpenAiProvider({ keyEnvVar: "CUSTOM_LLM_ACCESS" }).stream(
          makeRequest(),
          new AbortController().signal,
        ),
      ).then(
        () => undefined,
        (thrown: unknown) => thrown,
      )
      expect(error).toBeInstanceOf(ProviderHttpError)
      const message = (error as ProviderHttpError).message
      expect(message).toContain("[REDACTED]")
      expect(message).not.toContain("llm-access-value-123456")
    } finally {
      delete process.env.CUSTOM_LLM_ACCESS
    }
  })

  test("a mid-stream error frame throws ProviderHttpError instead of completing silently", async () => {
    serve([
      {
        kind: "sse-unterminated",
        chunks: [
          { choices: [{ delta: { content: "par" }, finish_reason: null }] },
          { error: { message: "The server had an error processing your request", type: "server_error" } },
        ],
      },
    ])
    const events: ProviderStreamEvent[] = []
    const error = await collect(
      createOpenAiProvider().stream(makeRequest(), new AbortController().signal),
      (event) => events.push(event),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(ProviderHttpError)
    expect((error as ProviderHttpError).message).toContain("server_error")
    expect((error as ProviderHttpError).message).toContain("error processing your request")
    expect(events).toEqual([{ type: "text_delta", text: "par" }])
  })

  test("a stream that closes before any finish_reason or [DONE] throws instead of ending the turn", async () => {
    serve([
      {
        kind: "sse-unterminated",
        chunks: [{ choices: [{ delta: { content: "cut" }, finish_reason: null }] }],
      },
    ])
    const stream = createOpenAiProvider().stream(makeRequest(), new AbortController().signal)
    const error = await collect(stream).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(ProviderHttpError)
    expect((error as ProviderHttpError).message).toContain("ended before completion")
  })

  test("mid-stream abort yields done aborted instead of throwing", async () => {
    serve([
      {
        kind: "sse-hang",
        chunks: [{ choices: [{ delta: { content: "partial" }, finish_reason: null }] }],
      },
    ])
    const controller = new AbortController()
    const events = await collect(createOpenAiProvider().stream(makeRequest(), controller.signal), (event) => {
      if (event.type === "text_delta") controller.abort()
    })
    expect(events).toEqual([
      { type: "text_delta", text: "partial" },
      { type: "done", stopReason: "aborted" },
    ])
  })

  test("abort before the connection resolves yields done aborted", async () => {
    serve([{ kind: "sse-hang", chunks: [] }])
    const controller = new AbortController()
    controller.abort()
    const events = await collect(createOpenAiProvider().stream(makeRequest(), controller.signal))
    expect(events).toEqual([{ type: "done", stopReason: "aborted" }])
  })
})
