/**
 * Shared contracts for the first-party CodeSplash engine. Provider adapters, tools, prompt
 * assembly, and the agentic loop each depend on this file and never on each other; the loop
 * composes them. Keep this file free of dependencies beyond core types and platform builtins so
 * modules can be built and tested in isolation.
 */
import type { PermissionMode, SessionPolicy } from "../../core/index.ts"

/** Re-exported so permission modules can stay contracts-only importers. */
export type { PermissionMode }

/* ---------------------------------- providers ---------------------------------- */

/** Wire protocol an adapter speaks. Runtime provider ids are plain strings (see ModelInfo). */
export type ProviderId = "anthropic" | "openai"

/** Catalog price estimates in USD per million tokens. */
export type ModelPricing = {
  inputPerMTok: number
  outputPerMTok: number
  /** Defaults to inputPerMTok / 10 at use sites when absent. */
  cachedInputPerMTok?: number
}

export type ModelInfo = {
  id: string
  displayName: string
  /** Runtime provider id: "anthropic", "openai", or a custom [providers.*] config key. */
  provider: string
  /** Which adapter dialect the model's provider speaks. */
  protocol: ProviderId
  contextWindow: number
  /** Maximum output tokens to request per response. */
  maxOutputTokens: number
  /** Default model when this provider is the session's provider. */
  isDefault: boolean
  supportsReasoning: boolean
  pricing?: ModelPricing
}

/** A configured, available provider: identity plus the adapter client constructed for it. */
export type ProviderRuntime = {
  id: string
  protocol: ProviderId
  displayName: string
  keyEnvVar: string
  requiresKey: boolean
  baseUrl?: string
  client: ProviderClient
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

/* --------------------------------- permissions --------------------------------- */

/** What a tool call would touch, extracted before it runs so rules can be matched against it. */
export type PermissionTargets = {
  /** The shell command line (bash tool). */
  command?: string
  /** RESOLVED ABSOLUTE paths the call reads or mutates (file tools). */
  paths?: string[]
  /** Hostname of the URL being fetched (web_fetch). */
  urlHost?: string
}

/** Verdict from the permission engine for one tool call, evaluated before the call runs. */
export type PermissionDecision =
  | { kind: "allow"; reason: string }
  | { kind: "deny"; reason: string }
  | {
      kind: "ask"
      /** True for dangerous-floor approvals: never auto-approved, never persistable. */
      alwaysAsk?: boolean
      /** Rule an acceptAlways decision would persist; absent → no "always allow" choice. */
      persistableRule?: string
      reason?: string
    }
  /** Fall through to the tool's own permission() flow, unchanged. */
  | { kind: "default" }

/**
 * The permission engine as the loop and tools consume it. Implemented by
 * engines/codesplash/permissions.ts; kept here so contracts-only modules can depend on it.
 */
export interface PermissionRuntime {
  readonly mode: PermissionMode
  setMode(mode: PermissionMode): void
  decide(toolName: string, targets: PermissionTargets | undefined, isReadOnly: boolean): PermissionDecision
  /** Read-path denial for grep content access; reason string when denied. */
  isReadDenied(resolvedPath: string, toolName: string): string | undefined
  persistGrant(rule: string): Promise<void>
  reload?(): Promise<void>
}

/* ------------------------------------ tools ------------------------------------ */

export type ToolContext = {
  cwd: string
  policy: SessionPolicy
  signal: AbortSignal
  /** Permission engine for this session; absent when no runtime was injected (e.g. tests). */
  permissions?: PermissionRuntime
  /** Native execution policy for trusted HTTP tool implementations, checked on every hop. */
  checkNetwork?: (url: string) => void
  /** Trusted transport connecting through the same DNS-pinning grant broker as shell commands. */
  fetchNetwork?: (url: string, init: RequestInit) => Promise<Response>
  /** Worker-only values for source sanitization before shell output truncation. */
  secretValues?: readonly string[]
  /** Trusted worker sanitizer; apply to complete content before slicing or truncation. */
  sanitizeOutput?: (text: string) => string
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
  /**
   * What this call would touch, for permission-rule matching. May throw ToolInputError; the
   * loop then falls through to the default path and lets run() surface the input error.
   */
  permissionTargets?(input: unknown, context: ToolContext): PermissionTargets
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

/**
 * The plan-mode tools are intrinsic like ask_user: their specs come from the registry, but the
 * loop executes them itself (mode switch, plan-approval request) and never calls run().
 */
export const ENTER_PLAN_MODE_TOOL_NAME = "enter_plan_mode"
export const EXIT_PLAN_MODE_TOOL_NAME = "exit_plan_mode"

/* -------------------------------- prompt assembly -------------------------------- */

export type SystemPromptOptions = {
  cwd: string
  model: ModelInfo
  policy: SessionPolicy
  toolNames: string[]
  /** Permission mode the session opened in (or switched to); shapes the plan-mode section. */
  permissionMode?: PermissionMode
  /** Absent means trusted; false skips project rule discovery and says why in the prompt. */
  workspaceTrusted?: boolean
}

export type ProjectRulesFile = {
  path: string
  text: string
}
