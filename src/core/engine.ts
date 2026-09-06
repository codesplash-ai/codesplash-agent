/** Provider-independent contracts for live engine sessions. */
import type { ApprovalPolicy, PermissionMode, SandboxMode } from "./config.ts"
import type { AgentEvent, EngineId } from "./events.ts"

export type SessionPolicy = {
  sandbox: SandboxMode
  approvalPolicy: ApprovalPolicy
  /** First-party permission layer mode; absent means "default". */
  permissionMode?: PermissionMode
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

/**
 * Cumulative usage a resumed session already recorded, extracted from its persisted
 * `usage.updated` events. An engine that reports session-cumulative usage seeds its counters
 * from this so resumed runs continue the totals instead of restarting at zero.
 */
export type SessionUsageSnapshot = {
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  estimatedCostUsd?: number
  hasUnpricedUsage?: boolean
}

/** CLI-tier permission rule overrides, highest-precedence rule source after the built-in floors. */
export type PermissionRuleOverrides = {
  allow?: readonly string[]
  ask?: readonly string[]
  deny?: readonly string[]
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
  /** Cumulative usage recorded before a resume; only the codesplash engine uses it today. */
  initialUsage?: SessionUsageSnapshot
  /**
   * File path where an engine that owns its transcript may persist and reload provider-native
   * history across runs. Only the codesplash engine uses it today.
   */
  nativeTranscriptPath?: string
  /** Turn IDs already present in local history, for reconciling a resumed provider thread. */
  knownTurnIds?: readonly string[]
  /**
   * Whether the workspace's trust decision resolved to trusted; resolved by the caller from the
   * trust store. Engines treat absent as `true` (back-compat for existing call sites; the TUI
   * and runner always pass the real value).
   */
  workspaceTrusted?: boolean
  /** CLI-tier permission rules layered above the config's [permissions] rules. */
  permissionOverrides?: PermissionRuleOverrides
  /**
   * File where the engine persists and reloads remembered permission grants (same
   * caller-placed-file pattern as nativeTranscriptPath). Absent → the "always allow" choice is
   * never offered.
   */
  permissionGrantsPath?: string
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
  /** Switches the permission mode; absent when the engine has no first-party permission layer. */
  setPermissionMode?(mode: PermissionMode): Promise<void>
  /** User-invoked rule edits only; engines reject these while tools/turns are active. */
  editPermissionRule?(command: string): Promise<void>
  sandboxStatus?(): string
  permissionRules?(): Array<{
    tool: string
    pattern?: string
    action: "allow" | "ask" | "deny"
    source: "cli" | "project" | "user" | "grants" | "builtin"
    raw: string
    conflict?: string
  }>
}

export interface EngineDriver {
  readonly id: EngineId
  probe(): Promise<EngineProbe>
  openSession(options: OpenSessionOptions): Promise<EngineSession>
}
