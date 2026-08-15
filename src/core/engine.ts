/** Provider-independent contracts for live engine sessions. */
import type { AgentEvent, EngineId } from "./events.ts"

export type EngineSurface = "native" | "terminal-handoff" | "embedded-pty"

export type EngineCapabilities = {
  nativeTranscript: boolean
  approvals: boolean
  interrupt: boolean
  resume: boolean
  fork: boolean
  usage: "none" | "tokens" | "estimated-cost"
  surface: EngineSurface
}

export type EngineProbe = {
  available: boolean
  authenticated?: boolean
  version?: string
  detail?: string
}

export type OpenSessionOptions = {
  cwd: string
  localSessionId: string
  nativeSessionId?: string
  model?: string
}

export type UserInput = {
  text: string
  images?: string[]
}

export type EngineDecision = {
  choice: string
  data?: unknown
}

export interface EngineSession {
  readonly localSessionId: string
  readonly nativeSessionId?: string
  readonly capabilities: EngineCapabilities
  readonly events: AsyncIterable<AgentEvent>
  send(input: UserInput): Promise<void>
  resolveRequest(requestId: string, decision: EngineDecision): Promise<void>
  interrupt(): Promise<void>
  close(): Promise<void>
}

export interface EngineDriver {
  readonly id: EngineId
  probe(): Promise<EngineProbe>
  openSession(options: OpenSessionOptions): Promise<EngineSession>
}
