/**
 * OpenAI Chat Completions streaming adapter. Connects through withRetries and never retries after
 * the first emitted event; aborting the request signal yields {type:"done", stopReason:"aborted"}
 * instead of throwing. API keys never appear in error messages: response bodies embedded in
 * errors pass through redactSensitiveText first (a gateway or proxy can echo the request's
 * Authorization header back in its error page).
 */
import { redactSensitiveText } from "../../../core/index.ts"
import {
  type ChatMessage,
  type ModelInfo,
  type ProviderClient,
  ProviderHttpError,
  type ProviderRequest,
  type ProviderStreamEvent,
  type ProviderUsage,
  type StopReason,
  type ToolSpec,
} from "../contracts.ts"
import { withRetries } from "./retry.ts"
import { parseSseStream } from "./sse.ts"

const DEFAULT_BASE_URL = "https://api.openai.com"
/** Non-2xx body excerpt carried into ProviderHttpError; bounded so errors stay small. */
const ERROR_BODY_LIMIT = 2000

export const openaiModels: ModelInfo[] = [
  {
    id: "gpt-5.1",
    displayName: "GPT-5.1",
    provider: "openai",
    contextWindow: 256000,
    maxOutputTokens: 32768,
    isDefault: true,
    supportsReasoning: true,
  },
  {
    id: "gpt-5.1-mini",
    displayName: "GPT-5.1 Mini",
    provider: "openai",
    contextWindow: 256000,
    maxOutputTokens: 32768,
    isDefault: false,
    supportsReasoning: false,
  },
]

export function createOpenAiProvider(): ProviderClient {
  return {
    id: "openai",
    models: openaiModels,
    stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderStreamEvent> {
      return streamCompletion(request, signal)
    },
  }
}

/* --------------------------------- wire shapes --------------------------------- */

type WireToolCallFragment = {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

type WireChunk = {
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: WireToolCallFragment[] }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  } | null
  /** Mid-stream failure frame; the connection may close afterwards without [DONE]. */
  error?: { message?: string; type?: string }
}

type PendingToolCall = { id?: string; name?: string; argumentsJson: string }

/* ---------------------------------- streaming ---------------------------------- */

async function* streamCompletion(
  request: ProviderRequest,
  signal: AbortSignal,
): AsyncGenerator<ProviderStreamEvent> {
  let response: Response
  try {
    response = await withRetries(() => connect(request, signal), { signal })
  } catch (error) {
    if (signal.aborted) {
      yield { type: "done", stopReason: "aborted" }
      return
    }
    throw error
  }

  const pending = new Map<number, PendingToolCall>()
  let stopReason: StopReason | undefined
  let sawDone = false
  try {
    for await (const frame of parseSseStream(response, signal)) {
      if (frame.data === "[DONE]") {
        sawDone = true
        break
      }
      const chunk = JSON.parse(frame.data) as WireChunk
      if (chunk.error) {
        throw new ProviderHttpError(
          `OpenAI stream error${chunk.error.type ? ` (${chunk.error.type})` : ""}: ${redactSensitiveText(chunk.error.message ?? "no message")}`,
          undefined,
        )
      }
      const choice = chunk.choices?.[0]
      const content = choice?.delta?.content
      if (typeof content === "string" && content.length > 0) {
        yield { type: "text_delta", text: content }
      }
      for (const fragment of choice?.delta?.tool_calls ?? []) {
        accumulateFragment(pending, fragment)
      }
      if (choice?.finish_reason) {
        stopReason ??= mapFinishReason(choice.finish_reason)
        yield* flushToolCalls(pending)
      }
      if (chunk.usage) yield { type: "usage", usage: mapUsage(chunk.usage) }
    }
  } catch (error) {
    if (signal.aborted) {
      yield { type: "done", stopReason: "aborted" }
      return
    }
    throw error
  }
  if (signal.aborted) {
    yield { type: "done", stopReason: "aborted" }
    return
  }
  // A connection that closes before any finish_reason or [DONE] delivered a broken response;
  // completing it as end_turn would record a silently truncated turn.
  if (!sawDone && stopReason === undefined) {
    throw new ProviderHttpError("OpenAI stream ended before completion", undefined)
  }
  yield* flushToolCalls(pending)
  yield { type: "done", stopReason: stopReason ?? "end_turn" }
}

async function connect(request: ProviderRequest, signal: AbortSignal): Promise<Response> {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error("OPENAI_API_KEY is not set; the harness cannot reach OpenAI")
  const base = (process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(buildBody(request)),
    signal,
  })
  if (!response.ok) {
    // Redact before truncating so a credential the body echoes is scrubbed whole, never split.
    const detail = redactSensitiveText(await response.text().catch(() => "")).slice(0, ERROR_BODY_LIMIT)
    throw new ProviderHttpError(
      `OpenAI request failed with status ${response.status}${detail ? `: ${detail}` : ""}`,
      response.status,
      readRetryAfterMs(response),
    )
  }
  if (!response.body) {
    throw new ProviderHttpError("OpenAI response carried no body", response.status)
  }
  return response
}

function readRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after")
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

function accumulateFragment(pending: Map<number, PendingToolCall>, fragment: WireToolCallFragment): void {
  const index = fragment.index ?? 0
  const entry = pending.get(index) ?? { argumentsJson: "" }
  if (fragment.id) entry.id = fragment.id
  if (fragment.function?.name) entry.name = fragment.function.name
  if (fragment.function?.arguments) entry.argumentsJson += fragment.function.arguments
  pending.set(index, entry)
}

function* flushToolCalls(pending: Map<number, PendingToolCall>): Generator<ProviderStreamEvent> {
  const indexes = [...pending.keys()].sort((a, b) => a - b)
  for (const index of indexes) {
    const call = pending.get(index)
    if (!call) continue
    yield {
      type: "tool_call",
      id: call.id ?? `tool_call_${index}`,
      name: call.name ?? "",
      input: parseToolInput(call.argumentsJson),
    }
  }
  pending.clear()
}

/** Malformed arguments pass through raw so tool input validation reports them as isError results. */
function parseToolInput(argumentsJson: string): unknown {
  const trimmed = argumentsJson.trim()
  if (trimmed === "") return {}
  try {
    return JSON.parse(trimmed)
  } catch {
    return argumentsJson
  }
}

function mapFinishReason(reason: string): StopReason {
  if (reason === "tool_calls" || reason === "function_call") return "tool_use"
  if (reason === "length") return "max_tokens"
  return "end_turn"
}

/**
 * OpenAI's prompt_tokens already includes prompt_tokens_details.cached_tokens; reporting the
 * cached reads exclusively (Anthropic semantics) keeps the loop's uniform
 * input + cached + output context sum correct for both providers.
 */
function mapUsage(usage: NonNullable<WireChunk["usage"]>): ProviderUsage {
  const mapped: ProviderUsage = {}
  const cached = usage.prompt_tokens_details?.cached_tokens
  if (typeof usage.prompt_tokens === "number") {
    mapped.inputTokens =
      typeof cached === "number" ? Math.max(0, usage.prompt_tokens - cached) : usage.prompt_tokens
  }
  if (typeof cached === "number") mapped.cachedInputTokens = cached
  if (typeof usage.completion_tokens === "number") mapped.outputTokens = usage.completion_tokens
  return mapped
}

/* --------------------------------- request body --------------------------------- */

function buildBody(request: ProviderRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model.id,
    messages: toWireMessages(request.system, request.messages),
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: request.model.maxOutputTokens,
  }
  if (request.tools.length > 0) body.tools = request.tools.map(toWireTool)
  if (request.model.supportsReasoning && request.reasoningEffort) {
    body.reasoning_effort = request.reasoningEffort
  }
  return body
}

function toWireTool(tool: ToolSpec): Record<string, unknown> {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }
}

function toWireMessages(system: string, messages: ChatMessage[]): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = [{ role: "system", content: system }]
  for (const message of messages) {
    if (message.role === "assistant") wire.push(assistantWireMessage(message))
    else wire.push(...userWireMessages(message))
  }
  return wire
}

function assistantWireMessage(message: ChatMessage): Record<string, unknown> {
  let text = ""
  const toolCalls: Array<Record<string, unknown>> = []
  for (const block of message.content) {
    if (block.type === "text") text += block.text
    else if (block.type === "tool_call") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      })
    }
  }
  const entry: Record<string, unknown> = { role: "assistant", content: text.length > 0 ? text : null }
  if (toolCalls.length > 0) entry.tool_calls = toolCalls
  return entry
}

/**
 * tool_result blocks become role:"tool" messages, emitted before any user content so they directly
 * follow the assistant tool_calls message on the wire.
 */
function userWireMessages(message: ChatMessage): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = []
  const parts: Array<{ kind: "text"; text: string } | { kind: "image"; url: string }> = []
  for (const block of message.content) {
    if (block.type === "tool_result") {
      wire.push({ role: "tool", tool_call_id: block.toolCallId, content: block.text })
    } else if (block.type === "text") {
      parts.push({ kind: "text", text: block.text })
    } else if (block.type === "image") {
      parts.push({ kind: "image", url: `data:${block.mediaType};base64,${block.base64Data}` })
    }
  }
  if (parts.length > 0) {
    const hasImage = parts.some((part) => part.kind === "image")
    const content = hasImage
      ? parts.map((part) =>
          part.kind === "image"
            ? { type: "image_url", image_url: { url: part.url } }
            : { type: "text", text: part.text },
        )
      : parts.map((part) => (part.kind === "text" ? part.text : "")).join("\n")
    wire.push({ role: "user", content })
  }
  return wire
}
