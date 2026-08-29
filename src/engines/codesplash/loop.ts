/**
 * The CodeSplash turn state machine. Owns the ChatMessage history, streams provider responses,
 * runs tool rounds (read-only calls concurrently, mutating calls sequentially), gates calls
 * behind approval requests, and emits the normalized AgentEvent stream the harness UI consumes.
 */
import {
  type AgentEvent,
  type AgentEventInput,
  createAgentEvent,
  type ItemStatus,
  type NativeEventIds,
  registerChildProcess,
  type SessionPolicy,
} from "../../core/index.ts"
import {
  ASK_USER_TOOL_NAME,
  type ChatMessage,
  type ContentBlock,
  type HarnessTool,
  type ModelInfo,
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
import type { ToolRegistry } from "./tools/registry.ts"
import { truncateToolOutput } from "./tools/truncate.ts"

/** Tool rounds per turn before the harness forces the turn to end. */
export const MAX_TOOL_ROUNDS = 50
/** Concurrency cap for read-only tool calls within one round. */
export const READ_ONLY_CONCURRENCY = 4
/** Choice set understood by the existing A/S/D/C approval UI. */
export const APPROVAL_CHOICES = ["accept", "acceptForSession", "decline", "cancel"] as const

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
  cwd: string
  policy: SessionPolicy
  registry: ToolRegistry
  events: CodesplashEventFactory
  emit: (event: AgentEvent) => void
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

  constructor(options: CodesplashLoopOptions) {
    this.#cwd = options.cwd
    this.#policy = options.policy
    this.#registry = options.registry
    this.#events = options.events
    this.#emit = options.emit
    this.#maxToolRounds = options.maxToolRounds ?? MAX_TOOL_ROUNDS
    this.#collectDiff = options.collectDiff ?? collectGitDiff
    this.#fallbackModel = options.fallbackModel
    this.#resolveModel = options.resolveModel
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
        const response = await this.#streamResponse(provider, model, request, abort.signal)
        if (response.kind === "error") {
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

        const round = await this.#runToolRound(response.toolCalls, abort.signal)
        this.#history.push({ role: "user", content: round.results })
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
      const message = error instanceof Error ? error.message : String(error)
      this.#event("loop/error", {}, { kind: "error", payload: { message, recoverable: false } })
      this.#completeTurn("failed")
    } finally {
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

  /** Only read-only calls that need no approval may overlap; everything else runs in order. */
  #canRunConcurrently(tool: HarnessTool, call: ToolCallBlock, signal: AbortSignal): boolean {
    if (tool.name === ASK_USER_TOOL_NAME) return false
    try {
      return (
        tool.isReadOnly(call.input) && tool.permission(call.input, this.#toolContext(signal)).kind === "none"
      )
    } catch {
      return false
    }
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
      if (tool.name === ASK_USER_TOOL_NAME) return await this.#runAskUser(call, itemId, signal)

      const permission = tool.permission(call.input, this.#toolContext(signal))
      if (permission.kind === "approval") {
        const preApproved =
          permission.sessionKey !== undefined && this.#sessionApprovals.has(permission.sessionKey)
        if (!preApproved) {
          const choice = await this.#awaitDecision(
            "approval",
            permission.title,
            permission.detail,
            [...APPROVAL_CHOICES],
            itemId,
            signal,
          )
          if (choice === "acceptForSession" && permission.sessionKey !== undefined) {
            this.#sessionApprovals.add(permission.sessionKey)
          }
          if (choice === "decline" || choice === "cancel") {
            const message =
              choice === "decline"
                ? `The user declined the request to run ${tool.name}.`
                : `The user cancelled the request to run ${tool.name}.`
            return this.#failCall(itemId, call, provisionalLabel, message)
          }
        }
      }

      const outcome = await tool.run(call.input, this.#toolContext(signal))
      if (outcome.planSteps) {
        this.#event("tool/plan", { itemId }, { kind: "plan.updated", payload: { steps: outcome.planSteps } })
      }
      for (const path of outcome.mutatedPaths ?? []) mutated.add(path)
      this.#emitToolItem(itemId, outcome.label, outcome.text, outcome.isError ? "failed" : "completed")
      const result: ToolResultBlock = { type: "tool_result", toolCallId: call.id, text: outcome.text }
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

  /* ------------------------------------ requests ------------------------------------ */

  #awaitDecision(
    requestKind: "approval" | "user-input",
    title: string,
    detail: string,
    choices: string[],
    itemId: string,
    signal: AbortSignal,
  ): Promise<string> {
    const requestId = crypto.randomUUID()
    this.#event(
      "request/opened",
      { itemId, requestId },
      { kind: "request.opened", payload: { id: requestId, requestKind, title, detail, choices } },
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
    this.#emitToolItem(itemId, label, message, "failed")
    return { type: "tool_result", toolCallId: call.id, text: message, isError: true }
  }

  #toolContext(signal: AbortSignal): ToolContext {
    return { cwd: this.#cwd, policy: this.#policy, signal }
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
export async function collectGitDiff(cwd: string, paths: string[]): Promise<string> {
  const chunks: string[] = []
  for (const path of paths) {
    const tracked = await runGit(["diff", "--", path], cwd)
    if (tracked === undefined) continue
    if (tracked.trim() !== "") {
      chunks.push(tracked)
      continue
    }
    const inIndex = await runGit(["ls-files", "--", path], cwd)
    if (inIndex === undefined || inIndex.trim() !== "") continue
    if (!(await Bun.file(path).exists())) continue
    const untracked = await runGit(["diff", "--no-index", "--", "/dev/null", path], cwd)
    if (untracked !== undefined && untracked.trim() !== "") chunks.push(untracked)
  }
  return truncateToolOutput(chunks.join(""))
}

async function runGit(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const child = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore" })
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
