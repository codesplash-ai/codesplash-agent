import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type {
  ModelInfo,
  ProviderRequest,
  ProviderStreamEvent,
} from "../../../src/engines/codesplash/contracts.ts"
import { ProviderHttpError } from "../../../src/engines/codesplash/contracts.ts"
import {
  AnthropicProvider,
  anthropicModels,
  createAnthropicProvider,
} from "../../../src/engines/codesplash/providers/anthropic.ts"

type CapturedBody = {
  model?: string
  max_tokens?: number
  system?: string
  stream?: boolean
  thinking?: { type?: string; budget_tokens?: number }
  tools?: Array<Record<string, unknown>>
  messages?: Array<{ role?: string; content?: Array<Record<string, unknown>> }>
}

type CapturedRequest = {
  apiKey: string | null
  version: string | null
  contentType: string | null
  body: CapturedBody
}

let server: ReturnType<typeof Bun.serve>
let respond: (request: Request) => Response | Promise<Response>
const captured: CapturedRequest[] = []
const savedEnv = {
  key: process.env.ANTHROPIC_API_KEY,
  baseUrl: process.env.ANTHROPIC_BASE_URL,
}

const defaultRespond = () => new Response("unexpected request", { status: 500 })

beforeAll(() => {
  respond = defaultRespond
  server = Bun.serve({ port: 0, fetch: (request) => respond(request) })
  process.env.ANTHROPIC_API_KEY = "test-api-key"
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server.stop(true)
  restoreEnv("ANTHROPIC_API_KEY", savedEnv.key)
  restoreEnv("ANTHROPIC_BASE_URL", savedEnv.baseUrl)
})

afterEach(() => {
  respond = defaultRespond
  captured.length = 0
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function captureRequest(request: Request): Promise<void> {
  captured.push({
    apiKey: request.headers.get("x-api-key"),
    version: request.headers.get("anthropic-version"),
    contentType: request.headers.get("content-type"),
    body: (await request.json()) as CapturedBody,
  })
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function sseHeaders(): Record<string, string> {
  return { "content-type": "text/event-stream" }
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const part of frames) {
        controller.enqueue(encoder.encode(part))
        await Bun.sleep(1)
      }
      controller.close()
    },
    cancel() {},
  })
  return new Response(stream, { headers: sseHeaders() })
}

/** Streams the payload in fixed-size byte chunks so events split across reads. */
function chunkedSseResponse(payload: string, chunkSize: number): Response {
  const bytes = new TextEncoder().encode(payload)
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let at = 0; at < bytes.length; at += chunkSize) {
        controller.enqueue(bytes.slice(at, at + chunkSize))
        await Bun.sleep(0)
      }
      controller.close()
    },
    cancel() {},
  })
  return new Response(stream, { headers: sseHeaders() })
}

/** Sends the frames, then holds the connection open until the client goes away. */
function holdOpenSseResponse(frames: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of frames) controller.enqueue(encoder.encode(part))
    },
    cancel() {},
  })
  return new Response(stream, { headers: sseHeaders() })
}

function textTurnFrames(): string[] {
  return [
    frame("message_start", {
      type: "message_start",
      message: {
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "claude-fable-5",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 812, cache_read_input_tokens: 256, output_tokens: 1 },
      },
    }),
    frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    }),
    frame("ping", { type: "ping" }),
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: ", world" },
    }),
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "!" },
    }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 12 },
    }),
    frame("message_stop", { type: "message_stop" }),
  ]
}

function model(id: string): ModelInfo {
  const found = anthropicModels.find((entry) => entry.id === id)
  if (!found) throw new Error(`unknown test model: ${id}`)
  return found
}

function baseRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: model("claude-fable-5"),
    system: "You are the harness.",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    ...overrides,
  }
}

async function collectEvents(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderStreamEvent[]> {
  const provider = new AnthropicProvider()
  const abortSignal = signal ?? new AbortController().signal
  const events: ProviderStreamEvent[] = []
  for await (const event of provider.stream(request, abortSignal)) events.push(event)
  return events
}

describe("AnthropicProvider catalog", () => {
  test("matches the design catalog with exactly one default", () => {
    const provider = createAnthropicProvider()
    expect(provider.id).toBe("anthropic")
    expect(provider.models).toBe(anthropicModels)
    expect(anthropicModels.map((entry) => entry.id)).toEqual([
      "claude-fable-5",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ])
    expect(anthropicModels.filter((entry) => entry.isDefault).map((entry) => entry.id)).toEqual([
      "claude-fable-5",
    ])
    for (const entry of anthropicModels) {
      expect(entry.provider).toBe("anthropic")
      expect(entry.contextWindow).toBe(200_000)
      expect(entry.maxOutputTokens).toBe(32_000)
    }
    expect(model("claude-haiku-4-5-20251001").supportsReasoning).toBe(false)
    for (const entry of anthropicModels) expect(entry.protocol).toBe("anthropic")
  })
})

describe("AnthropicProvider factory options", () => {
  async function drain(provider: ReturnType<typeof createAnthropicProvider>): Promise<ProviderStreamEvent[]> {
    const events: ProviderStreamEvent[] = []
    for await (const event of provider.stream(baseRequest(), new AbortController().signal)) {
      events.push(event)
    }
    return events
  }

  test("an explicit baseUrl option wins over the ANTHROPIC_BASE_URL env override", async () => {
    const hits: string[] = []
    const local = Bun.serve({
      port: 0,
      fetch: (request) => {
        hits.push(new URL(request.url).pathname)
        return sseResponse(textTurnFrames())
      },
    })
    try {
      // ANTHROPIC_BASE_URL still points at the shared fixture; the option must win.
      const events = await drain(createAnthropicProvider({ baseUrl: `http://127.0.0.1:${local.port}` }))
      expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" })
      expect(hits).toEqual(["/v1/messages"])
      expect(captured).toHaveLength(0)
    } finally {
      local.stop(true)
    }
  })

  test("a keyEnvVar option reads the key from the named variable into x-api-key", async () => {
    respond = async (request) => {
      await captureRequest(request)
      return sseResponse(textTurnFrames())
    }
    process.env.CUSTOM_ANTHROPIC_TEST_KEY = "custom-anthropic-key-value"
    try {
      await drain(createAnthropicProvider({ keyEnvVar: "CUSTOM_ANTHROPIC_TEST_KEY" }))
      expect(captured[0]?.apiKey).toBe("custom-anthropic-key-value")
    } finally {
      delete process.env.CUSTOM_ANTHROPIC_TEST_KEY
    }
  })

  test("a keyEnvVar with no value sends no auth header instead of failing (requiresKey=false)", async () => {
    respond = async (request) => {
      await captureRequest(request)
      return sseResponse(textTurnFrames())
    }
    delete process.env.CUSTOM_ANTHROPIC_MISSING_KEY
    const events = await drain(createAnthropicProvider({ keyEnvVar: "CUSTOM_ANTHROPIC_MISSING_KEY" }))
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" })
    expect(captured[0]?.apiKey).toBeNull()
  })

  test("a custom key echoed bare in an error body is scrubbed even when its env name looks benign", async () => {
    // The env-name heuristic in redactSensitiveText would never match "CUSTOM_MODEL_AUTH", and the
    // value matches no credential pattern — the adapter must scrub the concrete resolved key.
    process.env.CUSTOM_MODEL_AUTH = "gateway-pass-value-123456"
    respond = () => new Response("gateway saw gateway-pass-value-123456 and refused", { status: 400 })
    try {
      let thrown: unknown
      try {
        await drain(createAnthropicProvider({ keyEnvVar: "CUSTOM_MODEL_AUTH" }))
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(ProviderHttpError)
      const message = (thrown as ProviderHttpError).message
      expect(message).toContain("[REDACTED]")
      expect(message).not.toContain("gateway-pass-value-123456")
    } finally {
      delete process.env.CUSTOM_MODEL_AUTH
    }
  })

  test("a models option replaces the client's catalog", () => {
    const custom: ModelInfo[] = [
      {
        id: "claude-proxy",
        displayName: "Claude proxy",
        provider: "my-gateway",
        protocol: "anthropic",
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        isDefault: true,
        supportsReasoning: true,
      },
    ]
    expect(createAnthropicProvider({ models: custom }).models).toBe(custom)
  })
})

describe("AnthropicProvider streaming", () => {
  test("streams text deltas and merged usage, ending with done end_turn", async () => {
    respond = async (request) => {
      await captureRequest(request)
      return sseResponse(textTurnFrames())
    }

    const events = await collectEvents(baseRequest())

    expect(events).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: ", world" },
      { type: "text_delta", text: "!" },
      { type: "usage", usage: { inputTokens: 812, cachedInputTokens: 256, outputTokens: 12 } },
      { type: "done", stopReason: "end_turn" },
    ])

    const request = captured[0]
    expect(request?.apiKey).toBe("test-api-key")
    expect(request?.version).toBe("2023-06-01")
    expect(request?.contentType).toBe("application/json")
    expect(request?.body.model).toBe("claude-fable-5")
    expect(request?.body.max_tokens).toBe(32_000)
    expect(request?.body.stream).toBe(true)
    expect(request?.body.system).toBe("You are the harness.")
    expect(request?.body.thinking).toBeUndefined()
    expect(request?.body.tools).toBeUndefined()
  })

  test("maps thinking blocks to reasoning deltas and captures the signed thinking block", async () => {
    respond = () =>
      sseResponse([
        frame("message_start", {
          type: "message_start",
          message: { usage: { input_tokens: 10, output_tokens: 1 } },
        }),
        frame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        }),
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Weighing the options" },
        }),
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "c2ln" },
        }),
        frame("content_block_stop", { type: "content_block_stop", index: 0 }),
        frame("content_block_start", {
          type: "content_block_start",
          index: 1,
          content_block: { type: "text", text: "" },
        }),
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "Answer" },
        }),
        frame("content_block_stop", { type: "content_block_stop", index: 1 }),
        frame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 9 },
        }),
        frame("message_stop", { type: "message_stop" }),
      ])

    const events = await collectEvents(baseRequest({ reasoningEffort: "high" }))

    expect(events).toEqual([
      { type: "reasoning_delta", text: "Weighing the options" },
      { type: "thinking", text: "Weighing the options", signature: "c2ln" },
      { type: "text_delta", text: "Answer" },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 9 } },
      { type: "done", stopReason: "end_turn" },
    ])
  })

  test("assembles split input_json_delta fragments into parsed tool_call events", async () => {
    const frames = [
      frame("message_start", {
        type: "message_start",
        message: { usage: { input_tokens: 44, output_tokens: 2 } },
      }),
      frame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "I'll read the file." },
      }),
      frame("content_block_stop", { type: "content_block_stop", index: 0 }),
      frame("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_abc", name: "read_file", input: {} },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "" },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"pa' },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: 'th": "src/ma' },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: 'in.ts", "lim' },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: 'it": 40}' },
      }),
      frame("content_block_stop", { type: "content_block_stop", index: 1 }),
      frame("content_block_start", {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "toolu_def", name: "todo_write", input: {} },
      }),
      frame("content_block_stop", { type: "content_block_stop", index: 2 }),
      frame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 31 },
      }),
      frame("message_stop", { type: "message_stop" }),
    ]
    respond = () => chunkedSseResponse(frames.join(""), 9)

    const events = await collectEvents(baseRequest())

    expect(events).toEqual([
      { type: "text_delta", text: "I'll read the file." },
      { type: "tool_call", id: "toolu_abc", name: "read_file", input: { path: "src/main.ts", limit: 40 } },
      { type: "tool_call", id: "toolu_def", name: "todo_write", input: {} },
      { type: "usage", usage: { inputTokens: 44, outputTokens: 31 } },
      { type: "done", stopReason: "tool_use" },
    ])
  })

  test("stop_reason max_tokens maps to done max_tokens", async () => {
    respond = () =>
      sseResponse([
        frame("message_start", { type: "message_start", message: { usage: { input_tokens: 5 } } }),
        frame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "truncat" },
        }),
        frame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "max_tokens" },
          usage: { output_tokens: 32_000 },
        }),
        frame("message_stop", { type: "message_stop" }),
      ])

    const events = await collectEvents(baseRequest())
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "max_tokens" })
  })

  test("tool input truncated by max_tokens ends with done max_tokens instead of a parse error", async () => {
    respond = () =>
      sseResponse([
        frame("message_start", { type: "message_start", message: { usage: { input_tokens: 7 } } }),
        frame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Writing the file." },
        }),
        frame("content_block_stop", { type: "content_block_stop", index: 0 }),
        frame("content_block_start", {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_cut", name: "write_file", input: {} },
        }),
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"path": "a.ts", "content": "trunca' },
        }),
        frame("content_block_stop", { type: "content_block_stop", index: 1 }),
        frame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "max_tokens" },
          usage: { output_tokens: 32_000 },
        }),
        frame("message_stop", { type: "message_stop" }),
      ])

    const events = await collectEvents(baseRequest())
    expect(events).toEqual([
      { type: "text_delta", text: "Writing the file." },
      { type: "usage", usage: { inputTokens: 7, outputTokens: 32_000 } },
      { type: "done", stopReason: "max_tokens" },
    ])
  })

  test("unparseable tool input still throws when stop_reason claims tool_use", async () => {
    respond = () =>
      sseResponse([
        frame("message_start", { type: "message_start", message: { usage: { input_tokens: 7 } } }),
        frame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_bad", name: "write_file", input: {} },
        }),
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"path": not-json' },
        }),
        frame("content_block_stop", { type: "content_block_stop", index: 0 }),
        frame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 12 },
        }),
        frame("message_stop", { type: "message_stop" }),
      ])

    await expect(collectEvents(baseRequest())).rejects.toThrow("not valid JSON")
  })

  test("a stream that ends after message_delta without message_stop still finishes with done", async () => {
    respond = () =>
      sseResponse([
        frame("message_start", { type: "message_start", message: { usage: { input_tokens: 6 } } }),
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "done early" },
        }),
        frame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 3 },
        }),
      ])

    const events = await collectEvents(baseRequest())
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" })
  })
})

describe("AnthropicProvider request wire format", () => {
  test("maps history, tools, images, and tool results onto the Messages wire format", async () => {
    respond = async (request) => {
      await captureRequest(request)
      return sseResponse(textTurnFrames())
    }

    await collectEvents(
      baseRequest({
        reasoningEffort: "medium",
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        ],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Look at this screenshot" },
              { type: "image", mediaType: "image/png", base64Data: "aGFybmVzcw==" },
            ],
          },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Reading it now." },
              { type: "tool_call", id: "toolu_1", name: "read_file", input: { path: "src/cli.ts" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", toolCallId: "toolu_1", text: "file contents" },
              { type: "tool_result", toolCallId: "toolu_2", text: "boom", isError: true },
            ],
          },
        ],
      }),
    )

    const body = captured[0]?.body
    expect(body?.thinking).toEqual({ type: "enabled", budget_tokens: 12_288 })
    expect(body?.tools).toEqual([
      {
        name: "read_file",
        description: "Read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ])
    expect(body?.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this screenshot" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGFybmVzcw==" } },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading it now." },
          { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "src/cli.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "file contents" },
          { type: "tool_result", tool_use_id: "toolu_2", content: "boom", is_error: true },
        ],
      },
    ])
  })

  test("replays stored thinking blocks at the head of the assistant tool_use message", async () => {
    respond = async (request) => {
      await captureRequest(request)
      return sseResponse(textTurnFrames())
    }

    const messages: ProviderRequest["messages"] = [
      { role: "user", content: [{ type: "text", text: "edit it" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "Weighing the options", signature: "c2ln" },
          { type: "redacted_thinking", data: "cmVk" },
          { type: "text", text: "Editing now." },
          { type: "tool_call", id: "toolu_1", name: "edit_file", input: { path: "a.ts" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", toolCallId: "toolu_1", text: "ok" }] },
    ]

    await collectEvents(baseRequest({ reasoningEffort: "high", messages }))

    // Thinking enabled: the blocks are replayed verbatim, thinking first, as the API requires.
    expect(captured[0]?.body.messages?.[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Weighing the options", signature: "c2ln" },
        { type: "redacted_thinking", data: "cmVk" },
        { type: "text", text: "Editing now." },
        { type: "tool_use", id: "toolu_1", name: "edit_file", input: { path: "a.ts" } },
      ],
    })

    // Thinking disabled: the same history drops the thinking blocks from the wire.
    captured.length = 0
    respond = async (request) => {
      await captureRequest(request)
      return sseResponse(textTurnFrames())
    }
    await collectEvents(baseRequest({ messages }))
    expect(captured[0]?.body.thinking).toBeUndefined()
    expect(captured[0]?.body.messages?.[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Editing now." },
        { type: "tool_use", id: "toolu_1", name: "edit_file", input: { path: "a.ts" } },
      ],
    })
  })

  test("thinking budgets follow effort and require a reasoning model", async () => {
    const cases: Array<{ modelId: string; effort?: "low" | "medium" | "high"; budget?: number }> = [
      { modelId: "claude-fable-5", effort: "low", budget: 4096 },
      { modelId: "claude-fable-5", effort: "high", budget: 24_576 },
      { modelId: "claude-haiku-4-5-20251001", effort: "high", budget: undefined },
      { modelId: "claude-fable-5", effort: undefined, budget: undefined },
    ]
    for (const testCase of cases) {
      captured.length = 0
      respond = async (request) => {
        await captureRequest(request)
        return sseResponse(textTurnFrames())
      }
      await collectEvents(baseRequest({ model: model(testCase.modelId), reasoningEffort: testCase.effort }))
      const thinking = captured[0]?.body.thinking
      if (testCase.budget === undefined) expect(thinking).toBeUndefined()
      else expect(thinking).toEqual({ type: "enabled", budget_tokens: testCase.budget })
    }
  })
})

describe("AnthropicProvider failures and retries", () => {
  test("retries a 429 with retry-after and succeeds on the second attempt", async () => {
    let calls = 0
    respond = async (request) => {
      calls += 1
      if (calls === 1) {
        return new Response(
          JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }),
          { status: 429, headers: { "retry-after": "0", "content-type": "application/json" } },
        )
      }
      await captureRequest(request)
      return sseResponse(textTurnFrames())
    }

    const events = await collectEvents(baseRequest())

    expect(calls).toBe(2)
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" })
    expect(captured.length).toBe(1)
  })

  test("a non-retryable status throws ProviderHttpError with status and retryAfterMs", async () => {
    let calls = 0
    respond = () => {
      calls += 1
      return new Response(JSON.stringify({ type: "error", error: { message: "bad request: max_tokens" } }), {
        status: 400,
        headers: { "retry-after": "3", "content-type": "application/json" },
      })
    }

    let thrown: unknown
    try {
      await collectEvents(baseRequest())
    } catch (error) {
      thrown = error
    }

    expect(calls).toBe(1)
    expect(thrown).toBeInstanceOf(ProviderHttpError)
    const providerError = thrown as ProviderHttpError
    expect(providerError.status).toBe(400)
    expect(providerError.retryAfterMs).toBe(3000)
    expect(providerError.message).toContain("400")
    expect(providerError.message).toContain("max_tokens")
    expect(providerError.message).not.toContain("test-api-key")
  })

  test("redacts credential-shaped content echoed in a non-2xx body", async () => {
    // A debug proxy or gateway can echo the x-api-key header (or key text) in its error page.
    respond = () =>
      new Response("rejected x-api-key: test-api-key (also saw Bearer sk-echo1234567890abcd)", {
        status: 401,
      })

    let thrown: unknown
    try {
      await collectEvents(baseRequest())
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ProviderHttpError)
    const message = (thrown as ProviderHttpError).message
    expect(message).toContain("401")
    expect(message).toContain("[REDACTED]")
    expect(message).not.toContain("test-api-key")
    expect(message).not.toContain("sk-echo1234567890abcd")
  })

  test("an HTTP-date retry-after header parses to a forward delay", async () => {
    respond = () =>
      new Response("busy", {
        status: 400,
        headers: { "retry-after": new Date(Date.now() + 5000).toUTCString() },
      })

    let thrown: unknown
    try {
      await collectEvents(baseRequest())
    } catch (error) {
      thrown = error
    }

    const providerError = thrown as ProviderHttpError
    expect(providerError).toBeInstanceOf(ProviderHttpError)
    expect(providerError.retryAfterMs).toBeGreaterThanOrEqual(3000)
    expect(providerError.retryAfterMs).toBeLessThanOrEqual(5000)
  })

  test("an SSE error event mid-stream throws ProviderHttpError after the emitted events", async () => {
    respond = () =>
      sseResponse([
        frame("message_start", { type: "message_start", message: { usage: { input_tokens: 3 } } }),
        frame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hal" },
        }),
        frame("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
      ])

    const provider = new AnthropicProvider()
    const events: ProviderStreamEvent[] = []
    const iterate = async () => {
      for await (const event of provider.stream(baseRequest(), new AbortController().signal)) {
        events.push(event)
      }
    }

    await expect(iterate()).rejects.toThrow("Overloaded")
    expect(events).toEqual([{ type: "text_delta", text: "Hal" }])
  })

  test("a stream that ends without message_stop or stop_reason throws", async () => {
    respond = () =>
      sseResponse([
        frame("message_start", { type: "message_start", message: { usage: { input_tokens: 3 } } }),
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "cut" },
        }),
      ])

    await expect(collectEvents(baseRequest())).rejects.toThrow("before message_stop")
  })

  test("a missing ANTHROPIC_API_KEY is refused before any request", async () => {
    const saved = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      await expect(collectEvents(baseRequest())).rejects.toThrow("ANTHROPIC_API_KEY")
    } finally {
      restoreEnv("ANTHROPIC_API_KEY", saved)
    }
    expect(captured.length).toBe(0)
  })
})

describe("AnthropicProvider abort", () => {
  test("aborting mid-stream yields done aborted instead of throwing", async () => {
    respond = () =>
      holdOpenSseResponse([
        frame("message_start", { type: "message_start", message: { usage: { input_tokens: 9 } } }),
        frame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "partial" },
        }),
      ])

    const controller = new AbortController()
    const provider = new AnthropicProvider()
    const events: ProviderStreamEvent[] = []
    for await (const event of provider.stream(baseRequest(), controller.signal)) {
      events.push(event)
      if (event.type === "text_delta") setTimeout(() => controller.abort(), 10)
    }

    expect(events).toEqual([
      { type: "text_delta", text: "partial" },
      { type: "done", stopReason: "aborted" },
    ])
  })

  test("aborting synchronously between events yields done aborted", async () => {
    respond = () =>
      holdOpenSseResponse([
        frame("message_start", { type: "message_start", message: { usage: { input_tokens: 9 } } }),
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "one" },
        }),
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "two" },
        }),
      ])

    const controller = new AbortController()
    const provider = new AnthropicProvider()
    const events: ProviderStreamEvent[] = []
    for await (const event of provider.stream(baseRequest(), controller.signal)) {
      events.push(event)
      if (event.type === "text_delta") controller.abort()
    }

    expect(events).toEqual([
      { type: "text_delta", text: "one" },
      { type: "done", stopReason: "aborted" },
    ])
  })

  test("a signal aborted before connecting yields only done aborted", async () => {
    const controller = new AbortController()
    controller.abort()

    const events = await collectEvents(baseRequest(), controller.signal)

    expect(events).toEqual([{ type: "done", stopReason: "aborted" }])
    expect(captured.length).toBe(0)
  })
})
