import { assertIdentityAllowed } from "../../../core/identity/policy.ts"
import { networkFetch, networkSocketOptions } from "../../../core/network.ts"
import { redactSensitiveText } from "../../../core/redaction.ts"
import type { ProviderClient, ProviderRequest, ProviderStreamEvent } from "../contracts.ts"
import { ProviderHttpError } from "../contracts.ts"
import { WireCacheTracker } from "./cache-diagnostics.ts"
import type { OpenAiProviderOptions } from "./openai.ts"
import { withRetries } from "./retry.ts"
import { parseSseStream } from "./sse.ts"

export function responsesBody(
  request: ProviderRequest,
  options: OpenAiProviderOptions,
): Record<string, unknown> {
  const input: unknown[] = []
  for (const message of request.messages)
    for (const block of message.content) {
      if (block.type === "text")
        input.push({
          role: message.role,
          content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text: block.text }],
        })
      else if (block.type === "image")
        input.push({
          role: "user",
          content: [{ type: "input_image", image_url: `data:${block.mediaType};base64,${block.base64Data}` }],
        })
      else if (block.type === "tool_call")
        input.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        })
      else if (block.type === "tool_result")
        input.push({ type: "function_call_output", call_id: block.toolCallId, output: block.text })
      else if (block.type === "provider_item" && block.provider === "openai-responses") input.push(block.item)
    }
  return {
    model: request.model.id,
    instructions: request.system,
    input,
    store: false,
    include: ["reasoning.encrypted_content"],
    max_output_tokens: request.model.maxOutputTokens,
    tools: request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false,
    })),
    ...(request.reasoningEffort && request.model.supportsReasoning
      ? { reasoning: { effort: request.reasoningEffort } }
      : {}),
    ...(options.serviceTier ? { service_tier: options.serviceTier } : {}),
  }
}
function endpoint(options: OpenAiProviderOptions): URL {
  const url = new URL(options.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com")
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error("Responses requires HTTPS or loopback HTTP")
  url.pathname = url.pathname.replace(/\/$/, "").replace(/\/v1$/, "") + "/v1/responses"
  return url
}
async function* websocketFrames(
  url: URL,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
): AsyncGenerator<unknown> {
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  const Socket = WebSocket as unknown as {
    new (target: URL, options: { headers: Record<string, string> }): WebSocket
  }
  const socket = new Socket(url, { headers, ...networkSocketOptions(url) })
  const queue: string[] = []
  let size = 0,
    ended = false,
    error: Error | undefined,
    wake: (() => void) | undefined
  const fail = (message: string) => {
    error = new Error(message)
    ended = true
    socket.close()
    wake?.()
  }
  const abort = () => {
    ended = true
    socket.close()
    wake?.()
  }
  const timer = setTimeout(() => fail("Responses WebSocket deadline exceeded"), 120000)
  socket.addEventListener("open", () => {
    if (signal.aborted) abort()
    else socket.send(JSON.stringify({ type: "response.create", ...(body as object) }))
  })
  socket.addEventListener("message", (event) => {
    const text = typeof event.data === "string" ? event.data : ""
    if (
      !text ||
      text.length > 8 * 1024 * 1024 ||
      queue.length >= 512 ||
      size + text.length > 16 * 1024 * 1024
    )
      return fail("Responses WebSocket buffer exceeded")
    queue.push(text)
    size += text.length
    wake?.()
  })
  socket.addEventListener("error", () => fail("Responses WebSocket failed"))
  socket.addEventListener("close", () => {
    ended = true
    wake?.()
  })
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  try {
    for (;;) {
      if (queue.length) {
        const text = queue.shift()!
        size -= text.length
        yield JSON.parse(text)
      } else if (ended) {
        if (error && !signal.aborted) throw error
        break
      } else
        await new Promise<void>((resolve) => {
          wake = resolve
        })
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
    socket.close()
  }
}
export function createResponsesProvider(options: OpenAiProviderOptions): ProviderClient {
  const tracker = new WireCacheTracker()
  return {
    id: "openai",
    models: options.models ?? [],
    async *stream(request, signal) {
      const key = options.token ? await options.token() : process.env[options.keyEnvVar ?? "OPENAI_API_KEY"],
        headers: Record<string, string> = {
          "content-type": "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body = responsesBody(request, options)
      if (key && !options.token) assertIdentityAllowed("api-key", undefined, options.authProvider ?? "openai")
      tracker.inspect({ ...body, transport: options.transport ?? "sse" })
      let finished = false,
        tools = 0
      try {
        let frames: AsyncIterable<unknown>
        if (options.transport === "websocket")
          frames = websocketFrames(endpoint(options), body, headers, signal)
        else {
          const response = await withRetries(
            async () => {
              const r = await networkFetch(endpoint(options), {
                method: "POST",
                headers,
                body: JSON.stringify({ ...body, stream: true }),
                signal,
                redirect: "error",
              })
              if (!r.ok) {
                await r.body?.cancel()
                throw new ProviderHttpError(
                  `Responses HTTP ${r.status}`,
                  r.status,
                  r.headers.has("retry-after") ? Number(r.headers.get("retry-after")) * 1000 : undefined,
                )
              }
              return r
            },
            { signal },
          )
          frames = (async function* () {
            for await (const frame of parseSseStream(response, signal)) {
              if (frame.data.length > 8 * 1024 * 1024) throw new Error("Responses event exceeds limit")
              yield JSON.parse(frame.data)
            }
          })()
        }
        for await (const raw of frames) {
          if (!raw || typeof raw !== "object") throw new Error("Malformed Responses event")
          const e = raw as {
            type?: string
            delta?: string
            item?: Record<string, unknown>
            response?: {
              status?: string
              usage?: {
                input_tokens?: number
                output_tokens?: number
                input_tokens_details?: { cached_tokens?: number }
              }
            }
            error?: { message?: string }
          }
          if (e.type === "response.output_text.delta" && typeof e.delta === "string")
            yield { type: "text_delta", text: e.delta }
          else if (e.type === "response.reasoning_summary_text.delta" && typeof e.delta === "string")
            yield { type: "reasoning_delta", text: e.delta }
          else if (e.type === "response.output_item.done" && e.item?.type === "function_call") {
            if (
              typeof e.item.call_id !== "string" ||
              typeof e.item.name !== "string" ||
              typeof e.item.arguments !== "string"
            )
              throw new Error("Invalid Responses function call")
            let input: unknown
            try {
              input = JSON.parse(e.item.arguments)
            } catch {
              input = e.item.arguments
            }
            tools++
            yield { type: "tool_call", id: e.item.call_id, name: e.item.name, input }
          } else if (e.type === "response.output_item.done" && e.item?.type === "reasoning")
            yield { type: "provider_item", provider: "openai-responses", item: e.item }
          else if (e.type === "response.completed" || e.type === "response.incomplete") {
            const u = e.response?.usage
            if (u) {
              const cached = u.input_tokens_details?.cached_tokens ?? 0
              for (const n of [u.input_tokens, u.output_tokens, cached])
                if (n !== undefined && (!Number.isSafeInteger(n) || n < 0))
                  throw new Error("Invalid Responses usage")
              if (u.input_tokens !== undefined && cached > u.input_tokens)
                throw new Error("Invalid Responses cached usage")
              tracker.usage(cached)
              yield {
                type: "usage",
                usage: {
                  inputTokens: u.input_tokens === undefined ? undefined : u.input_tokens - cached,
                  cachedInputTokens: cached,
                  outputTokens: u.output_tokens,
                },
              }
            }
            if (e.type === "response.incomplete" && tools)
              throw new Error("Incomplete Responses tool turn; no execution attempted")
            finished = true
            yield {
              type: "done",
              stopReason: e.type === "response.incomplete" ? "max_tokens" : tools ? "tool_use" : "end_turn",
            }
            break
          } else if (e.type === "error" || e.type === "response.failed" || e.type === "response.cancelled")
            throw new Error(
              `Responses failed: ${redactSensitiveText(e.error?.message ?? "provider failure").slice(0, 1000)}`,
            )
        }
        if (!finished && !signal.aborted)
          throw new Error("Responses stream ended before completion; no replay attempted")
      } catch (error) {
        if (!signal.aborted) throw error
      }
      if (signal.aborted && !finished) yield { type: "done", stopReason: "aborted" }
    },
  }
}
