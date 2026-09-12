import type { EngineDecision, EngineSession, UserInput } from "../core/engine.ts"
import type { AgentEvent } from "../core/events.ts"
import type { InputAcknowledgment, InputQueue, InputStatus } from "../core/session/input-queue.ts"
import type { SessionController } from "../core/session-controller.ts"
import type { ExtensionProvider, ExtensionTool, HostExtension } from "../engines/codesplash/extensions/api.ts"

export type SessionRequest = Extract<AgentEvent, { kind: "request.opened" }>["payload"]
export type SdkConfiguration = { path?: string; overrides?: readonly string[]; profile?: string }
export type IntegrationOptions = {
  cwd?: string
  config?: SdkConfiguration
  workspaceTrusted?: boolean
  trustDataDirectory?: string
}
export type CreateAgentSessionOptions = IntegrationOptions & {
  model?: string
  /** Default is ephemeral. A root is required so recording is an explicit storage decision. */
  persistence?: { root: string; resume?: string }
  extensions?: readonly HostExtension[]
  /** Convenience registrations owned by extension ID `sdk`. */
  tools?: readonly ExtensionTool[]
  providers?: readonly ExtensionProvider[]
  disableExtensions?: boolean
  interactive?: boolean
  onComposer?: (text: string) => boolean
  onEvent?: (event: AgentEvent) => void
  /** Omitted: decline/cancel. `manual`: call resolveRequest explicitly. */
  respond?: "manual" | ((request: SessionRequest, signal: AbortSignal) => Promise<EngineDecision>)
  /** Fences startup publication and closes the live session when aborted. */
  signal?: AbortSignal
}
export type PromptResult = { id: string; status: InputStatus }
export type AgentSession = Pick<
  SessionController,
  | "submit"
  | "resolveRequest"
  | "listModels"
  | "setModel"
  | "inspectContext"
  | "compact"
  | "tasks"
  | "teams"
  | "schedules"
  | "goals"
  | "workflows"
  | "worktrees"
  | "peers"
  | "spawnAgent"
  | "agentDefinitions"
  | "monitorTask"
  | "runCommand"
  | "mcpCommand"
  | "hooksCommand"
  | "extensionsCommand"
  | "pluginsCommand"
  | "contextResources"
  | "memoryCommand"
  | "sessionPresentation"
  | "sessionRecovery"
  | "changeDirectory"
  | "exportHistory"
> & {
  directoryStatus: NonNullable<EngineSession["directoryStatus"]>
  sandboxStatus: NonNullable<EngineSession["sandboxStatus"]>
  permissionRules: NonNullable<EngineSession["permissionRules"]>
  setPermissionMode: NonNullable<EngineSession["setPermissionMode"]>
  editPermissionRule: NonNullable<EngineSession["editPermissionRule"]>
  readonly inputs: Pick<
    InputQueue,
    "pause" | "resume" | "edit" | "move" | "remove" | "retry" | "clearCompleted"
  >
  readonly id: string
  readonly historyDirectory?: string
  readonly state: SessionController["state"]
  readonly usage: SessionController["state"]["usage"]
  readonly queue: NonNullable<SessionController["inputQueue"]>["snapshot"] extends () => infer T ? T : never
  subscribe(listener: (event: AgentEvent) => void): () => void
  subscribeState(listener: (state: SessionController["state"]) => void): () => void
  events(): AsyncIterableIterator<AgentEvent>
  prompt(input: string | UserInput, options?: { signal?: AbortSignal }): Promise<PromptResult>
  waitForInput(id: InputAcknowledgment["id"], signal?: AbortSignal): Promise<PromptResult>
  interrupt(): Promise<void>
  flush(): Promise<void>
  close(): Promise<void>
}
