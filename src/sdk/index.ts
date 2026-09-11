import type { AgentSession, CreateAgentSessionOptions, IntegrationOptions } from "./types.ts"

export type { ContextInspection, EngineDecision, SessionUsageSnapshot, UserInput } from "../core/engine.ts"
export type { AgentEvent } from "../core/events.ts"
export type { InputAcknowledgment, InputIntent, InputStatus } from "../core/session/input-queue.ts"
export type {
  ModelInfo,
  ProviderRequest,
  ProviderStreamEvent,
  ToolOutcome,
} from "../engines/codesplash/contracts.ts"
export type {
  ExtensionApi,
  ExtensionFactory,
  ExtensionProvider,
  ExtensionTool,
  HostExtension,
} from "../engines/codesplash/extensions/api.ts"
export { extensionModelId, extensionToolId } from "../engines/codesplash/extensions/identifiers.ts"
export type * from "./types.ts"

function requireBun(): void {
  const version = typeof Bun === "undefined" ? [] : Bun.version.split(".").map(Number)
  if (
    typeof Bun === "undefined" ||
    !version[0] ||
    (version[0] === 1 && ((version[1] ?? 0) < 3 || (version[1] === 3 && (version[2] ?? 0) < 14)))
  )
    throw new Error(
      "CodeSplash SDK execution requires Bun >=1.3.14; Node supports importing this facade only",
    )
}
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<AgentSession> {
  requireBun()
  return (await import("./runtime.ts")).create(options)
}
export async function reviewIntegration(
  options: IntegrationOptions,
  kind: "mcp" | "hook" | "extension",
  id: string,
) {
  requireBun()
  return (await import("./review.ts")).review(options, kind, id)
}
/** Explicitly trust exactly the fingerprint returned by reviewIntegration. Rechecks the source. */
export async function trustIntegration(
  options: IntegrationOptions,
  kind: "mcp" | "hook" | "extension",
  id: string,
  fingerprint: string,
): Promise<void> {
  requireBun()
  return (await import("./review.ts")).trust(options, kind, id, fingerprint)
}
