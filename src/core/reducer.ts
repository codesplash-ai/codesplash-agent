/** Pure projection from the ordered engine event stream to renderable application state. */
import type { AgentEvent, EngineId, ItemStatus, SessionStatus, TurnStatus } from "./events.ts"

export type TranscriptItem = {
  id: string
  kind: "user" | "message" | "reasoning" | "tool" | "diff"
  label?: string
  text: string
  status: ItemStatus
}

export type PendingRequest = {
  id: string
  requestKind: "approval" | "user-input"
  title: string
  detail: string
  choices: string[]
}

export type AppViewState = {
  engine?: EngineId
  sessionStatus: SessionStatus
  turnStatus: TurnStatus
  transcript: TranscriptItem[]
  plan: Array<{ text: string; completed: boolean }>
  pendingRequest?: PendingRequest
  usage: {
    inputTokens?: number
    cachedInputTokens?: number
    outputTokens?: number
    estimatedCostUsd?: number
  }
  warnings: string[]
  error?: { message: string; recoverable: boolean }
  lastSequence: number
}

export const initialAppViewState: AppViewState = {
  sessionStatus: "starting",
  turnStatus: "idle",
  transcript: [],
  plan: [],
  usage: {},
  warnings: [],
  lastSequence: -1,
}

function upsertTranscriptItem(
  transcript: TranscriptItem[],
  id: string,
  create: () => TranscriptItem,
  update: (item: TranscriptItem) => TranscriptItem,
): TranscriptItem[] {
  const index = transcript.findIndex((item) => item.id === id)
  if (index === -1) return [...transcript, create()]

  return transcript.map((item, itemIndex) => (itemIndex === index ? update(item) : item))
}

export function reduceAgentEvent(state: AppViewState, event: AgentEvent): AppViewState {
  if (event.sequence <= state.lastSequence) return state

  const next = { ...state, engine: event.engine, lastSequence: event.sequence }

  switch (event.kind) {
    case "session.status":
      return { ...next, sessionStatus: event.payload.status }
    case "turn.started":
      return { ...next, sessionStatus: "running", turnStatus: "running", error: undefined }
    case "turn.completed":
      return { ...next, sessionStatus: "ready", turnStatus: event.payload.status }
    case "user.message":
      return {
        ...next,
        transcript: [
          ...state.transcript,
          { id: event.payload.id, kind: "user", text: event.payload.text, status: "completed" },
        ],
      }
    case "message.delta":
      return {
        ...next,
        transcript: upsertTranscriptItem(
          state.transcript,
          event.payload.id,
          () => ({ id: event.payload.id, kind: "message", text: event.payload.text, status: "running" }),
          (item) => ({ ...item, text: item.text + event.payload.text, status: "running" }),
        ),
      }
    case "message.completed":
      return {
        ...next,
        transcript: upsertTranscriptItem(
          state.transcript,
          event.payload.id,
          () => ({
            id: event.payload.id,
            kind: "message",
            text: event.payload.text ?? "",
            status: "completed",
          }),
          (item) => ({ ...item, text: event.payload.text ?? item.text, status: "completed" }),
        ),
      }
    case "reasoning.delta":
      return {
        ...next,
        transcript: upsertTranscriptItem(
          state.transcript,
          event.payload.id,
          () => ({ id: event.payload.id, kind: "reasoning", text: event.payload.text, status: "running" }),
          (item) => ({ ...item, text: item.text + event.payload.text }),
        ),
      }
    case "item.updated":
      return {
        ...next,
        transcript: upsertTranscriptItem(
          state.transcript,
          event.payload.id,
          () => ({
            id: event.payload.id,
            kind: "tool",
            label: event.payload.label,
            text: event.payload.output ?? "",
            status: event.payload.status,
          }),
          (item) => ({
            ...item,
            label: event.payload.label,
            text: event.payload.output ?? item.text,
            status: event.payload.status,
          }),
        ),
      }
    case "plan.updated":
      return { ...next, plan: event.payload.steps }
    case "diff.updated":
      return {
        ...next,
        transcript: upsertTranscriptItem(
          state.transcript,
          event.payload.id,
          () => ({
            id: event.payload.id,
            kind: "diff",
            label: event.payload.path,
            text: event.payload.unified,
            status: "completed",
          }),
          (item) => ({ ...item, label: event.payload.path, text: event.payload.unified }),
        ),
      }
    case "request.opened":
      return { ...next, sessionStatus: "waiting", pendingRequest: event.payload }
    case "request.resolved":
      return {
        ...next,
        sessionStatus: state.turnStatus === "running" ? "running" : "ready",
        pendingRequest: state.pendingRequest?.id === event.payload.id ? undefined : state.pendingRequest,
      }
    case "usage.updated":
      return { ...next, usage: { ...state.usage, ...event.payload } }
    case "warning":
      return { ...next, warnings: [...state.warnings, event.payload.message] }
    case "error":
      return {
        ...next,
        sessionStatus: event.payload.recoverable ? state.sessionStatus : "failed",
        error: event.payload,
      }
  }
}
