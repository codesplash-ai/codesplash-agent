/**
 * The CodeSplash turn state machine. Owns the ChatMessage history, streams provider responses,
 * runs tool rounds (read-only calls concurrently, mutating calls sequentially), gates calls
 * behind approval requests, and emits the normalized AgentEvent stream the harness UI consumes.
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { safeGitArguments, safeGitEnvironment } from "../../core/git-process.ts"
import {
  type AgentEvent,
  type AgentEventInput,
  createAgentEvent,
  type ItemStatus,
  type NativeEventIds,
  registerChildProcess,
  type SessionPolicy,
} from "../../core/index.ts"
import { compactMessages } from "./compaction.ts"
import {
  type ContextOptions,
  ContextTracker,
  estimateMessages,
  inspectContext,
  isContextOverflow,
  pruneToolResults,
  reminderText,
} from "./context.ts"
import {
  ASK_USER_TOOL_NAME,
  type ChatMessage,
  type ContentBlock,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  type HarnessTool,
  type ModelInfo,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRuntime,
  type PermissionTargets,
  type ProviderClient,
  ProviderHttpError,
  type ProviderRequest,
  type ProviderUsage,
  type ReasoningEffort,
  type RedactedThinkingBlock,
  type StopReason,
  type ThinkingBlock,
  type ToolCallBlock,
  type ToolContext,
  ToolInputError,
  type ToolResultBlock,
} from "./contracts.ts"
import { Guardian, type GuardianConfig } from "./guardian.ts"
import { derivePersistableRule } from "./permissions.ts"
import type { SandboxRuntime } from "./sandbox/contracts.ts"
import { READ_TOOL_OUTPUT, ToolOutputStore } from "./tool-output-store.ts"
import type { ToolRegistry } from "./tools/registry.ts"
import { parsePermissionRequest, REQUEST_PERMISSIONS_TOOL_NAME } from "./tools/request-permissions.ts"
import { truncateToolOutput } from "./tools/truncate.ts"

/** Tool rounds per turn before the harness forces the turn to end. */
export const MAX_TOOL_ROUNDS = 50
/** Concurrency cap for read-only tool calls within one round. */
export const READ_ONLY_CONCURRENCY = 4
/** Choice set understood by the existing A/S/D/C approval UI. */
export const APPROVAL_CHOICES = ["accept", "acceptForSession", "decline", "cancel"] as const
/** Choice set for the exit_plan_mode plan review. */
export const PLAN_APPROVAL_CHOICES = ["approve", "keepPlanning", "cancel"] as const
/** Approval-request cap on the plan text shown as the exit_plan_mode detail. */
export const PLAN_DETAIL_MAX_BYTES = 8 * 1024

/** Workspace-relative location of the plan file plan mode writes and exit_plan_mode reads. */
const PLAN_FILE_RELATIVE_PATH = join(".codesplash", "plan.md")
const PLAN_MODE_UNAVAILABLE_TEXT = "Plan mode is not available in this session."
const ENTER_PLAN_MODE_RESULT_TEXT =
  "Plan mode is on. Investigate read-only, write the plan to .codesplash/plan.md, then call exit_plan_mode."
const PLAN_APPROVED_RESULT_TEXT =
  "The user approved the plan. Plan mode is off — proceed with the implementation."
const KEEP_PLANNING_RESULT_TEXT = "The user chose to keep planning."

const GIT_DIFF_TIMEOUT_MS = 10_000
const LABEL_MAX_CHARS = 80

/** Nth consecutive identical tool call that is answered synthetically instead of executed. */
const DOOM_LOOP_SYNTHETIC_AT = 3
/** Nth consecutive identical tool call that force-ends the turn like the round cap does. */
const DOOM_LOOP_FORCED_END_AT = 5
const DOOM_LOOP_SYNTHETIC_TEXT =
  "This exact call was already made twice with the same result. Change your approach instead of repeating it."
const DOOM_LOOP_SKIPPED_TEXT = "Skipped: the harness detected a repeated tool-call loop and ended the turn."
const DOOM_LOOP_WARNING = "Repeated tool-call loop detected; ending the turn"

/**
 * Stamps every emitted AgentEvent with the codesplash envelope and a monotonic sequence starting
 * at firstSequence, mirroring how the Codex normalizer numbers events for the recorder.
 */
export class CodesplashEventFactory {
  #sequence: number

  constructor(
    readonly localSessionId: string,
    firstSequence = 0,
  ) {
    this.#sequence = firstSequence
  }

  /** The sequence the next event will receive. */
  get nextSequence(): number {
    return this.#sequence
  }

  event(
    providerEvent: string,
    native: NativeEventIds,
    input: AgentEventInput,
    sensitive = false,
  ): AgentEvent {
    return createAgentEvent(
      {
        engine: "codesplash",
        localSessionId: this.localSessionId,
        sequence: this.#sequence++,
        native: { threadId: this.localSessionId, ...native },
        providerEvent,
        sensitive,
      },
      input,
    )
  }
}

/** Produces a unified diff for the given workspace paths; injectable for tests. */
export type DiffCollector = (cwd: string, paths: string[]) => Promise<string>

/** A model id resolved through the provider registry to its catalog entry and adapter client. */
export type ResolvedModel = { model: ModelInfo; provider: ProviderClient }

export type CodesplashLoopOptions = {
  context?: ContextOptions
  outputStore?: ToolOutputStore
  cwd: string
  policy: SessionPolicy
  registry: ToolRegistry
  events: CodesplashEventFactory
  emit: (event: AgentEvent) => void
  /**
   * Permission engine consulted before every tool call (rules, modes, dangerous floor). Absent
   * (no runtime injected) → every call takes the tools' own default permission() flow and the
   * plan-mode tools report themselves unavailable.
   */
  permissions?: PermissionRuntime
  sandbox?: SandboxRuntime
  guardian?: GuardianConfig
  maxToolRounds?: number
  collectDiff?: DiffCollector
  /** `[codesplash].fallbackModel`: retried on a zero-event provider failure at turn start. */
  fallbackModel?: string
  /**
   * Resolves a model id to its catalog entry and client; undefined means unknown or unavailable.
   * Registry-backed at wiring time, so a resolved model's provider is always available.
   */
  resolveModel?: (id: string) => ResolvedModel | undefined
  /**
   * Cumulative usage a resumed session already recorded. Seeds the session totals so post-resume
   * `usage.updated` events continue the counts instead of restarting at zero.
   */
  initialUsage?: {
    inputTokens?: number
    cachedInputTokens?: number
    outputTokens?: number
    estimatedCostUsd?: number
    hasUnpricedUsage?: boolean
  }
}

export type TurnRequest = {
  provider: ProviderClient
  model: ModelInfo
  reasoningEffort?: ReasoningEffort
  system: string
  /** User text shown in the transcript event. */
  userText: string
  /** Full user content pushed into history (text plus image blocks). */
  userContent: ContentBlock[]
}

type PendingRequest = {
  choices: string[]
  settle: (choice: string) => void
}

type StreamResult =
  | { kind: "error"; error: unknown; sawEvent: boolean }
  | { kind: "aborted"; text: string }
  | {
      kind: "done"
      stopReason: Exclude<StopReason, "aborted">
      text: string
      thinking: Array<ThinkingBlock | RedactedThinkingBlock>
      toolCalls: ToolCallBlock[]
    }

export class CodesplashLoop {
  readonly #cwd: string
  readonly #policy: SessionPolicy
  readonly #registry: ToolRegistry
  readonly #events: CodesplashEventFactory
  readonly #emit: (event: AgentEvent) => void
  readonly #maxToolRounds: number
  readonly #collectDiff: DiffCollector
  readonly #history: ChatMessage[] = []
  readonly #sessionApprovals = new Set<string>()
  readonly #pendingRequests = new Map<string, PendingRequest>()
  readonly #fallbackModel: string | undefined
  readonly #resolveModel: ((id: string) => ResolvedModel | undefined) | undefined
  readonly #permissions: PermissionRuntime | undefined
  readonly #sandbox: SandboxRuntime | undefined
  #escalations = 0
  readonly #guardian: Guardian | undefined
  #guardianRequest: TurnRequest | undefined
  /** Mode to restore when a plan is approved; recorded by enter_plan_mode, "default" otherwise. */
  #modeBeforePlan: PermissionMode = "default"
  /** Session-cumulative usage committed from finished provider requests. */
  readonly #usageTotals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 }
  #hasUnpricedUsage = false
  /** A misconfigured fallback model warns once per session, then stays ignored. */
  #fallbackWarned = false
  #abort: AbortController | undefined
  #turnId: string | undefined
  /** Doom-loop tracking: canonical signature and run length of consecutive identical calls. */
  #doomSignature: string | undefined
  #doomCount = 0
  /**
   * History index where the current (or most recent) turn began. Adjusted when a fallback strips
   * thinking blocks and drops emptied pre-turn messages, so the turn boundary never drifts.
   */
  #turnStartIndex = 0
  /** Messages the most recently finished turn added, as they stand in history at turn end. */
  #lastTurnMessages: ChatMessage[] = []
  readonly #contextOptions: ContextOptions
  readonly #contextTracker = new ContextTracker()
  readonly #outputStore: ToolOutputStore
  #historyRevision = 0
  #compactionFailures = 0

  constructor(options: CodesplashLoopOptions) {
    this.#contextOptions = options.context ?? {}
    this.#outputStore = options.outputStore ?? new ToolOutputStore()
    this.#cwd = options.cwd
    this.#policy = options.policy
    this.#registry = options.registry
    this.#events = options.events
    this.#emit = options.emit
    this.#maxToolRounds = options.maxToolRounds ?? MAX_TOOL_ROUNDS
    this.#collectDiff = options.collectDiff ?? ((cwd, paths) => collectGitDiff(cwd, paths, options.sandbox))
    this.#fallbackModel = options.fallbackModel
    this.#resolveModel = options.resolveModel
    this.#permissions = options.permissions
    this.#sandbox = options.sandbox
    this.#guardian = options.guardian?.enabled ? new Guardian(options.guardian) : undefined
    if (options.initialUsage) {
      this.#usageTotals.inputTokens = options.initialUsage.inputTokens ?? 0
      this.#usageTotals.cachedInputTokens = options.initialUsage.cachedInputTokens ?? 0
      this.#usageTotals.outputTokens = options.initialUsage.outputTokens ?? 0
      this.#usageTotals.costUsd = options.initialUsage.estimatedCostUsd ?? 0
      this.#hasUnpricedUsage = options.initialUsage.hasUnpricedUsage ?? false
    }
  }

  get history(): readonly ChatMessage[] {
    return this.#history
  }

  get isTurnActive(): boolean {
    return this.#abort !== undefined
  }
  get historyRevision(): number {
    return this.#historyRevision
  }

  inspectContext(model: ModelInfo, system: string, reasoningEffort?: ReasoningEffort) {
    return this.#contextTracker.inspect({
      model,
      system,
      reasoningEffort,
      tools: this.#registry.specs(),
      messages: [...this.#history],
    })
  }

  async compact(request: TurnRequest | (() => Promise<TurnRequest>), instructions = ""): Promise<void> {
    if (this.#abort) throw new Error("Wait for the current turn before compacting")
    if (instructions.length > 4000) throw new Error("Compaction instructions must be at most 4000 characters")
    const abort = new AbortController()
    this.#abort = abort
    this.#turnId = crypto.randomUUID()
    this.#event("context/started", {}, { kind: "turn.started", payload: {} })
    try {
      const resolved = typeof request === "function" ? await request() : request
      abort.signal.throwIfAborted()
      if (this.#contextOptions.compactionStrategy === "prune") {
        if (!this.#pruneHistory())
          throw new Error("No older tool output can be pruned; choose the summary strategy or a new session")
      } else await this.#compactHistory(resolved, abort.signal, instructions)
      this.#completeTurn("completed")
    } catch (error) {
      this.#completeTurn(abort.signal.aborted ? "interrupted" : "failed")
      throw error
    } finally {
      this.#abort = undefined
      this.#turnId = undefined
    }
  }
  clearApprovalCache(): void {
    if (this.isTurnActive) throw new Error("Cannot change approvals during a turn")
    this.#sessionApprovals.clear()
  }

  /** Replaces the loop's history (e.g. from a persisted transcript); only legal between turns. */
  seedHistory(messages: ChatMessage[]): void {
    if (this.#abort) throw new Error("Cannot seed history while a turn is active")
    this.#history.length = 0
    this.#history.push(...messages)
  }

  /** The current history in the same array shape sent to providers, thinking blocks included. */
  historySnapshot(): ChatMessage[] {
    return [...this.#history]
  }

  /**
   * The messages the most recently finished turn added, as they stand in history at turn end.
   * Robust against a fallback's thinking-strip dropping emptied pre-turn messages, which would
   * make a length-based slice skip the turn's own messages.
   */
  get lastTurnMessages(): ChatMessage[] {
    return [...this.#lastTurnMessages]
  }

  /**
   * True once any provider request reported usage for a model without pricing: the cumulative
   * estimatedCostUsd is still emitted, but the /usage surface labels it "partial".
   */
  get hasUnpricedUsage(): boolean {
    return this.#hasUnpricedUsage
  }

  /** Runs one full turn; provider and tool failures become events, never rejections. */
  async runTurn(request: TurnRequest): Promise<void> {
    if (this.#abort) throw new Error("A turn is already running")
    const abort = new AbortController()
    this.#abort = abort
    this.#turnId = crypto.randomUUID()
    this.#escalations = 0
    this.#guardianRequest = request
    this.#turnStartIndex = this.#history.length
    this.#lastTurnMessages = []
    const turnMutatedPaths = new Set<string>()
    // Doom-loop tracking is per turn; a fresh turn starts with a clean slate.
    this.#doomSignature = undefined
    this.#doomCount = 0
    // The active model may switch to the configured fallback for the remainder of THIS turn
    // only; the next runTurn receives the session's selected model again and reverts naturally.
    let provider = request.provider
    let model = request.model
    let fallbackUsed = false
    let compactionAttempts = 0
    let overflowRecovered = false

    try {
      this.#event(
        "loop/userMessage",
        {},
        { kind: "user.message", payload: { id: crypto.randomUUID(), text: request.userText } },
        true,
      )
      this.#event("loop/turnStarted", {}, { kind: "turn.started", payload: {} })
      this.#history.push({ role: "user", content: request.userContent })

      let executedRounds = 0
      while (true) {
        abort.signal.throwIfAborted()
        const contextRequest = { ...request, model, provider }
        let context = this.inspectContext(model, request.system, request.reasoningEffort)
        if (context.totalTokens > context.inputBudget) {
          if (this.#contextOptions.autoCompact === false)
            throw new Error(
              "Context exceeds this model's budget. Run /compact or use a larger-context model.",
            )
          this.#pruneHistory()
          context = this.inspectContext(model, request.system, request.reasoningEffort)
          if (context.totalTokens > context.inputBudget) {
            if (
              this.#contextOptions.compactionStrategy === "prune" ||
              compactionAttempts >= 2 ||
              this.#compactionFailures >= 2
            ) {
              throw new Error(
                "Context recovery stopped at its limit. Try /compact with the summary strategy, a larger-context model, or a new session.",
              )
            }
            compactionAttempts++
            await this.#compactHistory(contextRequest, abort.signal)
            context = this.inspectContext(model, request.system, request.reasoningEffort)
            if (context.totalTokens > context.inputBudget)
              throw new Error(
                "The remaining context exceeds the model budget. Shorten the prompt or use a larger-context model.",
              )
          }
        }
        const response = await this.#streamResponse(provider, model, request, abort.signal)
        if (response.kind === "error") {
          if (!response.sawEvent && isContextOverflow(response.error)) {
            if (overflowRecovered || this.#contextOptions.autoCompact === false)
              throw new Error(
                "The provider rejected the context size. Try /compact, a larger-context model, or a new session.",
              )
            overflowRecovered = true
            if (!this.#pruneHistory()) {
              if (
                compactionAttempts >= 2 ||
                this.#compactionFailures >= 2 ||
                this.#contextOptions.compactionStrategy === "prune"
              )
                throw new Error("Context overflow recovery reached its limit")
              compactionAttempts++
              await this.#compactHistory(contextRequest, abort.signal)
            }
            continue
          }
          const fallback = fallbackUsed ? undefined : this.#fallbackTarget(response, model)
          if (fallback) {
            fallbackUsed = true
            this.#event(
              "loop/fallback",
              {},
              {
                kind: "warning",
                payload: { message: `Provider error on ${model.id}; falling back to ${fallback.model.id}` },
              },
            )
            // Thinking signatures are model-bound; the fallback model would reject them.
            this.#stripThinkingFromHistory()
            provider = fallback.provider
            model = fallback.model
            continue
          }
          const message = response.error instanceof Error ? response.error.message : String(response.error)
          this.#event(
            "provider/error",
            {},
            { kind: "error", payload: { message, recoverable: response.error instanceof ProviderHttpError } },
          )
          this.#completeTurn("failed")
          return
        }
        if (response.kind === "aborted") {
          if (response.text !== "") {
            this.#history.push({ role: "assistant", content: [{ type: "text", text: response.text }] })
          }
          this.#completeTurn("interrupted")
          return
        }

        const content: ContentBlock[] = []
        // Thinking blocks stay at the head of the assistant message: Anthropic requires them
        // there, unmodified, when the message carries tool_use under extended thinking.
        content.push(...response.thinking)
        if (response.text !== "") content.push({ type: "text", text: response.text })
        content.push(...response.toolCalls)
        if (content.length > 0) this.#history.push({ role: "assistant", content })

        if (response.stopReason === "max_tokens") {
          this.#settleUnexecutedToolCalls(
            response.toolCalls,
            "Skipped: the response was cut off at the model's output token limit before this tool call could run.",
          )
          this.#event(
            "provider/maxTokens",
            {},
            {
              kind: "warning",
              payload: { message: "The response was cut off at the model's output token limit." },
            },
          )
          this.#completeTurn("completed")
          return
        }
        if (response.stopReason !== "tool_use" || response.toolCalls.length === 0) {
          this.#settleUnexecutedToolCalls(
            response.toolCalls,
            "Skipped: the turn ended before this tool call could run.",
          )
          this.#completeTurn("completed")
          return
        }

        if (executedRounds >= this.#maxToolRounds) {
          this.#history.push({
            role: "user",
            content: response.toolCalls.map(
              (call): ToolResultBlock => ({
                type: "tool_result",
                toolCallId: call.id,
                text: `Skipped: this turn reached the harness limit of ${this.#maxToolRounds} tool rounds.`,
                isError: true,
              }),
            ),
          })
          this.#event(
            "loop/toolRoundLimit",
            {},
            {
              kind: "warning",
              payload: {
                message: `Reached the limit of ${this.#maxToolRounds} tool rounds in one turn; ending the turn.`,
              },
            },
          )
          this.#completeTurn("completed")
          return
        }
        executedRounds += 1

        const modeBefore = this.#permissions?.mode
        const round = await this.#runToolRound(response.toolCalls, abort.signal)
        const resultContent: ContentBlock[] = [...round.results]
        if (this.#permissions && modeBefore !== this.#permissions.mode) {
          resultContent.push({
            type: "text",
            text: reminderText({
              source: "permission-mode",
              text: `The current permission mode is ${this.#permissions.mode}. Follow that mode's restrictions.`,
            }),
          })
        }
        this.#history.push({ role: "user", content: resultContent })
        for (const path of round.mutatedPaths) turnMutatedPaths.add(path)
        if (round.mutatedPaths.length > 0 && !abort.signal.aborted) {
          await this.#emitDiff(turnMutatedPaths)
        }
        if (abort.signal.aborted) {
          this.#completeTurn("interrupted")
          return
        }
        if (round.doomEnded) {
          this.#event("loop/doomLoop", {}, { kind: "warning", payload: { message: DOOM_LOOP_WARNING } })
          this.#completeTurn("completed")
          return
        }
      }
    } catch (error) {
      if (abort.signal.aborted) {
        this.#completeTurn("interrupted")
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      this.#event("loop/error", {}, { kind: "error", payload: { message, recoverable: false } })
      this.#completeTurn("failed")
    } finally {
      this.#sandbox?.endTurn()
      this.#guardian?.endTurn()
      this.#guardianRequest = undefined
      this.#lastTurnMessages = this.#history.slice(this.#turnStartIndex)
      this.#abort = undefined
      this.#turnId = undefined
    }
  }

  /** Settles a pending approval or user-input request with the user's decision. */
  resolveRequest(requestId: string, choice: string): void {
    const pending = this.#pendingRequests.get(requestId)
    if (!pending) throw new Error(`Unknown request ${requestId}`)
    if (!pending.choices.includes(choice) && choice !== "cancel") {
      throw new Error(`Unsupported decision "${choice}" for request ${requestId}`)
    }
    pending.settle(choice)
  }

  /** Aborts the provider stream and running tools; pending requests settle as "cancel". */
  interrupt(): void {
    this.#abort?.abort()
  }

  /**
   * A turn that ends with tool calls in history but no tool round would wedge the session: both
   * providers reject the next request when assistant tool calls lack matching results. Synthetic
   * isError results keep the history well-formed, mirroring the tool-round-cap path.
   */
  #settleUnexecutedToolCalls(calls: ToolCallBlock[], message: string): void {
    if (calls.length === 0) return
    this.#history.push({
      role: "user",
      content: calls.map(
        (call): ToolResultBlock => ({
          type: "tool_result",
          toolCallId: call.id,
          text: message,
          isError: true,
        }),
      ),
    })
  }

  /* --------------------------------- provider stream --------------------------------- */

  #replaceHistory(messages: ChatMessage[]): void {
    this.#history.splice(0, this.#history.length, ...messages)
    this.#historyRevision++
    this.#turnStartIndex = 0
    this.#contextTracker.reset()
  }

  #pruneHistory(): boolean {
    const messages = pruneToolResults(this.#history)
    if (estimateMessages(messages) >= estimateMessages(this.#history)) return false
    this.#replaceHistory(messages)
    this.#event(
      "context/pruned",
      {},
      {
        kind: "warning",
        payload: { message: "Shortened older tool output in model context; visible history is preserved." },
      },
    )
    return true
  }

  async #compactHistory(request: TurnRequest, signal: AbortSignal, instructions?: string): Promise<void> {
    this.#event(
      "context/compacting",
      {},
      { kind: "warning", payload: { message: "Compacting older conversation context…" } },
    )
    const before = estimateMessages(this.#history)
    try {
      const context = this.inspectContext(request.model, request.system, request.reasoningEffort)
      const messages = await compactMessages({
        provider: request.provider,
        model: request.model,
        messages: this.#history,
        keepTokens: Math.max(
          0,
          Math.floor((context.inputBudget - context.systemTokens - context.toolTokens) / 4),
        ),
        instructions,
        signal,
        sanitize: (text) => this.#sandbox?.sanitize?.(text) ?? text,
        onUsage: (usage) => {
          this.#emitUsage(usage, request.model)
          this.#commitRequestUsage(usage, request.model)
        },
      })
      signal.throwIfAborted()
      this.#replaceHistory(messages)
      this.#compactionFailures = 0
      this.#event(
        "context/compacted",
        {},
        {
          kind: "warning",
          payload: {
            message: `Compacted estimated message tokens ${before} → ${estimateMessages(messages)}. Visible conversation history is preserved.`,
          },
        },
      )
    } catch (error) {
      if (!signal.aborted) this.#compactionFailures++
      throw error
    }
  }

  async #streamResponse(
    provider: ProviderClient,
    model: ModelInfo,
    request: TurnRequest,
    signal: AbortSignal,
  ): Promise<StreamResult> {
    const messageId = crypto.randomUUID()
    const reasoningId = crypto.randomUUID()
    let text = ""
    let reasoning = ""
    const thinking: Array<ThinkingBlock | RedactedThinkingBlock> = []
    const toolCalls: ToolCallBlock[] = []
    let stopReason: StopReason | undefined
    let sawEvent = false
    /** Latest usage snapshot for THIS request; committed into the session totals on exit. */
    let requestUsage: ProviderUsage = {}

    const providerRequest: ProviderRequest = {
      model,
      system: request.system,
      messages: [...this.#history],
      tools: this.#registry.specs(),
      reasoningEffort: request.reasoningEffort,
    }
    const estimatedInput = inspectContext(
      model,
      request.system,
      providerRequest.tools,
      providerRequest.messages,
    ).totalTokens

    try {
      for await (const event of provider.stream(providerRequest, signal)) {
        sawEvent = true
        if (event.type === "text_delta") {
          text += event.text
          this.#event(
            "provider/textDelta",
            { itemId: messageId },
            { kind: "message.delta", payload: { id: messageId, text: event.text } },
            true,
          )
        } else if (event.type === "reasoning_delta") {
          reasoning += event.text
          this.#event(
            "provider/reasoningDelta",
            { itemId: reasoningId },
            { kind: "reasoning.delta", payload: { id: reasoningId, text: event.text } },
            true,
          )
        } else if (event.type === "thinking") {
          const block: ThinkingBlock = { type: "thinking", text: event.text }
          if (event.signature !== undefined) block.signature = event.signature
          thinking.push(block)
        } else if (event.type === "redacted_thinking") {
          thinking.push({ type: "redacted_thinking", data: event.data })
        } else if (event.type === "tool_call") {
          toolCalls.push({ type: "tool_call", id: event.id, name: event.name, input: event.input })
        } else if (event.type === "usage") {
          requestUsage = event.usage
          this.#emitUsage(event.usage, model)
        } else {
          stopReason = event.stopReason
          break
        }
      }
    } catch (error) {
      this.#finishStreamItems(reasoningId, reasoning, messageId, text)
      return { kind: "error", error, sawEvent }
    } finally {
      // Adapters emit request-scoped snapshots; the last one folds into the session totals.
      this.#commitRequestUsage(requestUsage, model)
      if (requestUsage.inputTokens !== undefined || requestUsage.cachedInputTokens !== undefined) {
        this.#contextTracker.observe(
          (requestUsage.inputTokens ?? 0) + (requestUsage.cachedInputTokens ?? 0),
          estimatedInput,
        )
      }
    }

    this.#finishStreamItems(reasoningId, reasoning, messageId, text)
    if (stopReason === undefined) stopReason = signal.aborted ? "aborted" : "end_turn"
    if (stopReason === "aborted") return { kind: "aborted", text }
    return { kind: "done", stopReason, text, thinking, toolCalls }
  }

  #finishStreamItems(reasoningId: string, reasoning: string, messageId: string, text: string): void {
    if (reasoning !== "") {
      this.#event(
        "provider/reasoningCompleted",
        { itemId: reasoningId },
        { kind: "reasoning.completed", payload: { id: reasoningId, text: reasoning } },
        true,
      )
    }
    if (text !== "") {
      this.#event(
        "provider/messageCompleted",
        { itemId: messageId },
        { kind: "message.completed", payload: { id: messageId, text } },
        true,
      )
    }
  }

  /**
   * Emits session-cumulative token counts and estimated cost (committed totals plus the current
   * request's snapshot). contextTokens keeps its per-request semantics: the context size of THIS
   * request, not a session sum.
   */
  #emitUsage(usage: ProviderUsage, model: ModelInfo): void {
    const counted = [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens].filter(
      (value): value is number => typeof value === "number",
    )
    // Computed before the payload literal: pricing this request may flip #hasUnpricedUsage.
    const estimatedCostUsd = this.#usageTotals.costUsd + this.#requestCostUsd(usage, model)
    this.#event(
      "provider/usage",
      {},
      {
        kind: "usage.updated",
        payload: {
          inputTokens: this.#usageTotals.inputTokens + (usage.inputTokens ?? 0),
          cachedInputTokens: this.#usageTotals.cachedInputTokens + (usage.cachedInputTokens ?? 0),
          outputTokens: this.#usageTotals.outputTokens + (usage.outputTokens ?? 0),
          contextTokens: counted.length > 0 ? counted.reduce((total, value) => total + value, 0) : undefined,
          modelContextWindow: model.contextWindow,
          estimatedCostUsd,
          // Always emitted, false included: a genuinely zero-cost priced session (e.g. a local
          // model priced at 0.0) must be distinguishable from one with unpriced usage.
          hasUnpricedUsage: this.#hasUnpricedUsage,
        },
      },
    )
  }

  /** Folds a finished request's usage snapshot into the session-cumulative totals. */
  #commitRequestUsage(usage: ProviderUsage, model: ModelInfo): void {
    this.#usageTotals.inputTokens += usage.inputTokens ?? 0
    this.#usageTotals.cachedInputTokens += usage.cachedInputTokens ?? 0
    this.#usageTotals.outputTokens += usage.outputTokens ?? 0
    this.#usageTotals.costUsd += this.#requestCostUsd(usage, model)
  }

  /**
   * Catalog-estimate cost of one request's usage in USD. Both adapters report NON-cached input
   * in inputTokens (Anthropic's input_tokens excludes cache reads; the openai adapter subtracts
   * prompt_tokens_details.cached_tokens), so cached tokens are priced additively at the cached
   * rate rather than re-subtracted from input. Models without pricing contribute 0 and flag the
   * session's cost as partial.
   */
  #requestCostUsd(usage: ProviderUsage, model: ModelInfo): number {
    const input = usage.inputTokens ?? 0
    const cached = usage.cachedInputTokens ?? 0
    const output = usage.outputTokens ?? 0
    const pricing = model.pricing
    if (!pricing) {
      if (input + cached + output > 0) this.#hasUnpricedUsage = true
      return 0
    }
    const cachedRate = pricing.cachedInputPerMTok ?? pricing.inputPerMTok / 10
    return (input * pricing.inputPerMTok + cached * cachedRate + output * pricing.outputPerMTok) / 1_000_000
  }

  /**
   * Fallback target for a failed stream attempt, or undefined to surface the error unchanged.
   * Applies only to a request that failed with zero events (ProviderHttpError after retry
   * exhaustion or a network TypeError); an unknown or unavailable fallback model warns once per
   * session and is ignored from then on.
   */
  #fallbackTarget(
    response: { error: unknown; sawEvent: boolean },
    currentModel: ModelInfo,
  ): ResolvedModel | undefined {
    if (response.sawEvent) return undefined
    if (!(response.error instanceof ProviderHttpError) && !(response.error instanceof TypeError)) {
      return undefined
    }
    const fallbackId = this.#fallbackModel
    if (fallbackId === undefined || fallbackId === "") return undefined
    const resolved = this.#resolveModel?.(fallbackId)
    if (!resolved) {
      if (!this.#fallbackWarned) {
        this.#fallbackWarned = true
        this.#event(
          "loop/fallbackConfig",
          {},
          {
            kind: "warning",
            payload: {
              message: `The configured fallback model "${fallbackId}" is unknown or unavailable; ignoring it.`,
            },
          },
        )
      }
      return undefined
    }
    if (resolved.model.id === currentModel.id) return undefined
    return resolved
  }

  /**
   * Removes every thinking/redacted_thinking block from history before a fallback request:
   * thinking signatures are bound to the model that produced them. An assistant message left
   * empty by the strip is dropped entirely (providers reject empty content); dropping a message
   * before the turn boundary shifts #turnStartIndex down so the boundary stays on the turn's
   * first message.
   */
  #stripThinkingFromHistory(): void {
    const stripped: ChatMessage[] = []
    let droppedBeforeTurn = 0
    for (const [index, message] of this.#history.entries()) {
      const content = message.content.filter(
        (block) => block.type !== "thinking" && block.type !== "redacted_thinking",
      )
      if (content.length === 0) {
        if (index < this.#turnStartIndex) droppedBeforeTurn += 1
        continue
      }
      stripped.push({ role: message.role, content })
    }
    this.#history.length = 0
    this.#history.push(...stripped)
    this.#turnStartIndex -= droppedBeforeTurn
    this.#historyRevision++
    this.#contextTracker.reset()
  }

  /* ----------------------------------- tool rounds ----------------------------------- */

  /**
   * Runs the round in the model's call order: contiguous runs of approval-free read-only calls
   * overlap (cap 4), while every other call — mutating, approval-gated, ask_user — is a barrier
   * awaited in position so a read never observes pre-mutation state the model believes is fresh.
   */
  async #runToolRound(
    calls: ToolCallBlock[],
    signal: AbortSignal,
  ): Promise<{ results: ToolResultBlock[]; mutatedPaths: string[]; doomEnded: boolean }> {
    const results: Array<ToolResultBlock | undefined> = new Array(calls.length)
    const mutated = new Set<string>()
    const decisions = this.#doomLoopDecisions(calls)
    let doomEnded = false

    const run = async (index: number): Promise<void> => {
      const call = calls[index]
      if (!call) return
      const tool = this.#registry.get(call.name)
      if (!tool) return
      results[index] = await this.#runToolCall(tool, call, signal, mutated)
    }

    let readOnlyBatch: number[] = []
    const flushReadOnlyBatch = async (): Promise<void> => {
      if (readOnlyBatch.length === 0) return
      const batch = readOnlyBatch
      readOnlyBatch = []
      await runWithConcurrency(batch, READ_ONLY_CONCURRENCY, run)
    }

    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index]
      if (!call) continue
      const decision = decisions[index] ?? "run"
      if (decision === "end") {
        // Calls the model ordered before the loop trigger still run; the trigger call and
        // everything after it get skip results so history stays well-formed, then the turn ends.
        await flushReadOnlyBatch()
        for (let rest = index; rest < calls.length; rest += 1) {
          const restCall = calls[rest]
          if (!restCall) continue
          results[rest] = {
            type: "tool_result",
            toolCallId: restCall.id,
            text: DOOM_LOOP_SKIPPED_TEXT,
            isError: true,
          }
        }
        doomEnded = true
        break
      }
      if (decision === "synthetic") {
        results[index] = this.#failCall(
          call.id,
          call,
          callLabel(call.name, call.input),
          DOOM_LOOP_SYNTHETIC_TEXT,
        )
        continue
      }
      const tool = this.#registry.get(call.name)
      if (!tool) {
        const message = `Unknown tool: ${call.name}`
        this.#emitToolItem(call.id, call.name, message, "failed")
        results[index] = { type: "tool_result", toolCallId: call.id, text: message, isError: true }
        continue
      }
      if (this.#canRunConcurrently(tool, call, signal)) {
        readOnlyBatch.push(index)
        continue
      }
      await flushReadOnlyBatch()
      await run(index)
    }
    await flushReadOnlyBatch()

    const finalResults = calls.map(
      (call, index): ToolResultBlock =>
        results[index] ?? {
          type: "tool_result",
          toolCallId: call.id,
          text: "The harness produced no result for this call.",
          isError: true,
        },
    )
    return { results: finalResults, mutatedPaths: [...mutated], doomEnded }
  }

  /**
   * Doom-loop bookkeeping in the model's call order, carried across rounds within a turn.
   * Identical means same tool name plus canonical (sorted-key) JSON of the input; declined and
   * failed calls count toward the run, since loops usually manifest as repeated failures. The
   * 3rd consecutive identical call is answered synthetically instead of executed, and the 5th
   * force-ends the turn; any different call resets the counter.
   */
  #doomLoopDecisions(calls: ToolCallBlock[]): Array<"run" | "synthetic" | "end"> {
    const decisions: Array<"run" | "synthetic" | "end"> = []
    let ended = false
    for (const call of calls) {
      if (ended) {
        decisions.push("end")
        continue
      }
      const signature = `${call.name}\u0000${canonicalJson(call.input)}`
      if (signature === this.#doomSignature) {
        this.#doomCount += 1
      } else {
        this.#doomSignature = signature
        this.#doomCount = 1
      }
      if (this.#doomCount >= DOOM_LOOP_FORCED_END_AT) {
        decisions.push("end")
        ended = true
      } else if (this.#doomCount >= DOOM_LOOP_SYNTHETIC_AT) {
        decisions.push("synthetic")
      } else {
        decisions.push("run")
      }
    }
    return decisions
  }

  /**
   * Only read-only calls that need no approval may overlap; everything else runs in order.
   * Approval-free means a permission decision of "allow", or "default" with the tool's own
   * permission() reporting "none" (as before permissions existed). "deny"/"ask" stay barriers so
   * their results and requests land in the model's call order.
   */
  #canRunConcurrently(tool: HarnessTool, call: ToolCallBlock, signal: AbortSignal): boolean {
    if (
      tool.name === ASK_USER_TOOL_NAME ||
      tool.name === ENTER_PLAN_MODE_TOOL_NAME ||
      tool.name === EXIT_PLAN_MODE_TOOL_NAME
    ) {
      return false
    }
    try {
      if (!tool.isReadOnly(call.input)) return false
      const decision = this.#permissionDecision(tool, call, signal).decision
      if (decision.kind === "allow") return true
      if (decision.kind !== "default") return false
      return tool.permission(call.input, this.#toolContext(signal)).kind === "none"
    } catch {
      return false
    }
  }

  /**
   * Permission-engine verdict for one call, plus the extracted targets for rule derivation. A
   * permissionTargets throw (malformed input) forces the default path so run()/parse surfaces
   * the input error exactly as it did before the permission engine existed.
   */
  #permissionDecision(
    tool: HarnessTool,
    call: ToolCallBlock,
    signal: AbortSignal,
  ): { decision: PermissionDecision; targets: PermissionTargets | undefined } {
    const permissions = this.#permissions
    if (permissions === undefined) return { decision: { kind: "default" }, targets: undefined }
    let targets: PermissionTargets | undefined
    if (tool.permissionTargets !== undefined) {
      try {
        targets = tool.permissionTargets(call.input, this.#toolContext(signal))
      } catch (error) {
        // Only a malformed input falls through to the default flow (run()/parse then surfaces
        // the same ToolInputError). Anything else rethrows so an unexpected bug fails the call
        // closed instead of silently skipping the deny rules and floors.
        if (!(error instanceof ToolInputError)) throw error
        return { decision: { kind: "default" }, targets: undefined }
      }
    }
    return { decision: permissions.decide(tool.name, targets, tool.isReadOnly(call.input)), targets }
  }

  async #runToolCall(
    tool: HarnessTool,
    call: ToolCallBlock,
    signal: AbortSignal,
    mutated: Set<string>,
  ): Promise<ToolResultBlock> {
    const itemId = call.id
    const provisionalLabel = callLabel(tool.name, call.input)
    this.#emitToolItem(itemId, provisionalLabel, undefined, "running")
    if (signal.aborted) {
      return this.#failCall(itemId, call, provisionalLabel, "Interrupted by the user before this tool ran.")
    }

    try {
      if (tool.name === REQUEST_PERMISSIONS_TOOL_NAME) {
        if (!this.#sandbox || !this.#permissions)
          return this.#failCall(
            itemId,
            call,
            provisionalLabel,
            "Scoped permissions are unavailable in this session",
          )
        if (++this.#escalations > 3)
          return this.#failCall(
            itemId,
            call,
            provisionalLabel,
            "Permission request limit reached for this turn; change your approach",
          )
        const requested = parsePermissionRequest(call.input)
        const grant = this.#sandbox.validateGrant(requested, this.#permissions.mode)
        const name =
          grant.resource === "network" ? "web_fetch" : grant.resource === "write" ? "write_file" : "read_file"
        const targets =
          grant.resource === "network" ? { urlHost: grant.target.split(":")[0] } : { paths: [grant.target] }
        if (
          this.#permissions.decide(tool.name, undefined, false).kind === "deny" ||
          this.#permissions.decide(name, targets, grant.resource !== "write").kind === "deny"
        )
          return this.#failCall(itemId, call, provisionalLabel, "Explicit permission rules deny this request")
        const choice = await this.#awaitDecision(
          "approval",
          "Grant sandbox access?",
          `${grant.resource}: ${grant.target}\nScope: ${grant.scope}\n${requested.reason}\nA failed command is not retried automatically.`,
          ["accept", "decline", "cancel"],
          itemId,
          signal,
          true,
          "sandbox escalation requires explicit approval",
        )
        if (choice !== "accept" || signal.aborted)
          return this.#failCall(itemId, call, provisionalLabel, "Sandbox access was not granted")
        this.#sandbox.grant(this.#sandbox.validateGrant(grant, this.#permissions.mode))
        const text = `Granted ${grant.resource} access to ${grant.target} for this ${grant.scope}. Retry only after considering any prior side effects.`
        this.#emitToolItem(itemId, provisionalLabel, text, "completed")
        return { type: "tool_result", toolCallId: call.id, text }
      }
      if (
        tool.name === ASK_USER_TOOL_NAME ||
        tool.name === ENTER_PLAN_MODE_TOOL_NAME ||
        tool.name === EXIT_PLAN_MODE_TOOL_NAME
      ) {
        // Intrinsic tools honor explicit deny rules (a configured deny must not be silently
        // inert); every other decision kind proceeds with their loop-executed behavior.
        const { decision } = this.#permissionDecision(tool, call, signal)
        if (decision.kind === "deny") {
          return this.#failCall(
            itemId,
            call,
            provisionalLabel,
            `Denied by permission rule: ${decision.reason}`,
          )
        }
        if (tool.name === ASK_USER_TOOL_NAME) return await this.#runAskUser(call, itemId, signal)
        if (tool.name === ENTER_PLAN_MODE_TOOL_NAME) return this.#runEnterPlanMode(call, itemId)
        return await this.#runExitPlanMode(call, itemId, signal)
      }

      // The permission engine is consulted first: deny short-circuits with no request, allow
      // skips approval entirely, ask opens a rule-driven approval, and default falls through to
      // the tool's own permission() flow exactly as before.
      const { decision, targets } = this.#permissionDecision(tool, call, signal)
      if (decision.kind === "deny") {
        return this.#failCall(itemId, call, provisionalLabel, `Denied by permission rule: ${decision.reason}`)
      }
      let guardianAllowed = false
      // Explicit ask rules and deterministic floors are human decisions. Guardian may
      // reduce only the tool's default prompts, never a policy-authored ask.
      if (
        this.#guardian &&
        this.#guardianRequest &&
        decision.kind === "default" &&
        tool.permission(call.input, this.#toolContext(signal)).kind === "approval"
      ) {
        const request = this.#guardianRequest
        const selected = this.#guardian.config.model
          ? this.#resolveModel?.(this.#guardian.config.model)
          : { provider: request.provider, model: request.model }
        const text = JSON.stringify({
          userRequest: request.userText,
          tool: tool.name,
          input: call.input,
          policy: this.#policy,
          profileHash: this.#sandbox?.profile.hash,
        })
        const verdict = selected
          ? await this.#guardian.review(
              selected.provider,
              selected.model,
              this.#sandbox?.sanitize?.(text) ?? text,
              signal,
            )
          : { action: "review", reason: "Guardian model unavailable", usage: {} }
        if (selected) {
          this.#emitUsage(verdict.usage, selected.model)
          this.#commitRequestUsage(verdict.usage, selected.model)
        }
        if (signal.aborted)
          return this.#failCall(itemId, call, provisionalLabel, "Interrupted during guardian review")
        if (verdict.action === "deny")
          return this.#failCall(
            itemId,
            call,
            provisionalLabel,
            `Guardian denied this action: ${verdict.reason}`,
          )
        guardianAllowed = verdict.action === "allow"
        if (!guardianAllowed) {
          const choice = await this.#awaitDecision(
            "approval",
            "Guardian requires human review",
            verdict.reason,
            ["accept", "decline", "cancel"],
            itemId,
            signal,
            true,
            "guardian review requires explicit approval",
          )
          if (choice !== "accept" || signal.aborted)
            return this.#failCall(itemId, call, provisionalLabel, `Action not approved: ${verdict.reason}`)
          guardianAllowed = true
        }
      }
      if (!guardianAllowed && decision.kind === "ask") {
        const refusal = await this.#askApproval(
          tool,
          call,
          itemId,
          provisionalLabel,
          decision,
          targets,
          signal,
        )
        if (refusal !== undefined) return refusal
      } else if (!guardianAllowed && decision.kind === "default") {
        const refusal = await this.#defaultApproval(tool, call, itemId, provisionalLabel, targets, signal)
        if (refusal !== undefined) return refusal
      }

      if (
        tool.name === "bash" &&
        call.input &&
        typeof call.input === "object" &&
        "secrets" in call.input &&
        Array.isArray(call.input.secrets) &&
        call.input.secrets.length
      ) {
        const detail = `Secrets: ${call.input.secrets.join(", ")}\nCommand: ${targets?.command ?? provisionalLabel}\nBinding applies only to this execution.`
        const choice = await this.#awaitDecision(
          "approval",
          "Use named secrets for this command?",
          detail,
          ["accept", "decline", "cancel"],
          itemId,
          signal,
          true,
          "named secrets require explicit per-command approval",
        )
        if (choice !== "accept" || signal.aborted)
          return this.#failCall(itemId, call, provisionalLabel, "Named-secret use was not approved")
        if (!this.#sandbox)
          return this.#failCall(
            itemId,
            call,
            provisionalLabel,
            "Named secrets require the native sandbox runtime",
          )
      }
      const outcome =
        call.name === READ_TOOL_OUTPUT
          ? { text: await this.#outputStore.read(call.input), label: "Retained tool output" }
          : this.#sandbox
            ? await this.#sandbox.runTool(tool, call.input, this.#toolContext(signal))
            : await tool.run(call.input, this.#toolContext(signal))
      if (this.#sandbox?.sanitize) {
        outcome.text = this.#sandbox.sanitize(outcome.text)
        outcome.label = this.#sandbox.sanitize(outcome.label)
        for (const step of outcome.planSteps ?? []) step.text = this.#sandbox.sanitize(step.text)
      }
      if (outcome.planSteps) {
        this.#event("tool/plan", { itemId }, { kind: "plan.updated", payload: { steps: outcome.planSteps } })
      }
      for (const path of outcome.mutatedPaths ?? []) mutated.add(path)
      this.#emitToolItem(itemId, outcome.label, outcome.text, outcome.isError ? "failed" : "completed")
      const result: ToolResultBlock = {
        type: "tool_result",
        toolCallId: call.id,
        text: await this.#outputStore.retain(outcome.text),
      }
      if (outcome.isError) result.isError = true
      return result
    } catch (error) {
      if (error instanceof ToolInputError)
        return this.#failCall(itemId, call, provisionalLabel, error.message)
      if (signal.aborted) return this.#failCall(itemId, call, provisionalLabel, "Interrupted by the user.")
      const message = error instanceof Error ? error.message : String(error)
      return this.#failCall(itemId, call, provisionalLabel, `${tool.name} failed: ${message}`)
    }
  }

  /** ask_user is intrinsic: a "user-input" request whose decision becomes the tool result. */
  async #runAskUser(call: ToolCallBlock, itemId: string, signal: AbortSignal): Promise<ToolResultBlock> {
    const { question, options } = parseAskUserInput(call.input)
    const choice = await this.#awaitDecision("user-input", question, "", options, itemId, signal)
    if (choice === "cancel") {
      return this.#failCall(itemId, call, question, "The user dismissed the question without answering.")
    }
    this.#emitToolItem(itemId, question, choice, "completed")
    return { type: "tool_result", toolCallId: call.id, text: `The user chose: ${choice}` }
  }

  /* --------------------------------- permission flows --------------------------------- */

  /**
   * Rule-driven "ask" approval. Title/detail reuse the tool's own permission() when it reports
   * an approval; otherwise a generic prompt with the provisional label. acceptAlways is offered
   * only for persistable, non-dangerous asks; dangerous-floor asks (alwaysAsk) tag the request
   * so auto-answering consumers decline them. Session approvals deliberately do NOT apply here:
   * an explicit or dangerous ask must reach the user even after acceptForSession.
   * Returns the refusal result, or undefined when the call may run.
   */
  async #askApproval(
    tool: HarnessTool,
    call: ToolCallBlock,
    itemId: string,
    provisionalLabel: string,
    decision: Extract<PermissionDecision, { kind: "ask" }>,
    targets: PermissionTargets | undefined,
    signal: AbortSignal,
  ): Promise<ToolResultBlock | undefined> {
    let title = `Run ${tool.name}?`
    // The full command, never the 80-char-clipped label: a destructive tail past the clip must
    // not be approved sight-unseen.
    let detail = targets?.command ?? provisionalLabel
    try {
      const permission = tool.permission(call.input, this.#toolContext(signal))
      if (permission.kind === "approval") {
        title = permission.title
        detail = permission.detail
      }
    } catch {
      // Keep the generic title/detail; run() surfaces any input error after approval.
    }
    // Surface WHY the engine asked (dangerous command class, ask rule, plan mode) in the prompt.
    if (decision.reason !== undefined) {
      detail = detail === "" ? decision.reason : `${detail}\n\n${decision.reason}`
    }
    const persistableRule = decision.alwaysAsk === true ? undefined : decision.persistableRule
    const choices =
      persistableRule === undefined
        ? ["accept", "decline", "cancel"]
        : ["accept", "acceptAlways", "decline", "cancel"]
    const choice = await this.#awaitDecision(
      "approval",
      title,
      detail,
      choices,
      itemId,
      signal,
      decision.alwaysAsk,
      decision.reason,
    )
    if (choice === "acceptAlways" && persistableRule !== undefined) {
      await this.#persistGrant(persistableRule)
    }
    if (choice === "decline" || choice === "cancel") {
      return this.#failCall(itemId, call, provisionalLabel, this.#refusalMessage(tool.name, choice))
    }
    return undefined
  }

  /**
   * The pre-permissions approval flow, byte-for-byte, with one addition: when a permission
   * runtime is present and a persistable rule can be derived for the call, acceptAlways joins
   * the choices (grouped with the other accept variants) and persists the rule before running.
   * Returns the refusal result, or undefined when the call may run.
   */
  async #defaultApproval(
    tool: HarnessTool,
    call: ToolCallBlock,
    itemId: string,
    provisionalLabel: string,
    targets: PermissionTargets | undefined,
    signal: AbortSignal,
  ): Promise<ToolResultBlock | undefined> {
    const permission = tool.permission(call.input, this.#toolContext(signal))
    if (permission.kind !== "approval") return undefined
    const preApproved =
      permission.sessionKey !== undefined && this.#sessionApprovals.has(permission.sessionKey)
    if (preApproved) return undefined
    const persistableRule = this.#derivePersistableRule(tool.name, targets)
    const choices = [...APPROVAL_CHOICES] as string[]
    if (persistableRule !== undefined) choices.splice(2, 0, "acceptAlways")
    const choice = await this.#awaitDecision(
      "approval",
      permission.title,
      permission.detail,
      choices,
      itemId,
      signal,
    )
    if (choice === "acceptForSession" && permission.sessionKey !== undefined) {
      this.#sessionApprovals.add(permission.sessionKey)
    }
    if (choice === "acceptAlways" && persistableRule !== undefined) {
      await this.#persistGrant(persistableRule)
    }
    if (choice === "decline" || choice === "cancel") {
      return this.#failCall(itemId, call, provisionalLabel, this.#refusalMessage(tool.name, choice))
    }
    return undefined
  }

  /**
   * Rule the default-path acceptAlways would persist. A runtime that derives its own rules
   * (the concrete permission engine, which returns undefined without a grants path so
   * "always allow" is never offered when it cannot be persisted) is preferred; runtimes
   * without the helper fall back to the loop's standalone derivation.
   */
  #derivePersistableRule(toolName: string, targets: PermissionTargets | undefined): string | undefined {
    const runtime = this.#permissions
    if (runtime === undefined) return undefined
    const viaRuntime = (
      runtime as {
        derivePersistableRule?: (tool: string, targets: PermissionTargets | undefined) => string | undefined
      }
    ).derivePersistableRule
    if (typeof viaRuntime === "function") return viaRuntime.call(runtime, toolName, targets)
    return derivePersistableRule(toolName, targets, this.#cwd)
  }

  #refusalMessage(toolName: string, choice: "decline" | "cancel"): string {
    return choice === "decline"
      ? `The user declined the request to run ${toolName}.`
      : `The user cancelled the request to run ${toolName}.`
  }

  /** Persists an acceptAlways grant; a store failure warns but never blocks the approved run. */
  async #persistGrant(rule: string): Promise<void> {
    try {
      await this.#permissions?.persistGrant(rule)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#event(
        "loop/persistGrant",
        {},
        { kind: "warning", payload: { message: `Could not persist the permission rule: ${message}` } },
      )
    }
  }

  /* ----------------------------------- plan mode ----------------------------------- */

  /**
   * enter_plan_mode is intrinsic: flips the permission runtime into plan mode with no approval,
   * remembering the current mode so an approved exit_plan_mode can restore it.
   */
  #runEnterPlanMode(call: ToolCallBlock, itemId: string): ToolResultBlock {
    const label = ENTER_PLAN_MODE_TOOL_NAME
    const permissions = this.#permissions
    if (permissions === undefined) {
      return this.#failCall(itemId, call, label, PLAN_MODE_UNAVAILABLE_TEXT)
    }
    if (permissions.mode === "plan") {
      return this.#failCall(itemId, call, label, "Already in plan mode.")
    }
    this.#modeBeforePlan = permissions.mode
    permissions.setMode("plan")
    this.#emitToolItem(itemId, label, ENTER_PLAN_MODE_RESULT_TEXT, "completed")
    return { type: "tool_result", toolCallId: call.id, text: ENTER_PLAN_MODE_RESULT_TEXT }
  }

  /**
   * exit_plan_mode is intrinsic: opens a plan-approval request whose detail is the plan text
   * (from the input, falling back to .codesplash/plan.md). Approval restores the pre-plan mode;
   * keepPlanning/cancel leave plan mode on with a non-error result.
   */
  async #runExitPlanMode(call: ToolCallBlock, itemId: string, signal: AbortSignal): Promise<ToolResultBlock> {
    const label = EXIT_PLAN_MODE_TOOL_NAME
    const permissions = this.#permissions
    if (permissions === undefined) {
      return this.#failCall(itemId, call, label, PLAN_MODE_UNAVAILABLE_TEXT)
    }
    if (permissions.mode !== "plan") {
      return this.#failCall(itemId, call, label, "Not in plan mode; call enter_plan_mode first.")
    }
    const plan = planTextFromInput(call.input) ?? (await this.#readPlanFile())
    if (plan === undefined) {
      return this.#failCall(
        itemId,
        call,
        label,
        "No plan to review: pass `plan` or write the plan to .codesplash/plan.md first.",
      )
    }
    const choice = await this.#awaitDecision(
      "approval",
      "Approve this plan?",
      capPlanDetail(plan),
      [...PLAN_APPROVAL_CHOICES],
      itemId,
      signal,
    )
    if (choice === "approve") {
      permissions.setMode(this.#modeBeforePlan)
      this.#emitToolItem(itemId, label, PLAN_APPROVED_RESULT_TEXT, "completed")
      return { type: "tool_result", toolCallId: call.id, text: PLAN_APPROVED_RESULT_TEXT }
    }
    this.#emitToolItem(itemId, label, KEEP_PLANNING_RESULT_TEXT, "completed")
    return { type: "tool_result", toolCallId: call.id, text: KEEP_PLANNING_RESULT_TEXT }
  }

  /** Contents of <cwd>/.codesplash/plan.md; undefined when missing, unreadable, or blank. */
  async #readPlanFile(): Promise<string | undefined> {
    try {
      const text = await readFile(join(this.#cwd, PLAN_FILE_RELATIVE_PATH), { encoding: "utf8" })
      return text.trim() === "" ? undefined : text
    } catch {
      return undefined
    }
  }

  /* ------------------------------------ requests ------------------------------------ */

  #awaitDecision(
    requestKind: "approval" | "user-input",
    title: string,
    detail: string,
    choices: string[],
    itemId: string,
    signal: AbortSignal,
    alwaysAsk?: boolean,
    reason?: string,
  ): Promise<string> {
    const requestId = crypto.randomUUID()
    this.#event(
      "request/opened",
      { itemId, requestId },
      {
        kind: "request.opened",
        payload: {
          id: requestId,
          requestKind,
          title,
          detail,
          choices,
          // Tagged only when true: dangerous-floor approvals that auto-answering consumers
          // (the headless runner) must decline even under --auto. The reason names the command
          // class so a headless decline note can say what was refused.
          ...(alwaysAsk === true ? { alwaysAsk: true } : {}),
          ...(reason !== undefined ? { reason } : {}),
        },
      },
      true,
    )
    return new Promise<string>((resolve) => {
      const settle = (choice: string): void => {
        if (!this.#pendingRequests.delete(requestId)) return
        signal.removeEventListener("abort", onAbort)
        this.#event(
          "request/resolved",
          { itemId, requestId },
          { kind: "request.resolved", payload: { id: requestId, decision: choice } },
        )
        resolve(choice)
      }
      const onAbort = (): void => settle("cancel")
      this.#pendingRequests.set(requestId, { choices, settle })
      if (signal.aborted) {
        settle("cancel")
        return
      }
      signal.addEventListener("abort", onAbort, { once: true })
    })
  }

  /* ------------------------------------- helpers ------------------------------------- */

  async #emitDiff(paths: Set<string>): Promise<void> {
    const list = [...paths].sort()
    let unified = ""
    try {
      unified = await this.#collectDiff(this.#cwd, list)
    } catch {
      return
    }
    if (unified.trim() === "") return
    this.#event(
      "loop/diff",
      {},
      {
        kind: "diff.updated",
        payload: { id: `diff-${this.#turnId}`, path: list.length === 1 ? list[0] : undefined, unified },
      },
      true,
    )
  }

  #completeTurn(status: "completed" | "interrupted" | "failed"): void {
    this.#event("loop/turnCompleted", {}, { kind: "turn.completed", payload: { status } })
  }

  #emitToolItem(itemId: string, label: string, output: string | undefined, status: ItemStatus): void {
    this.#event(
      "tool/item",
      { itemId },
      { kind: "item.updated", payload: { id: itemId, label, output, status } },
      true,
    )
  }

  #failCall(itemId: string, call: ToolCallBlock, label: string, message: string): ToolResultBlock {
    label = this.#sandbox?.sanitize?.(label) ?? label
    message = this.#sandbox?.sanitize?.(message) ?? message
    this.#emitToolItem(itemId, label, message, "failed")
    return { type: "tool_result", toolCallId: call.id, text: message, isError: true }
  }

  #toolContext(signal: AbortSignal): ToolContext {
    return { cwd: this.#cwd, policy: this.#policy, signal, permissions: this.#permissions }
  }

  #event(providerEvent: string, native: NativeEventIds, input: AgentEventInput, sensitive = false): void {
    this.#emit(this.#events.event(providerEvent, { turnId: this.#turnId, ...native }, input, sensitive))
  }
}

/* ------------------------------------ module helpers ------------------------------------ */

async function runWithConcurrency(
  indexes: number[],
  limit: number,
  run: (index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, indexes.length) }, async () => {
    while (cursor < indexes.length) {
      const index = indexes[cursor]
      cursor += 1
      if (index !== undefined) await run(index)
    }
  })
  await Promise.all(workers)
}

function parseAskUserInput(input: unknown): { question: string; options: string[] } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolInputError("ask_user input must be an object with `question` and `options`.")
  }
  const { question, options } = input as Record<string, unknown>
  if (typeof question !== "string" || question.trim() === "") {
    throw new ToolInputError("ask_user requires a non-empty `question` string.")
  }
  if (!Array.isArray(options) || options.length < 2 || options.length > 6) {
    throw new ToolInputError("ask_user requires between 2 and 6 `options`.")
  }
  const labels = options.map((option) => {
    if (typeof option !== "string" || option.trim() === "") {
      throw new ToolInputError("Every ask_user option must be a non-empty string.")
    }
    return option
  })
  return { question, options: labels }
}

/** The exit_plan_mode `plan` input when present and non-blank; a non-string plan is an input error. */
function planTextFromInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  const { plan } = input as Record<string, unknown>
  if (plan === undefined) return undefined
  if (typeof plan !== "string") {
    throw new ToolInputError("exit_plan_mode `plan` must be a string when provided.")
  }
  return plan.trim() === "" ? undefined : plan
}

/** Caps the plan-approval detail at 8KB, appending a truncation note when it was cut. */
function capPlanDetail(plan: string): string {
  if (Buffer.byteLength(plan, "utf8") <= PLAN_DETAIL_MAX_BYTES) return plan
  const clipped = Buffer.from(plan, "utf8")
    .subarray(0, PLAN_DETAIL_MAX_BYTES)
    .toString("utf8")
    .replace(/�+$/, "")
  return `${clipped}\n[... plan truncated at ${PLAN_DETAIL_MAX_BYTES / 1024}KB for this approval ...]`
}

/* ----------------------------- persistable-rule derivation ----------------------------- */

/**
 * Rule an acceptAlways decision on the DEFAULT approval path would persist. Re-exported from
 * the permission engine so the loop's fallback (runtimes without a derivePersistableRule
 * method, e.g. scripted test doubles) certifies exactly the production derivation — physical
 * (realpath) workspace containment included — rather than a diverging lexical copy.
 */
export { derivePersistableRule }

/**
 * Deterministic JSON with object keys sorted at every depth, used to compare tool inputs for
 * doom-loop detection. Tool inputs come from JSON parses, so cycles cannot occur; non-JSON
 * values (undefined) canonicalize to a stable placeholder.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined"
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
}

/** One-line provisional transcript label used until the tool reports its own. */
function callLabel(name: string, input: unknown): string {
  const record =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}
  const detail = [record.path, record.command, record.pattern, record.question].find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  )
  if (!detail) return name
  const firstLine = detail.split("\n", 1)[0] ?? detail
  const clipped =
    firstLine.length > LABEL_MAX_CHARS ? `${firstLine.slice(0, LABEL_MAX_CHARS - 1)}…` : firstLine
  return `${name}: ${clipped}`
}

/**
 * Default diff collector: `git diff` for tracked paths, `git diff --no-index /dev/null <path>`
 * for untracked files. Failures (no git, not a repo) return an empty diff rather than throwing.
 */
export async function collectGitDiff(
  cwd: string,
  paths: string[],
  sandbox?: SandboxRuntime,
): Promise<string> {
  const git = sandbox
    ? async (args: string[], _cwd: string) => {
        const result = await sandbox.execute(
          ["/usr/bin/git", ...safeGitArguments(args)],
          AbortSignal.timeout(GIT_DIFF_TIMEOUT_MS),
          "plan",
        )
        return result.exitCode <= 1 ? result.stdout : undefined
      }
    : runGit
  const chunks: string[] = []
  for (const path of paths) {
    const tracked = await git(["diff", "--", path], cwd)
    if (tracked === undefined) continue
    if (tracked.trim() !== "") {
      chunks.push(tracked)
      continue
    }
    const inIndex = await git(["ls-files", "--", path], cwd)
    if (inIndex === undefined || inIndex.trim() !== "") continue
    if (!(await Bun.file(path).exists())) continue
    const untracked = await git(["diff", "--no-index", "--", "/dev/null", path], cwd)
    if (untracked !== undefined && untracked.trim() !== "") chunks.push(untracked)
  }
  return truncateToolOutput(chunks.join(""))
}

async function runGit(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const child = Bun.spawn(["git", ...safeGitArguments(args)], {
      cwd,
      env: safeGitEnvironment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
    // A dying harness (crash, second Ctrl+C, process.exit) must not orphan the git child.
    const unregisterChild = registerChildProcess(child)
    const timer = setTimeout(() => child.kill(), GIT_DIFF_TIMEOUT_MS)
    try {
      const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
      // `git diff` exits 0; `git diff --no-index` exits 1 when the files differ.
      if (exitCode !== 0 && exitCode !== 1) return undefined
      return output
    } finally {
      clearTimeout(timer)
      unregisterChild()
    }
  } catch {
    return undefined
  }
}
