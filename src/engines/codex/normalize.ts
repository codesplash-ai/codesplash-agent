import { type AgentEvent, type AgentEventInput, createAgentEvent, type ItemStatus } from "../../core/index.ts"
import type { AccountRateLimitsUpdatedNotification } from "./generated/v2/AccountRateLimitsUpdatedNotification.ts"
import type { AgentMessageDeltaNotification } from "./generated/v2/AgentMessageDeltaNotification.ts"
import type { ErrorNotification } from "./generated/v2/ErrorNotification.ts"
import type { ItemCompletedNotification } from "./generated/v2/ItemCompletedNotification.ts"
import type { ItemStartedNotification } from "./generated/v2/ItemStartedNotification.ts"
import type { ReasoningSummaryTextDeltaNotification } from "./generated/v2/ReasoningSummaryTextDeltaNotification.ts"
import type { ReasoningTextDeltaNotification } from "./generated/v2/ReasoningTextDeltaNotification.ts"
import type { ThreadItem } from "./generated/v2/ThreadItem.ts"
import type { ThreadTokenUsageUpdatedNotification } from "./generated/v2/ThreadTokenUsageUpdatedNotification.ts"
import type { TurnCompletedNotification } from "./generated/v2/TurnCompletedNotification.ts"
import type { TurnDiffUpdatedNotification } from "./generated/v2/TurnDiffUpdatedNotification.ts"
import type { TurnPlanUpdatedNotification } from "./generated/v2/TurnPlanUpdatedNotification.ts"
import type { TurnStartedNotification } from "./generated/v2/TurnStartedNotification.ts"
import type { WarningNotification } from "./generated/v2/WarningNotification.ts"
import type { JsonRpcNotification } from "./json-rpc.ts"

export class CodexEventNormalizer {
  #sequence: number

  constructor(
    readonly localSessionId: string,
    startSequence = 0,
  ) {
    this.#sequence = startSequence
  }

  normalize(notification: JsonRpcNotification): AgentEvent[] {
    const raw = notification.params

    switch (notification.method) {
      case "turn/started": {
        const params = raw as TurnStartedNotification
        return [
          this.#event(
            notification.method,
            raw,
            { threadId: params.threadId, turnId: params.turn.id },
            {
              kind: "turn.started",
              payload: {},
            },
          ),
        ]
      }
      case "turn/completed": {
        const params = raw as TurnCompletedNotification
        const status = params.turn.status === "inProgress" ? "failed" : params.turn.status
        return [
          this.#event(
            notification.method,
            raw,
            { threadId: params.threadId, turnId: params.turn.id },
            {
              kind: "turn.completed",
              payload: { status },
            },
          ),
        ]
      }
      case "item/agentMessage/delta": {
        const params = raw as AgentMessageDeltaNotification
        return [
          this.#event(notification.method, raw, ids(params), {
            kind: "message.delta",
            payload: { id: params.itemId, text: params.delta },
          }),
        ]
      }
      case "item/reasoning/summaryTextDelta": {
        const params = raw as ReasoningSummaryTextDeltaNotification
        return [
          this.#event(notification.method, raw, ids(params), {
            kind: "reasoning.delta",
            payload: { id: params.itemId, text: params.delta },
          }),
        ]
      }
      case "item/reasoning/textDelta": {
        const params = raw as ReasoningTextDeltaNotification
        return [
          this.#event(notification.method, raw, ids(params), {
            kind: "reasoning.delta",
            payload: { id: params.itemId, text: params.delta },
          }),
        ]
      }
      case "item/started": {
        const params = raw as ItemStartedNotification
        if (params.item.type === "reasoning") {
          return [
            this.#event(notification.method, raw, ids({ ...params, itemId: params.item.id }), {
              kind: "reasoning.delta",
              payload: { id: params.item.id, text: "" },
            }),
          ]
        }
        const item = normalizeItem(params.item, "running")
        return item
          ? [this.#event(notification.method, raw, ids({ ...params, itemId: params.item.id }), item, true)]
          : []
      }
      case "item/completed": {
        const params = raw as ItemCompletedNotification
        if (params.item.type === "agentMessage") {
          return [
            this.#event(notification.method, raw, ids({ ...params, itemId: params.item.id }), {
              kind: "message.completed",
              payload: { id: params.item.id, text: params.item.text },
            }),
          ]
        }
        if (params.item.type === "reasoning") {
          return [
            this.#event(notification.method, raw, ids({ ...params, itemId: params.item.id }), {
              kind: "reasoning.completed",
              payload: { id: params.item.id },
            }),
          ]
        }
        const item = normalizeItem(params.item, "completed")
        return item
          ? [this.#event(notification.method, raw, ids({ ...params, itemId: params.item.id }), item, true)]
          : []
      }
      case "turn/diff/updated": {
        const params = raw as TurnDiffUpdatedNotification
        return [
          this.#event(
            notification.method,
            raw,
            ids(params),
            {
              kind: "diff.updated",
              payload: { id: `diff:${params.turnId}`, unified: params.diff },
            },
            true,
          ),
        ]
      }
      case "turn/plan/updated": {
        const params = raw as TurnPlanUpdatedNotification
        return [
          this.#event(notification.method, raw, ids(params), {
            kind: "plan.updated",
            payload: {
              steps: params.plan.map((step) => ({ text: step.step, completed: step.status === "completed" })),
            },
          }),
        ]
      }
      case "thread/tokenUsage/updated": {
        const params = raw as ThreadTokenUsageUpdatedNotification
        return [
          this.#event(notification.method, raw, ids(params), {
            kind: "usage.updated",
            payload: {
              inputTokens: params.tokenUsage.last.inputTokens,
              cachedInputTokens: params.tokenUsage.last.cachedInputTokens,
              outputTokens: params.tokenUsage.last.outputTokens,
              contextTokens: params.tokenUsage.last.totalTokens,
              totalTokens: params.tokenUsage.total.totalTokens,
              modelContextWindow: params.tokenUsage.modelContextWindow ?? undefined,
            },
          }),
        ]
      }
      case "account/rateLimits/updated": {
        const params = raw as AccountRateLimitsUpdatedNotification
        const window = params.rateLimits.primary ?? params.rateLimits.secondary
        if (!window) return []
        return [
          this.#event(
            notification.method,
            raw,
            {},
            {
              kind: "usage.updated",
              payload: {
                rateLimit: {
                  usedPercent: window.usedPercent,
                  label: params.rateLimits.limitName ?? params.rateLimits.planType ?? undefined,
                  resetsAt:
                    window.resetsAt === null ? undefined : new Date(window.resetsAt * 1000).toISOString(),
                },
              },
            },
          ),
        ]
      }
      case "warning": {
        const params = raw as WarningNotification
        return [
          this.#event(
            notification.method,
            raw,
            { threadId: params.threadId ?? undefined },
            {
              kind: "warning",
              payload: { message: params.message },
            },
          ),
        ]
      }
      case "error": {
        const params = raw as ErrorNotification
        return [
          this.#event(
            notification.method,
            raw,
            ids(params),
            {
              kind: "error",
              payload: { message: params.error.message, recoverable: params.willRetry },
            },
            true,
          ),
        ]
      }
      default:
        return []
    }
  }

  event(
    providerEvent: string,
    raw: unknown,
    native: { threadId?: string; turnId?: string; itemId?: string; requestId?: string },
    event: AgentEventInput,
    sensitive = false,
  ): AgentEvent {
    return this.#event(providerEvent, raw, native, event, sensitive)
  }

  #event(
    providerEvent: string,
    raw: unknown,
    native: { threadId?: string; turnId?: string; itemId?: string; requestId?: string },
    event: AgentEventInput,
    sensitive = false,
  ): AgentEvent {
    return createAgentEvent(
      {
        engine: "codex",
        localSessionId: this.localSessionId,
        sequence: this.#sequence++,
        native,
        providerEvent,
        raw,
        sensitive,
      },
      event,
    )
  }
}

function ids(params: { threadId: string; turnId: string; itemId?: string }) {
  return { threadId: params.threadId, turnId: params.turnId, itemId: params.itemId }
}

export function normalizeItem(item: ThreadItem, fallbackStatus: ItemStatus): AgentEventInput | undefined {
  switch (item.type) {
    case "commandExecution":
      return {
        kind: "item.updated",
        payload: {
          id: item.id,
          label: item.command,
          output: item.aggregatedOutput ?? undefined,
          status: normalizeStatus(item.status),
        },
      }
    case "fileChange":
      return {
        kind: "item.updated",
        payload: { id: item.id, label: "File changes", status: normalizeStatus(item.status) },
      }
    case "mcpToolCall":
      return {
        kind: "item.updated",
        payload: {
          id: item.id,
          label: `${item.server}/${item.tool}`,
          output: item.error?.message,
          status: normalizeStatus(item.status),
        },
      }
    case "dynamicToolCall":
      return {
        kind: "item.updated",
        payload: { id: item.id, label: item.tool, status: normalizeStatus(item.status) },
      }
    case "webSearch":
      return {
        kind: "item.updated",
        payload: { id: item.id, label: "Web search", status: fallbackStatus },
      }
    case "imageView":
      return {
        kind: "item.updated",
        payload: { id: item.id, label: `View ${item.path}`, status: fallbackStatus },
      }
    default:
      return undefined
  }
}

function normalizeStatus(status: string): ItemStatus {
  if (status === "inProgress") return "running"
  if (status === "completed") return "completed"
  return "failed"
}
