/**
 * Shared contracts for the first-party CodeSplash engine. Provider adapters, tools, prompt
 * assembly, and the agentic loop each depend on this file and never on each other; the loop
 * composes them. Keep this file free of dependencies beyond core types and platform builtins so
 * modules can be built and tested in isolation.
 */
import type { SessionPolicy } from "../../core/index.ts"

/* ---------------------------------- providers ---------------------------------- */

export type ProviderId = "anthropic" | "openai"

export type ModelInfo = {
  id: string
  displayName: string
  provider: ProviderId
  contextWindow: number
  /** Maximum output tokens to request per response. */
  maxOutputTokens: number
  /** Default model when this provider is the session's provider. */
  isDefault: boolean
  supportsReasoning: boolean
}

export type ReasoningEffort = "low" | "medium" | "high"

export type TextBlock = { type: "text"; text: string }
export type ImageBlock = { type: "image"; mediaType: string; base64Data: string }
/**
 * Extended-thinking output. Anthropic requires the unmodified thinking blocks (with their
 * signatures) to be replayed at the head of the assistant message that carries tool_use, so the
 * loop stores them in history verbatim.
 */
export type ThinkingBlock = { type: "thinking"; text: string; signature?: string }
export type RedactedThinkingBlock = { type: "redacted_thinking"; data: string }
export type ToolCallBlock = { type: "tool_call"; id: string; name: string; input: unknown }
export type ToolResultBlock = {
  type: "tool_result"
  toolCallId: string
  text: string
  isError?: boolean
}
export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ToolCallBlock
  | ToolResultBlock

export type ChatMessage = { role: "user" | "assistant"; content: ContentBlock[] }

export type ToolSpec = {
  name: string
  description: string
  /** JSON Schema for the input object. */
  inputSchema: Record<string, unknown>
}

export type ProviderRequest = {
  model: ModelInfo
  system: string
  messages: ChatMessage[]
  tools: ToolSpec[]
  /** Applied only when the model supportsReasoning. */
  reasoningEffort?: ReasoningEffort
}

export type ProviderUsage = {
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "aborted"

/**
 * Adapters assemble partial tool-call JSON internally; a tool_call event always carries fully
 * parsed input. A stream always terminates with exactly one `done` event; aborting via the
 * request signal yields {type:"done", stopReason:"aborted"} rather than a throw.
 */
export type ProviderStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  /** A completed thinking block (text plus signature) the loop must preserve in history. */
  | { type: "thinking"; text: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "usage"; usage: ProviderUsage }
  | { type: "done"; stopReason: StopReason }

export interface ProviderClient {
  readonly id: ProviderId
  /** Static catalog; exactly one entry has isDefault true. */
  readonly models: ModelInfo[]
  /**
   * Streams one assistant response. Implementations retry the initial connection through
   * `withRetries` (providers/retry.ts) and never retry after the first emitted event.
   */
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderStreamEvent>
}

/** HTTP failure carrying the classification the retry engine needs. */
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = "ProviderHttpError"
  }
}

export type RetryOptions = {
  /** Total attempts including the first; default 5. */
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  signal?: AbortSignal
}

/* ------------------------------------ tools ------------------------------------ */

export type ToolContext = {
  cwd: string
  policy: SessionPolicy
  signal: AbortSignal
}

export type ToolPermission =
  | { kind: "none" }
  | {
      kind: "approval"
      title: string
      detail: string
      /** Identical keys auto-approve after an acceptForSession decision; omit to always ask. */
      sessionKey?: string
    }

export type ToolOutcome = {
  /** Model-facing result text; tools truncate via truncateToolOutput before returning. */
  text: string
  isError?: boolean
  /** One-line transcript label, e.g. the command or path acted on. */
  label: string
  /** Workspace paths this call mutated; the loop diffs them after the call. */
  mutatedPaths?: string[]
  /** Present only from the todo tool; the loop emits plan.updated from it. */
  planSteps?: Array<{ text: string; completed: boolean }>
}

/**
 * A model-callable tool. Implementations validate their own input (throw ToolInputError for bad
 * or policy-refused input — with policy.sandbox === "read-only", mutating calls must be refused,
 * never silently skipped) and enforce their own output truncation.
 */
export interface HarnessTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  /** True when the call cannot change any state; read-only calls may run concurrently. */
  isReadOnly(input: unknown): boolean
  /** Permission required for this call under the given policy; evaluated before every call. */
  permission(input: unknown, context: ToolContext): ToolPermission
  run(input: unknown, context: ToolContext): Promise<ToolOutcome>
}

/** Invalid or policy-refused input; the loop converts it to an isError tool_result, not a crash. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ToolInputError"
  }
}

/**
 * The ask-user tool is intrinsic: the registry exposes its spec, but the loop executes it by
 * opening a "user-input" request and turning the user's decision into the tool result.
 */
export const ASK_USER_TOOL_NAME = "ask_user"

/* -------------------------------- prompt assembly -------------------------------- */

export type SystemPromptOptions = {
  cwd: string
  model: ModelInfo
  policy: SessionPolicy
  toolNames: string[]
}

export type ProjectRulesFile = {
  path: string
  text: string
}
