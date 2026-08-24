/**
 * Anthropic Messages API adapter. The initial connection goes through withRetries; nothing is
 * retried after the first emitted event. API keys never appear in error messages: response bodies
 * embedded in errors pass through redactSensitiveText first (a gateway or proxy can echo the
 * request's x-api-key header back in its error page).
 */
import { redactSensitiveText } from "../../../core/index.ts"
import {
  type ChatMessage,
  type ContentBlock,
  type ModelInfo,
  type ProviderClient,
  ProviderHttpError,
  type ProviderRequest,
  type ProviderStreamEvent,
  type ProviderUsage,
  type ReasoningEffort,
  type StopReason,
  type ToolSpec,
} from "../contracts.ts"
import { withRetries } from "./retry.ts"
import { parseSseStream } from "./sse.ts"

const DEFAULT_BASE_URL = "https://api.anthropic.com"
const ANTHROPIC_VERSION = "2023-06-01"
const ERROR_BODY_MAX_CHARS = 600

/** Thinking budget tokens per effort; applied only when the model supportsReasoning. */
const THINKING_BUDGETS: Record<ReasoningEffort, number> = {
  low: 4096,
  medium: 12_288,
  high: 24_576,
}

export const anthropicModels: ModelInfo[] = [
  {
    id: "claude-fable-5",
    displayName: "Claude Fable 5",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    isDefault: true,
    supportsReasoning: true,
  },
  {
    id: "claude-opus-5",
    displayName: "Claude Opus 5",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    isDefault: false,
    supportsReasoning: true,
  },
  {
    id: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    isDefault: false,
    supportsReasoning: true,
  },
  {
    id: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    isDefault: false,
    supportsReasoning: false,
  },
]

export class AnthropicProvider implements ProviderClient {
  readonly id = "anthropic" as const
  readonly models = anthropicModels

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderStreamEvent> {
    let response: Response
    try {
      response = await connect(request, signal)
    } catch (error) {
      if (signal.aborted) {
        yield { type: "done", stopReason: "aborted" }
        return
      }
      throw error
    }
    yield* mapMessagesStream(response, signal)
  }
}

export function createAnthropicProvider(): ProviderClient {
  return new AnthropicProvider()
}

async function connect(request: ProviderRequest, signal: AbortSignal): Promise<Response> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error("anthropic: ANTHROPIC_API_KEY is not set")
  const baseUrl = (process.env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  const body = JSON.stringify(buildRequestBody(request))
  return withRetries(
    async () => {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body,
        signal,
      })
      if (!response.ok) throw await httpError(response)
      return response
    },
    { signal },
  )
}

async function httpError(response: Response): Promise<ProviderHttpError> {
  let detail = ""
  try {
    // Redact before truncating so a credential the body echoes is scrubbed whole, never split.
    detail = redactSensitiveText(await response.text())
      .slice(0, ERROR_BODY_MAX_CHARS)
      .trim()
  } catch {
    detail = ""
  }
  const message =
    detail === "" ? `anthropic: HTTP ${response.status}` : `anthropic: HTTP ${response.status}: ${detail}`
  return new ProviderHttpError(message, response.status, retryAfterMs(response.headers.get("retry-after")))
}

function retryAfterMs(header: string | null): number | undefined {
  if (header === null || header.trim() === "") return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(header)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - Date.now())
}

/* ------------------------------ request wire mapping ------------------------------ */

type WireBlock = Record<string, unknown>

function buildRequestBody(request: ProviderRequest): Record<string, unknown> {
  const thinkingEnabled = request.model.supportsReasoning && request.reasoningEffort !== undefined
  const body: Record<string, unknown> = {
    model: request.model.id,
    max_tokens: request.model.maxOutputTokens,
    messages: request.messages.map((message) => toWireMessage(message, thinkingEnabled)),
    stream: true,
  }
  if (request.system !== "") body.system = request.system
  if (request.tools.length > 0) body.tools = request.tools.map(toWireTool)
  if (thinkingEnabled && request.reasoningEffort !== undefined) {
    body.thinking = { type: "enabled", budget_tokens: THINKING_BUDGETS[request.reasoningEffort] }
  }
  return body
}

/**
 * Thinking blocks from history are replayed verbatim while thinking is enabled (the API requires
 * the assistant message carrying tool_use to start with them) and dropped when it is not.
 */
function toWireMessage(
  message: ChatMessage,
  includeThinking: boolean,
): { role: "user" | "assistant"; content: WireBlock[] } {
  const content = message.content.filter(
    (block) => includeThinking || (block.type !== "thinking" && block.type !== "redacted_thinking"),
  )
  return { role: message.role, content: content.map(toWireBlock) }
}

function toWireBlock(block: ContentBlock): WireBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text }
    case "thinking":
      return { type: "thinking", thinking: block.text, signature: block.signature ?? "" }
    case "redacted_thinking":
      return { type: "redacted_thinking", data: block.data }
    case "image":
      return {
        type: "image",
        source: { type: "base64", media_type: block.mediaType, data: block.base64Data },
      }
    case "tool_call":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input ?? {} }
    case "tool_result": {
      const wire: WireBlock = { type: "tool_result", tool_use_id: block.toolCallId, content: block.text }
      if (block.isError) wire.is_error = true
      return wire
    }
  }
}

function toWireTool(tool: ToolSpec): WireBlock {
  return { name: tool.name, description: tool.description, input_schema: tool.inputSchema }
}

/* ------------------------------- stream event mapping ------------------------------- */

type WireUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
}

type WireSseData = {
  type?: string
  index?: number
  message?: { usage?: WireUsage }
  content_block?: { type?: string; id?: string; name?: string; data?: string }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    signature?: string
    partial_json?: string
    stop_reason?: string
  }
  usage?: WireUsage
  error?: { type?: string; message?: string }
}

async function* mapMessagesStream(
  response: Response,
  signal: AbortSignal,
): AsyncIterable<ProviderStreamEvent> {
  const openToolUses = new Map<number, { id: string; name: string; inputJson: string }>()
  const openThinking = new Map<number, { text: string; signature: string }>()
  const usage: ProviderUsage = {}
  let stopReason: StopReason | undefined
  // Truncated tool JSON is expected when max_tokens lands mid input; the stop reason decides
  // whether it is an error, so the parse failure is buffered instead of thrown at block stop.
  let unparsedToolUse: { name: string } | undefined

  const requireParsedToolUses = (): void => {
    if (unparsedToolUse !== undefined && stopReason !== "max_tokens") {
      throw new ProviderHttpError(
        `anthropic: tool_use input for "${unparsedToolUse.name}" is not valid JSON`,
        undefined,
      )
    }
  }

  for await (const { data } of parseSseStream(response, signal)) {
    const parsed = parseData(data)
    if (parsed === undefined) continue
    switch (parsed.type) {
      case "message_start":
        mergeUsage(usage, parsed.message?.usage)
        break
      case "content_block_start": {
        const block = parsed.content_block
        if (block?.type === "tool_use" && typeof parsed.index === "number") {
          openToolUses.set(parsed.index, { id: block.id ?? "", name: block.name ?? "", inputJson: "" })
        } else if (block?.type === "thinking" && typeof parsed.index === "number") {
          openThinking.set(parsed.index, { text: "", signature: "" })
        } else if (block?.type === "redacted_thinking") {
          yield { type: "redacted_thinking", data: block.data ?? "" }
        }
        break
      }
      case "content_block_delta": {
        const delta = parsed.delta
        const openBlock = typeof parsed.index === "number" ? openThinking.get(parsed.index) : undefined
        if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text !== "") {
          yield { type: "text_delta", text: delta.text }
        } else if (
          delta?.type === "thinking_delta" &&
          typeof delta.thinking === "string" &&
          delta.thinking !== ""
        ) {
          if (openBlock) openBlock.text += delta.thinking
          yield { type: "reasoning_delta", text: delta.thinking }
        } else if (delta?.type === "signature_delta" && typeof delta.signature === "string") {
          if (openBlock) openBlock.signature += delta.signature
        } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const open = typeof parsed.index === "number" ? openToolUses.get(parsed.index) : undefined
          if (open) open.inputJson += delta.partial_json
        }
        break
      }
      case "content_block_stop": {
        if (typeof parsed.index !== "number") break
        const thinking = openThinking.get(parsed.index)
        if (thinking) {
          openThinking.delete(parsed.index)
          yield {
            type: "thinking",
            text: thinking.text,
            signature: thinking.signature === "" ? undefined : thinking.signature,
          }
          break
        }
        const open = openToolUses.get(parsed.index)
        if (!open) break
        openToolUses.delete(parsed.index)
        const input = parseToolInput(open)
        if (input.ok) yield { type: "tool_call", id: open.id, name: open.name, input: input.value }
        else unparsedToolUse = { name: open.name }
        break
      }
      case "message_delta": {
        const wireStop = parsed.delta?.stop_reason
        if (typeof wireStop === "string") stopReason = mapStopReason(wireStop)
        if (parsed.usage) {
          mergeUsage(usage, parsed.usage)
          yield { type: "usage", usage: { ...usage } }
        }
        break
      }
      case "message_stop":
        requireParsedToolUses()
        yield { type: "done", stopReason: stopReason ?? "end_turn" }
        return
      case "error":
        throw new ProviderHttpError(
          `anthropic: stream error (${parsed.error?.type ?? "unknown"}): ${redactSensitiveText(parsed.error?.message ?? "no message")}`,
          undefined,
        )
      default:
        break
    }
  }

  if (signal.aborted) {
    yield { type: "done", stopReason: "aborted" }
    return
  }
  if (stopReason !== undefined) {
    requireParsedToolUses()
    yield { type: "done", stopReason }
    return
  }
  throw new ProviderHttpError("anthropic: stream ended before message_stop", undefined)
}

function parseData(data: string): WireSseData | undefined {
  try {
    const parsed: unknown = JSON.parse(data)
    return typeof parsed === "object" && parsed !== null ? (parsed as WireSseData) : undefined
  } catch {
    return undefined
  }
}

function parseToolInput(open: { inputJson: string }): { ok: true; value: unknown } | { ok: false } {
  const json = open.inputJson.trim()
  if (json === "") return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(json) }
  } catch {
    return { ok: false }
  }
}

function mergeUsage(target: ProviderUsage, wire: WireUsage | undefined): void {
  if (!wire) return
  if (typeof wire.input_tokens === "number") target.inputTokens = wire.input_tokens
  if (typeof wire.cache_read_input_tokens === "number")
    target.cachedInputTokens = wire.cache_read_input_tokens
  if (typeof wire.output_tokens === "number") target.outputTokens = wire.output_tokens
}

function mapStopReason(wire: string): StopReason {
  if (wire === "tool_use") return "tool_use"
  if (wire === "max_tokens") return "max_tokens"
  return "end_turn"
}
