import { createHash } from "node:crypto"
import type { ContextInspection } from "../../core/engine.ts"
import {
  type ChatMessage,
  type ModelInfo,
  ProviderHttpError,
  type ProviderRequest,
  type ToolSpec,
} from "./contracts.ts"
import { truncateToolOutput } from "./tools/truncate.ts"

export type ContextOptions = { autoCompact?: boolean; compactionStrategy?: "summary" | "prune" }

/** Planning heuristic, not a tokenizer or proof that a provider will accept the request. */
export function estimateText(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3)
}

export function estimateMessages(messages: readonly ChatMessage[]): number {
  return messages.reduce(
    (total, message) =>
      total +
      8 +
      message.content.reduce(
        (sum, block) => sum + (block.type === "image" ? 8192 : estimateText(JSON.stringify(block))),
        0,
      ),
    0,
  )
}

export function inspectContext(
  model: ModelInfo,
  system: string,
  tools: ToolSpec[],
  messages: readonly ChatMessage[],
): ContextInspection {
  const systemTokens = estimateText(system)
  const toolTokens = estimateText(JSON.stringify(tools))
  const messageTokens = estimateMessages(messages)
  return {
    model: model.id,
    contextWindow: model.contextWindow,
    systemTokens,
    toolTokens,
    messageTokens,
    totalTokens: systemTokens + toolTokens + messageTokens,
    outputReserve: model.maxOutputTokens,
    inputBudget: Math.max(
      0,
      model.contextWindow - model.maxOutputTokens - Math.ceil(model.contextWindow * 0.1),
    ),
    messageCount: messages.length,
    epoch: 0,
    prefixChanges: [],
    estimated: true,
  }
}

/** Only complete tool exchanges can be split; never leave a result without its original call. */
export function safeBoundaries(messages: readonly ChatMessage[]): number[] {
  const pending = new Set<string>()
  const boundaries: number[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!message) continue
    if (index > 0 && pending.size === 0 && !message.content.some((b) => b.type === "tool_result"))
      boundaries.push(index)
    for (const block of message.content) {
      if (block.type === "tool_call") {
        if (pending.has(block.id)) return []
        pending.add(block.id)
      } else if (block.type === "tool_result") {
        if (!pending.delete(block.toolCallId)) return []
      }
    }
  }
  return pending.size ? [] : boundaries
}

export function compactionBoundary(messages: readonly ChatMessage[], keepTokens: number): number {
  const boundaries = safeBoundaries(messages)
  if (!boundaries.length) return 0
  const latestUser = messages.findLastIndex(
    (m) => m.role === "user" && m.content.some((b) => b.type === "text" || b.type === "image"),
  )
  if (
    latestUser > 0 &&
    boundaries.includes(latestUser) &&
    estimateMessages(messages.slice(latestUser)) <= keepTokens
  )
    return latestUser
  return (
    boundaries.find((index) => estimateMessages(messages.slice(index)) <= keepTokens) ??
    boundaries.at(-1) ??
    0
  )
}

export function pruneToolResults(messages: readonly ChatMessage[]): ChatMessage[] {
  const recent = messages
    .map((m, i) => (m.content.some((b) => b.type === "tool_result") ? i : -1))
    .filter((i) => i >= 0)
    .slice(-2)
  return messages.map((message, index) => ({
    ...message,
    content: message.content.map((block) =>
      index < (recent[0] ?? messages.length) &&
      block.type === "tool_result" &&
      Buffer.byteLength(block.text) > 2400
        ? { ...block, text: truncateToolOutput(block.text, { maxBytes: 2200, maxLines: 100 }) }
        : block,
    ),
  }))
}

export function serializeSummary(messages: readonly ChatMessage[]): string[] {
  return messages.map((message) =>
    JSON.stringify({
      role: message.role,
      content: message.content
        .filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking")
        .map((b) =>
          b.type === "image" ? { type: "text", text: "[Earlier image omitted from summary]" } : b,
        ),
    }),
  )
}

export function isContextOverflow(error: unknown): boolean {
  return (
    error instanceof ProviderHttpError &&
    [400, 413, 422].includes(error.status ?? 0) &&
    /context[_ ](?:length|window)|prompt is too long|input (?:is )?too long|maximum context|too many (?:input )?tokens/i.test(
      error.message,
    )
  )
}

/** Hashes only: diagnostics never retain provider credentials or source prompt text. */
export class ContextTracker {
  epoch = 0
  #fingerprints: Record<string, string> | undefined
  #changes: string[] = []
  #ratio = 1
  #observed: number | undefined

  reset(): void {
    this.epoch++
    this.#ratio = 1
    this.#observed = undefined
  }

  inspect(request: ProviderRequest): ContextInspection {
    const fields = {
      model: `${request.model.provider}/${request.model.id}/${request.model.contextWindow}`,
      system: request.system,
      tools: JSON.stringify(request.tools),
      parameters: JSON.stringify([request.reasoningEffort, request.model.maxOutputTokens]),
    }
    const hashes = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, createHash("sha256").update(value).digest("hex")]),
    )
    if (this.#fingerprints) {
      const changes = Object.keys(hashes).filter((key) => hashes[key] !== this.#fingerprints?.[key])
      if (changes.length) {
        this.#changes = changes
        this.#ratio = 1
        this.#observed = undefined
      }
    }
    this.#fingerprints = hashes
    const context = inspectContext(request.model, request.system, request.tools, request.messages)
    return {
      ...context,
      totalTokens: Math.ceil(context.totalTokens * this.#ratio),
      epoch: this.epoch,
      observedInputTokens: this.#observed,
      prefixChanges: [...this.#changes],
    }
  }

  observe(inputTokens: number, estimated: number): void {
    if (!Number.isFinite(inputTokens) || inputTokens < 0) return
    this.#observed = inputTokens
    if (estimated > 0) this.#ratio = Math.max(this.#ratio, inputTokens / estimated)
  }
}

export type SystemReminder = { source: "permission-mode" | "tool-output"; text: string }
export function reminderText(reminder: SystemReminder): string {
  return `[Harness reminder: ${reminder.source}] ${truncateToolOutput(reminder.text, { maxBytes: 2048 })}`
}
