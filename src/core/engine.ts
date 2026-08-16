/** Provider-independent contracts for live engine sessions. */
import type { ApprovalPolicy, SandboxMode } from "./config.ts"
import type { AgentEvent, EngineId } from "./events.ts"

export type SessionPolicy = {
  sandbox: SandboxMode
  approvalPolicy: ApprovalPolicy
}

export const defaultSessionPolicy: SessionPolicy = {
  sandbox: "workspace-write",
  approvalPolicy: "on-request",
}

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
  compatible?: boolean
  version?: string
  detail?: string
}

export type OpenSessionOptions = {
  cwd: string
  localSessionId: string
  nativeSessionId?: string
  model?: string
  /** Sandbox and approval policy; engines that support policies must apply it, not silently ignore it. */
  policy?: SessionPolicy
  /** First event sequence number; lets a resumed session continue a persisted log monotonically. */
  firstSequence?: number
  /** Turn IDs already present in local history, for reconciling a resumed provider thread. */
  knownTurnIds?: readonly string[]
}

export type UserInput = {
  text: string
  images?: string[]
}

export type EngineDecision = {
  choice: string
  data?: unknown
}

export type EngineModel = {
  id: string
  displayName: string
  description?: string
  isDefault: boolean
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
  /** Lists selectable models; absent when the engine has no model picker. */
  listModels?(): Promise<EngineModel[]>
  /** Switches the model for subsequent turns; absent when the engine cannot switch. */
  setModel?(model: string): Promise<void>
}

export interface EngineDriver {
  readonly id: EngineId
  probe(): Promise<EngineProbe>
  openSession(options: OpenSessionOptions): Promise<EngineSession>
}
