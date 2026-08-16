/** Lossless normalized events consumed by persistence and the TUI reducer. */
export type EngineId = "codex" | "claude"

export type NativeEventIds = {
  threadId?: string
  turnId?: string
  itemId?: string
  requestId?: string
}

export type AgentEventEnvelope = {
  schemaVersion: 1
  sequence: number
  timestamp: string
  engine: EngineId
  localSessionId: string
  native?: NativeEventIds
  providerEvent?: string
  raw?: unknown
  sensitive?: boolean
}

type EventOf<Kind extends string, Payload> = AgentEventEnvelope & {
  kind: Kind
  payload: Payload
}

export type SessionStatus = "starting" | "ready" | "running" | "waiting" | "closed" | "failed"
export type TurnStatus = "idle" | "running" | "completed" | "interrupted" | "failed"
export type ItemStatus = "running" | "completed" | "failed"

export type AgentEvent =
  | EventOf<"session.status", { status: SessionStatus; detail?: string; model?: string }>
  | EventOf<"turn.started", Record<string, never>>
  | EventOf<"turn.completed", { status: Exclude<TurnStatus, "idle" | "running"> }>
  | EventOf<"user.message", { id: string; text: string }>
  | EventOf<"message.delta", { id: string; text: string }>
  | EventOf<"message.completed", { id: string; text?: string }>
  | EventOf<"reasoning.delta", { id: string; text: string }>
  | EventOf<"reasoning.completed", { id: string; text?: string }>
  | EventOf<"item.updated", { id: string; label: string; output?: string; status: ItemStatus }>
  | EventOf<"plan.updated", { steps: Array<{ text: string; completed: boolean }> }>
  | EventOf<"diff.updated", { id: string; path?: string; unified: string }>
  | EventOf<
      "request.opened",
      { id: string; requestKind: "approval" | "user-input"; title: string; detail: string; choices: string[] }
    >
  | EventOf<"request.resolved", { id: string; decision: string }>
  | EventOf<
      "usage.updated",
      {
        inputTokens?: number
        cachedInputTokens?: number
        outputTokens?: number
        contextTokens?: number
        totalTokens?: number
        modelContextWindow?: number
        estimatedCostUsd?: number
      }
    >
  | EventOf<"warning", { message: string }>
  | EventOf<"error", { message: string; recoverable: boolean }>

export type AgentEventInput = AgentEvent extends infer Event
  ? Event extends AgentEvent
    ? Omit<Event, keyof AgentEventEnvelope>
    : never
  : never

export function createAgentEvent(
  envelope: Omit<AgentEventEnvelope, "schemaVersion" | "timestamp"> & { timestamp?: string },
  event: AgentEventInput,
): AgentEvent {
  return {
    schemaVersion: 1,
    timestamp: envelope.timestamp ?? new Date().toISOString(),
    ...envelope,
    ...event,
  } as AgentEvent
}
