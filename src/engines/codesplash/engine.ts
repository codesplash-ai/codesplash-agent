/**
 * The first-party CodeSplash engine behind the EngineDriver/EngineSession contract. Sessions run
 * entirely in-process: provider adapters stream model responses and the loop executes tools.
 */
import { dirname, extname, join } from "node:path"
import {
  type AgentConfig,
  type AgentEvent,
  AsyncQueue,
  defaultConfig,
  defaultSessionPolicy,
  type EngineCapabilities,
  type EngineDecision,
  type EngineDriver,
  type EngineModel,
  type EngineProbe,
  type EngineSession,
  loadConfig,
  type OpenSessionOptions,
  type PermissionMode,
  type SessionPolicy,
  type UserInput,
} from "../../core/index.ts"
import { APP_VERSION } from "../../version.ts"
import { PROVIDER_ENV_VARS, resolveApiKey } from "./auth.ts"
import {
  buildProviderRegistry,
  customProviderAvailable,
  findModel,
  formatModelSelector,
  type ModelSelection,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_KEY_VARIABLES,
  type ProviderRegistry,
} from "./catalog.ts"
import type {
  ChatMessage,
  ContentBlock,
  ImageBlock,
  ModelInfo,
  PermissionRuntime,
  ProviderClient,
  ProviderId,
  ReasoningEffort,
} from "./contracts.ts"
import { CodesplashEventFactory, CodesplashLoop } from "./loop.ts"
import { editPermissionRule, parsePermissionEdit, ruleConflict } from "./permission-editor.ts"
import {
  createPermissionRuntime,
  describePermissionRules,
  type PermissionRuntimeOptions,
} from "./permissions.ts"
import { buildSystemPrompt } from "./prompt.ts"
import type { SandboxRuntime } from "./sandbox/contracts.ts"
import { createProfile, pinProfile } from "./sandbox/profile.ts"
import { NativeSandbox } from "./sandbox/runtime.ts"
import { ToolOutputStore } from "./tool-output-store.ts"
import { builtinTools, createToolRegistry, type ToolRegistry } from "./tools/registry.ts"
import { appendTranscriptMessages, loadTranscript, writeTranscriptSnapshot } from "./transcript.ts"

export const CODESPLASH_CAPABILITIES: EngineCapabilities = {
  nativeTranscript: true,
  approvals: true,
  interrupt: true,
  resume: true,
  usage: "tokens",
  surface: "native",
}

const NO_KEYS_DETAIL = "No API keys found — set ANTHROPIC_API_KEY or OPENAI_API_KEY"

export type CodesplashDriverOptions = {
  /** Provider client overrides keyed by runtime id, e.g. scripted fakes in tests. */
  providers?: Partial<Record<string, ProviderClient>>
  /** Harness config; when absent it is loaded lazily the first time probe/openSession needs it. */
  config?: AgentConfig
  /** Permission-runtime factory override, e.g. scripted runtimes in tests; defaults to createPermissionRuntime. */
  permissions?: PermissionRuntimeFactory
  /** Test/embedding injection; production always uses the native OS executor. */
  sandbox?: (options: OpenSessionOptions, config: AgentConfig) => Promise<SandboxRuntime>
}

/** Factory shape for a session's permission runtime; injectable so tests script the runtime. */
export type PermissionRuntimeFactory = (options: PermissionRuntimeOptions) => Promise<PermissionRuntime>

/** Re-exported for factory injectors (tests) so they need not import permissions.ts directly. */
export type { PermissionRuntimeOptions as PermissionRuntimeFactoryOptions }

export class CodesplashDriver implements EngineDriver {
  readonly id = "codesplash" as const
  #configPromise: Promise<AgentConfig> | undefined

  constructor(readonly options: CodesplashDriverOptions = {}) {}

  async #config(): Promise<AgentConfig> {
    if (this.options.config) return this.options.config
    this.#configPromise ??= loadConfig()
    return this.#configPromise
  }

  /** Config for probe: a broken config file degrades to defaults instead of failing the probe. */
  async #probeConfig(): Promise<AgentConfig> {
    try {
      return await this.#config()
    } catch {
      return structuredClone(defaultConfig)
    }
  }

  /**
   * Reports availability from resolvable API keys — env var first, then the credential store —
   * naming each provider's source (env/stored), plus one fragment per configured custom provider
   * with its key state. Key values never appear in the probe.
   */
  async probe(): Promise<EngineProbe> {
    const config = await this.#probeConfig()
    const resolved = (Object.keys(PROVIDER_ENV_VARS) as ProviderId[]).flatMap((provider) => {
      const credential = resolveApiKey(provider)
      return credential ? [{ provider, source: credential.source }] : []
    })
    const builtinDetails = resolved.map(
      ({ provider, source }) => `${PROVIDER_DISPLAY_NAMES[provider]} API key (${source})`,
    )
    const customDetails = config.providers.map((provider) => {
      const keyState = process.env[provider.keyEnvVar]
        ? "key present"
        : provider.requiresKey
          ? "key missing"
          : "no key needed"
      return `${provider.displayName} (custom, ${keyState})`
    })
    const anyCustomAvailable = config.providers.some((provider) => customProviderAvailable(provider))

    if (resolved.length === 0 && !anyCustomAvailable) {
      return {
        available: false,
        authenticated: false,
        version: APP_VERSION,
        detail: [NO_KEYS_DETAIL, ...customDetails].join(" · "),
      }
    }
    return {
      available: true,
      authenticated: true,
      version: APP_VERSION,
      detail: [...builtinDetails, ...customDetails].join(" · "),
    }
  }

  async openSession(options: OpenSessionOptions): Promise<EngineSession> {
    const config = await this.#config()
    const registry = buildProviderRegistry(config)
    if (registry.providers.length === 0) {
      throw new Error(`${NO_KEYS_DETAIL} to use the CodeSplash engine`)
    }
    const providers: Record<string, ProviderClient> = {}
    for (const runtime of registry.providers) {
      providers[runtime.id] = this.options.providers?.[runtime.id] ?? runtime.client
    }
    // Resume: reload the provider-native history the transcript persisted. An empty or missing
    // file is simply a fresh session.
    const seededHistory = options.nativeTranscriptPath
      ? await loadTranscript(options.nativeTranscriptPath)
      : []
    // The permission runtime is built before the session object exists, so its creation-time
    // warnings (unknown rule tools, corrupt grants files) buffer in the bridge and flush as
    // warning events once the session can emit them.
    const bridge = new PermissionEventBridge()
    const factory = this.options.permissions ?? createPermissionRuntime
    const permissions = await factory({
      cwd: options.cwd,
      mode: options.policy?.permissionMode ?? "default",
      workspaceTrusted: options.workspaceTrusted ?? true,
      configRules: config.permissions,
      overrides: options.permissionOverrides,
      grantsPath: options.permissionGrantsPath,
      onWarning: (message) => bridge.warning(message),
      onModeChange: (mode) => bridge.modeChanged(mode),
    })
    const directory = options.nativeTranscriptPath ? dirname(options.nativeTranscriptPath) : undefined
    if (
      directory &&
      seededHistory.length &&
      !(await Bun.file(join(directory, "sandbox-profile.json")).exists())
    ) {
      bridge.warning(
        "This older session has no pinned execution profile. Pinning the current execution policy before tools can run; previous temporary access grants are not restored.",
      )
    }
    const sandbox = this.options.sandbox
      ? await this.options.sandbox(options, config)
      : new NativeSandbox(
          await pinProfile(
            createProfile(
              options.cwd,
              options.policy?.sandbox ?? defaultSessionPolicy.sandbox,
              config.sandbox,
            ),
            directory ? join(directory, "sandbox-profile.json") : undefined,
          ),
          directory ? join(directory, "sandbox-events.jsonl") : undefined,
        )
    return new CodesplashSession(
      options,
      config,
      registry,
      providers,
      seededHistory,
      permissions,
      bridge,
      sandbox,
    )
  }
}

/**
 * Routes permission-runtime callbacks into session events. The runtime is created before the
 * session exists, so warnings raised during creation are buffered and flushed on attach; mode
 * changes only ever happen on a live session.
 */
class PermissionEventBridge {
  readonly #buffered: string[] = []
  #warn: ((message: string) => void) | undefined
  #modeChanged: ((mode: PermissionMode) => void) | undefined

  warning(message: string): void {
    if (this.#warn) this.#warn(message)
    else this.#buffered.push(message)
  }

  modeChanged(mode: PermissionMode): void {
    this.#modeChanged?.(mode)
  }

  attach(warn: (message: string) => void, modeChanged: (mode: PermissionMode) => void): void {
    this.#warn = warn
    this.#modeChanged = modeChanged
    for (const message of this.#buffered.splice(0)) warn(message)
  }
}

class CodesplashSession implements EngineSession {
  readonly capabilities = CODESPLASH_CAPABILITIES
  readonly events: AsyncIterable<AgentEvent>
  readonly #queue = new AsyncQueue<AgentEvent>()
  readonly #factory: CodesplashEventFactory
  readonly #loop: CodesplashLoop
  readonly #registry: ToolRegistry
  readonly #providerRegistry: ProviderRegistry
  /** Provider clients keyed by runtime id ("anthropic", "openai", or a custom config key). */
  readonly #providers: Record<string, ProviderClient>
  readonly #config: AgentConfig
  readonly #policy: SessionPolicy
  readonly #cwd: string
  readonly #permissions: PermissionRuntime
  readonly #sandbox: SandboxRuntime
  /** Bypass can only be re-entered mid-session when the session was OPENED in bypass mode. */
  readonly #bypassAllowed: boolean
  #model: ModelInfo
  #reasoningEffort: ReasoningEffort | undefined
  /** Cached by model + permission mode + workspace trust; any of the three rebuilds the prompt. */
  #systemPrompt: { key: string; text: string } | undefined
  #turnPromise: Promise<void> | undefined
  /** Set synchronously in send() before any await so concurrent sends are refused reliably. */
  #turnReserved = false
  #closed = false
  #ended = false
  /** Transcript write failures degrade to a single warning event per session, never a crash. */
  #transcriptWarned = false
  #persistedRevision = 0
  #snapshotRequired = false
  #maintenanceAbort: AbortController | undefined

  constructor(
    readonly options: OpenSessionOptions,
    config: AgentConfig,
    providerRegistry: ProviderRegistry,
    providers: Record<string, ProviderClient>,
    seededHistory: ChatMessage[],
    permissions: PermissionRuntime,
    bridge: PermissionEventBridge,
    sandbox: SandboxRuntime,
  ) {
    this.events = this.#queue
    this.#config = config
    this.#providerRegistry = providerRegistry
    this.#providers = providers
    this.#policy = options.policy ?? defaultSessionPolicy
    this.#cwd = options.cwd
    this.#permissions = permissions
    this.#sandbox = sandbox
    this.#bypassAllowed = options.policy?.permissionMode === "bypass"
    this.#factory = new CodesplashEventFactory(options.localSessionId, options.firstSequence ?? 0)
    this.#registry = createToolRegistry(builtinTools())
    this.#loop = new CodesplashLoop({
      cwd: options.cwd,
      policy: this.#policy,
      registry: this.#registry,
      events: this.#factory,
      emit: (event) => this.#push(event),
      fallbackModel: config.codesplash.fallbackModel,
      context: config.codesplash,
      outputStore: new ToolOutputStore(
        options.nativeTranscriptPath
          ? join(dirname(options.nativeTranscriptPath), "tool-outputs")
          : undefined,
      ),
      permissions,
      sandbox,
      guardian: config.guardian,
      // Resume: continue the recorded cumulative usage instead of restarting the counts at zero.
      initialUsage: options.initialUsage,
      // Registry-backed: only models on available providers resolve, and test overrides in the
      // session's provider map take effect for the fallback path too.
      resolveModel: (id) => {
        const model = this.#providerRegistry.find(id)
        if (!model) return undefined
        const provider = this.#providers[model.provider]
        return provider ? { model, provider } : undefined
      },
    })
    if (seededHistory.length > 0) this.#loop.seedHistory(seededHistory)

    this.#push(
      this.#factory.event("session/opening", {}, { kind: "session.status", payload: { status: "starting" } }),
    )
    // Attached after the opening status: runtime-creation warnings land between it and "ready",
    // and later mode changes (setPermissionMode, the loop's plan tools) become status events.
    bridge.attach(
      (message) =>
        this.#push(this.#factory.event("permissions/warning", {}, { kind: "warning", payload: { message } })),
      (mode) =>
        this.#push(
          this.#factory.event(
            "permissions/modeChanged",
            {},
            {
              kind: "session.status",
              payload: { status: this.#loop.isTurnActive ? "running" : "ready", permissionMode: mode },
            },
          ),
        ),
    )
    const selection = options.model
      ? this.#selectModel(options.model)
      : { model: this.#providerRegistry.defaultModel(), effort: undefined }
    this.#model = selection.model
    this.#reasoningEffort = selection.effort
    this.#push(
      this.#factory.event(
        "session/opened",
        {},
        {
          kind: "session.status",
          payload: {
            status: "ready",
            model: formatModelSelector(this.#model, this.#reasoningEffort),
            permissionMode: this.#permissions.mode,
          },
        },
      ),
    )
  }

  get localSessionId(): string {
    return this.options.localSessionId
  }

  /** The harness session is the native session; there is no external provider thread. */
  get nativeSessionId(): string {
    return this.options.localSessionId
  }

  async send(input: UserInput): Promise<void> {
    this.#requireOpen()
    if (this.#turnReserved || this.#loop.isTurnActive) {
      throw new Error("A CodeSplash turn is already running")
    }
    // Reserve the turn before the first await: prompt building below does fs and git work, and a
    // second send arriving in that window must be refused here (to the caller) rather than crash
    // the live turn with a spurious non-recoverable error event.
    this.#turnReserved = true
    let turnStarted = false
    try {
      const provider = this.#providers[this.#model.provider]
      if (!provider) throw new Error(`No provider client for "${this.#model.provider}"`)
      const system = await this.#systemPromptFor()
      const userContent = await buildUserContent(input)
      this.#requireOpen()
      this.#turnPromise = this.#loop
        .runTurn({
          provider,
          model: this.#model,
          reasoningEffort: this.#reasoningEffort,
          system,
          userText: input.text,
          userContent,
        })
        .catch((error) => {
          this.#push(
            this.#factory.event(
              "loop/crash",
              {},
              {
                kind: "error",
                payload: {
                  message: error instanceof Error ? error.message : String(error),
                  recoverable: false,
                },
              },
            ),
          )
        })
        .then(() => this.#persistTurnTranscript())
        .finally(() => {
          this.#turnPromise = undefined
          this.#turnReserved = false
        })
      turnStarted = true
    } finally {
      if (!turnStarted) this.#turnReserved = false
    }
  }

  async resolveRequest(requestId: string, decision: EngineDecision): Promise<void> {
    this.#requireOpen()
    this.#loop.resolveRequest(requestId, decision.choice)
  }

  async interrupt(): Promise<void> {
    if (this.#closed) return
    this.#maintenanceAbort?.abort()
    this.#loop.interrupt()
  }

  async inspectContext() {
    this.#requireOpen()
    if (this.#turnReserved || this.#loop.isTurnActive)
      throw new Error("Wait for the current turn before inspecting context")
    this.#turnReserved = true
    try {
      const system = await this.#systemPromptFor()
      this.#requireOpen()
      return this.#loop.inspectContext(this.#model, system, this.#reasoningEffort)
    } finally {
      this.#turnReserved = false
    }
  }

  async compact(instructions = ""): Promise<void> {
    this.#requireOpen()
    if (this.#turnReserved || this.#loop.isTurnActive)
      throw new Error("Wait for the current turn before compacting")
    if (instructions.length > 4000) throw new Error("Compaction instructions must be at most 4000 characters")
    this.#turnReserved = true
    const abort = new AbortController()
    this.#maintenanceAbort = abort
    this.#turnPromise = (async () => {
      try {
        await this.#loop.compact(async () => {
          const system = await this.#systemPromptFor()
          this.#requireOpen()
          abort.signal.throwIfAborted()
          const provider = this.#providers[this.#model.provider]
          if (!provider) throw new Error("No provider available for compaction")
          return {
            provider,
            model: this.#model,
            system,
            reasoningEffort: this.#reasoningEffort,
            userText: "",
            userContent: [],
          }
        }, instructions)
      } finally {
        if (this.#loop.historyRevision !== this.#persistedRevision || this.#snapshotRequired)
          await this.#persistTurnTranscript(true)
        this.#turnReserved = false
        this.#maintenanceAbort = undefined
        this.#turnPromise = undefined
      }
    })()
    // close() may observe the promise too; this handler prevents a maintenance failure from
    // becoming an unhandled rejection when the UI has already closed.
    await this.#turnPromise
  }

  async editPermissionRule(command: string): Promise<void> {
    this.#requireOpen()
    if (this.#turnReserved || this.#loop.isTurnActive)
      throw new Error("Wait for the current turn before editing permission rules")
    // Reserve admission across disk I/O so send()/mode changes cannot race a policy edit.
    this.#turnReserved = true
    try {
      const updated = await editPermissionRule(parsePermissionEdit(command), {
        cwd: this.#cwd,
        trusted: this.options.workspaceTrusted ?? true,
        grantsPath: this.options.permissionGrantsPath,
      })
      if (updated) Object.assign(this.#config.permissions, updated)
      await this.#permissions.reload?.()
      this.#loop.clearApprovalCache()
      this.#systemPrompt = undefined
    } finally {
      this.#turnReserved = false
    }
  }
  permissionRules() {
    const rules = describePermissionRules(this.#permissions)
    return rules.map((rule) => ({ ...rule, conflict: ruleConflict(rule, rules) }))
  }
  sandboxStatus(): string {
    return this.#sandbox.status?.() ?? "Execution backend status unavailable"
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#maintenanceAbort?.abort()
    this.#loop.interrupt()
    await this.#turnPromise?.catch(() => {})
    await this.#sandbox.close()
    this.#ended = true
    this.#queue.end()
  }

  async listModels(): Promise<EngineModel[]> {
    this.#requireOpen()
    const sessionDefault = this.#providerRegistry.defaultModel()
    return this.#providerRegistry.models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      description: this.#describeModel(model),
      isDefault: model.id === sessionDefault.id && model.provider === sessionDefault.provider,
    }))
  }

  /** Accepts `<model-id>` or `<model-id>:<low|medium|high>`; applies to subsequent turns. */
  async setModel(model: string): Promise<void> {
    this.#requireOpen()
    if (this.#turnReserved || this.#loop.isTurnActive) {
      throw new Error("Wait for the current turn before switching models")
    }
    const selection = this.#selectModel(model)
    this.#model = selection.model
    this.#reasoningEffort = selection.effort
    this.#push(
      this.#factory.event(
        "client/modelSelected",
        {},
        {
          kind: "session.status",
          payload: { status: "ready", model: formatModelSelector(selection.model, selection.effort) },
        },
      ),
    )
  }

  /**
   * Switches the first-party permission mode for subsequent turns. Refused mid-turn (like
   * setModel); "bypass" is refused unless the session was OPENED in bypass mode — entering
   * bypass mid-session requires the launch flag, while leaving it (and returning) is fine.
   * A valid change goes through the runtime, whose onModeChange emits the status event.
   */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.#requireOpen()
    if (this.#turnReserved || this.#loop.isTurnActive) {
      throw new Error("Wait for the current turn before switching permission modes")
    }
    if (mode === "bypass" && !this.#bypassAllowed) {
      throw new Error("Bypass mode requires launching with --bypass-approvals")
    }
    this.#permissions.setMode(mode)
  }

  /**
   * Parses a selector against the registry (available providers only). A model that exists but
   * whose provider has no key gets an actionable message naming the key env var — never its value.
   */
  #selectModel(selector: string): ModelSelection {
    try {
      return this.#providerRegistry.parseSelector(selector)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Unknown model")) {
        const unavailable = this.#unavailableModelError(selector)
        if (unavailable) throw unavailable
      }
      throw error
    }
  }

  /** An error naming the missing key when the selector points at a known-but-keyless provider. */
  #unavailableModelError(selector: string): Error | undefined {
    const trimmed = selector.trim()
    const candidates = new Set([trimmed, trimmed.split(":")[0] ?? trimmed])
    for (const candidate of candidates) {
      const builtin = findModel(candidate)
      if (builtin) {
        return new Error(
          `The ${PROVIDER_DISPLAY_NAMES[builtin.protocol]} provider needs ${PROVIDER_KEY_VARIABLES[builtin.protocol]} set`,
        )
      }
      for (const custom of this.#config.providers) {
        if (custom.models.some((model) => model.id === candidate)) {
          return new Error(`The ${custom.displayName} provider needs ${custom.keyEnvVar} set`)
        }
      }
    }
    return undefined
  }

  #describeModel(model: ModelInfo): string {
    return [
      this.#providerRegistry.runtimeFor(model).displayName,
      `${Math.round(model.contextWindow / 1000)}k context`,
      model.supportsReasoning ? "reasoning" : undefined,
    ]
      .filter(Boolean)
      .join(" · ")
  }

  /**
   * Appends the messages the finished turn added to the native transcript. The loop tracks the
   * turn boundary itself (a fallback's thinking-strip can drop emptied pre-turn messages, so a
   * pre-turn length captured here would drift). Write failures degrade to one warning event per
   * session — a broken disk must never crash a live session.
   */
  async #persistTurnTranscript(forceSnapshot = false): Promise<void> {
    const path = this.options.nativeTranscriptPath
    if (!path) return
    const added = this.#loop.lastTurnMessages
    const snapshot =
      forceSnapshot || this.#snapshotRequired || this.#loop.historyRevision !== this.#persistedRevision
    if (!snapshot && added.length === 0) return
    try {
      if (snapshot) await writeTranscriptSnapshot(path, this.#loop.historySnapshot())
      else await appendTranscriptMessages(path, added)
      this.#persistedRevision = this.#loop.historyRevision
      this.#snapshotRequired = false
    } catch (error) {
      this.#snapshotRequired = true
      if (this.#transcriptWarned) return
      this.#transcriptWarned = true
      const message = error instanceof Error ? error.message : String(error)
      this.#push(
        this.#factory.event(
          "transcript/appendFailed",
          {},
          {
            kind: "warning",
            payload: { message: `Could not persist the session transcript: ${message}` },
          },
        ),
      )
    }
  }

  async #systemPromptFor(): Promise<string> {
    const permissionMode = this.#permissions.mode
    const workspaceTrusted = this.options.workspaceTrusted ?? true
    // Plan mode injects its own prompt section and untrusted folders skip project rules, so the
    // cache key covers mode and trust alongside the model (mode can flip between turns).
    const key = `${this.#model.id}\0${permissionMode}\0${workspaceTrusted}`
    if (this.#systemPrompt?.key === key) return this.#systemPrompt.text
    const text = await buildSystemPrompt({
      cwd: this.#cwd,
      model: this.#model,
      policy: this.#policy,
      toolNames: this.#registry.specs().map((spec) => spec.name),
      permissionMode,
      workspaceTrusted,
    })
    this.#systemPrompt = { key, text }
    return text
  }

  #push(event: AgentEvent): void {
    if (this.#ended) return
    this.#queue.push(event)
  }

  #requireOpen(): void {
    if (this.#closed) throw new Error("CodeSplash session is closed")
  }
}

/* -------------------------------------- helpers -------------------------------------- */

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

async function buildUserContent(input: UserInput): Promise<ContentBlock[]> {
  const content: ContentBlock[] = []
  if (input.text !== "") content.push({ type: "text", text: input.text })
  for (const image of input.images ?? []) {
    content.push(await readImageBlock(image))
  }
  if (content.length === 0) content.push({ type: "text", text: "" })
  return content
}

/** Local image paths become base64 ImageBlocks; data: URIs pass through decoded. */
async function readImageBlock(image: string): Promise<ImageBlock> {
  const dataUri = image.match(/^data:([^;,]+);base64,(.+)$/s)
  if (dataUri) {
    return { type: "image", mediaType: dataUri[1] ?? "image/png", base64Data: dataUri[2] ?? "" }
  }
  const file = Bun.file(image)
  if (!(await file.exists())) throw new Error(`Image not found: ${image}`)
  const bytes = await file.arrayBuffer()
  const mediaType = IMAGE_MEDIA_TYPES[extname(image).toLowerCase()] ?? "image/png"
  return { type: "image", mediaType, base64Data: Buffer.from(bytes).toString("base64") }
}
