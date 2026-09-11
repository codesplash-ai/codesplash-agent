import type { FormResponse, InteractionForm } from "../../../core/forms.ts"
import type { HookEvent, HookEventName } from "../../../core/hooks.ts"
import type {
  ModelInfo,
  PermissionTargets,
  ProviderRequest,
  ProviderStreamEvent,
  ToolOutcome,
} from "../contracts.ts"

export type ExtensionToolContext = {
  cwd: string
  signal: AbortSignal
  progress(text: string): void
}
export type ExtensionTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  override?: string
  readOnly?: boolean
  effects?: "workspace" | "external" | "workspace-and-external"
  targets?(input: unknown, cwd: string): PermissionTargets
  run(input: unknown, context: ExtensionToolContext): Promise<ToolOutcome>
}
export type ExtensionProvider = {
  name: string
  displayName: string
  protocol: "openai" | "anthropic"
  models: Array<Omit<ModelInfo, "provider" | "protocol">>
  /** Returns only this provider's credential. Never receives a harness credential lookup. */
  auth?(signal: AbortSignal): Promise<string | undefined>
  stream(
    request: ProviderRequest,
    context: { signal: AbortSignal; credential?: string },
  ): AsyncIterable<ProviderStreamEvent>
}
export type ExtensionCommand = {
  name: string
  description: string
  run(argument: string, context: { signal: AbortSignal }): Promise<string | void>
  complete?(argument: string, signal: AbortSignal): Promise<string[]>
}
export type ExtensionUiUpdate = {
  owner: string
  generation: string
  operation: "status" | "widget" | "composer" | "clear"
  key: string
  text: string
}
export type ExtensionApi = {
  readonly version: 1
  readonly id: string
  readonly generation: string
  readonly cwd: string
  readonly signal: AbortSignal
  registerTool(tool: ExtensionTool): void
  registerProvider(provider: ExtensionProvider): void
  registerCommand(command: ExtensionCommand): void
  registerFlag(
    name: string,
    options: { type: "string" | "boolean" | "number"; default?: string | boolean | number },
  ): string | boolean | number | undefined
  on(event: HookEventName, callback: (event: HookEvent, signal: AbortSignal) => void | Promise<void>): void
  /** Owned one-shot timer, at most 32 per extension. Returns a cancellation function. */
  after(milliseconds: number, callback: (signal: AbortSignal) => void | Promise<void>): () => void
  ui: {
    readonly available: boolean
    status(key: string, text?: string): boolean
    widget(key: string, text?: string): boolean
    /** Only replaces an empty, idle composer; returns false otherwise. */
    composer(text: string): boolean
    dialog(
      form: Omit<InteractionForm, "source">,
      signal?: AbortSignal,
    ): Promise<FormResponse | { action: "unsupported" }>
  }
  /** Owned, tool-free auxiliary model work; usage is recorded by the session. */
  complete(model: string, prompt: string, signal?: AbortSignal): Promise<string>
}
export type ExtensionFactory = (
  api: ExtensionApi,
) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>

/** Explicit application authority; factories run with the embedding process's privileges. */
export type HostExtension = {
  id: string
  factory: ExtensionFactory
  flags?: Record<string, string | boolean | number>
  overrides?: string[]
}
