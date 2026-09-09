/**
 * The first-party CodeSplash engine behind the EngineDriver/EngineSession contract. Sessions run
 * entirely in-process: provider adapters stream model responses and the loop executes tools.
 */
import { dirname, join, resolve } from "node:path"
import { configDirectory, dataDirectory } from "../../core/config.ts"
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
import { BranchStore, validNativeContext } from "../../core/session/branches.ts"
import { MemorySessionState } from "../../core/session/control.ts"
import { bytes, digest } from "../../core/session/files.ts"
import {
  attachmentIdentity,
  type InputAcknowledgment,
  type InputIntent,
  InputQueue,
} from "../../core/session/input-queue.ts"
import { projectPromptHistory } from "../../core/session/prompt-history.ts"
import { type InputCompletion, QueueRunner } from "../../core/session/queue-runner.ts"
import type { RecoveryRequest, RecoveryResult } from "../../core/session/recovery-contract.ts"
import { RoutedSession } from "../../core/session/routed-session.ts"
import {
  type DirectoryRequest,
  destinationDirectory,
  directoryScope,
  PreparedSessionState,
  workingDirectory,
} from "../../core/session/working-directory.ts"
import { projectIdFor } from "../../core/sessions.ts"
import { readTrustDecision } from "../../core/trust.ts"
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
import { estimateText } from "./context.ts"
import type {
  ChatMessage,
  ContentBlock,
  ModelInfo,
  PermissionRuntime,
  ProviderClient,
  ProviderId,
  ReasoningEffort,
} from "./contracts.ts"
import { createSkill as writeSkill } from "./inputs/authoring.ts"
import type { ContextToolRunner } from "./inputs/contracts.ts"
import { readAttachedImage } from "./inputs/images.ts"
import { contextReadTool, internalContextTools } from "./inputs/io.ts"
import { ContextInputs, skillTool } from "./inputs/session.ts"
import { fuzzyFiles, mentions } from "./inputs/syntax.ts"
import { CodesplashEventFactory, CodesplashLoop } from "./loop.ts"
import { embeddingTool } from "./memory/embedding.ts"
import { maintainMemory } from "./memory/maintenance.ts"
import { MemorySession } from "./memory/session.ts"
import { memoryGate, memoryTools } from "./memory/tools.ts"
import { editPermissionRule, parsePermissionEdit, ruleConflict } from "./permission-editor.ts"
import {
  createPermissionRuntime,
  describePermissionRules,
  type PermissionRuntimeOptions,
} from "./permissions.ts"
import { buildSystemPrompt } from "./prompt.ts"
import { NativeRecovery } from "./recovery.ts"
import type { SandboxRuntime } from "./sandbox/contracts.ts"
import { contains, createProfile, physicalPath, pinProfile } from "./sandbox/profile.ts"
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
    options = { ...options, sessionState: options.sessionState ?? new MemorySessionState() }
    const state = options.sessionState as import("../../core/session/control.ts").SessionStateAccess
    const location = workingDirectory(state.read().state)
    let history: ChatMessage[] | undefined
    if (location) {
      const cwd = destinationDirectory(location.current, ".")
      if (cwd !== location.current)
        throw new Error("Working directory moved; inspect its transition record before resuming")
      options = {
        ...options,
        cwd,
        workspaceTrusted: (await readTrustDecision(cwd, options.trustDataDirectory))?.trusted === true,
        permissionOverrides: options.cwd === cwd ? options.permissionOverrides : undefined,
        permissionGrantsPath: options.cwd === cwd ? options.permissionGrantsPath : undefined,
      }
      if (location.pending) {
        history = new BranchStore(state).context(location.node)
        if (options.nativeTranscriptPath) await writeTranscriptSnapshot(options.nativeTranscriptPath, history)
        state.update(state.read().revision, "directory/recover", (value) => {
          const record = workingDirectory(value)
          if (record) record.pending = false
        })
      }
    }
    const session = await this.#openNative(options, history)
    const routed = new RoutedSession(session)
    const attach = (runtime: CodesplashSession) => {
      runtime.changeDirectory = async (request) => {
        routed.begin()
        let next: CodesplashSession | undefined
        try {
          const result = await runtime.withIdle(async () => {
            runtime.assertRecoveryReady()
            const state = runtime.options
              .sessionState as import("../../core/session/control.ts").SessionStateAccess
            const from = runtime.options.cwd,
              cwd = destinationDirectory(from, request.path)
            const trusted =
              (await readTrustDecision(cwd, runtime.options.trustDataDirectory))?.trusted === true
            const revision = digest(JSON.stringify([state.read().revision, cwd, trusted]))
            const preview = {
              from,
              cwd,
              trusted,
              revision,
              context: request.context,
              applied: false,
              pending: runtime.inputQueue
                .snapshot()
                .items.filter((item) => ["queued", "blocked", "execution-uncertain"].includes(item.status))
                .length,
            }
            if (!request.apply) return preview
            if (request.revision !== revision) throw new Error("Directory preview is stale; review it again")
            if (request.context !== "carry" && request.context !== "clear")
              throw new Error("Choose --carry or --clear before applying a directory change")
            if (cwd === from) throw new Error("Already in this working directory")
            const history = request.context === "carry" ? runtime.historyForDirectory() : []
            if (!validNativeContext(history))
              throw new Error(
                "Current exchange is incomplete; choose clear context or recover it before changing directory",
              )
            await runtime.options.flushSessionEvents?.()
            const prepared = new PreparedSessionState(state),
              prior = workingDirectory(prepared.read().state)
            const scope = digest(cwd)
            prepared.update(prepared.read().revision, "directory/prepare-location", (value) => {
              value.values.workingDirectory = {
                version: 1,
                original: prior?.original ?? from,
                from,
                current: cwd,
                projectId: projectIdFor(cwd),
                scope,
                context: request.context,
                node: crypto.randomUUID(),
                pending: true,
              }
            })
            const promptHistory = state.directory
              ? await projectPromptHistory(dirname(dirname(state.directory)), projectIdFor(cwd), "codesplash")
              : undefined
            next = await this.#openNative(
              {
                ...runtime.options,
                cwd,
                sessionState: prepared,
                promptHistory,
                initialUsage: runtime.usageForDirectory(),
                firstSequence: runtime.nextSequenceForDirectory(),
                model: runtime.modelForDirectory(),
                workspaceTrusted: trusted,
                permissionOverrides: undefined,
                permissionGrantsPath: undefined,
                policy: {
                  ...(runtime.options.policy ?? defaultSessionPolicy),
                  permissionMode: runtime.directoryPermissionMode(),
                },
                resumeQueuedInput: false,
              },
              history,
              true,
            )
            next.prepareDirectoryBoundary(runtime, request.context)
            await next.initializeRecovery()
            // Trust and physical identity are admission inputs, not facts captured indefinitely by preview.
            if (
              destinationDirectory(from, request.path) !== cwd ||
              ((await readTrustDecision(cwd, runtime.options.trustDataDirectory))?.trusted === true) !==
                trusted
            )
              throw new Error("Destination or trust changed during preparation; preview again")
            prepared.publish()
            return { ...preview, applied: true }
          })
          if (next) {
            const replacement = next
            next = undefined
            attach(replacement)
            await routed.replace(replacement)
            await replacement.finishDirectoryPublication()
          }
          return result
        } finally {
          if (next) await next.close()
          routed.end()
        }
      }
    }
    attach(session)
    return routed.session
  }

  async #openNative(
    options: OpenSessionOptions,
    history?: ChatMessage[],
    prepared = false,
  ): Promise<CodesplashSession> {
    const config = await this.#config()
    options = { ...options, model: options.model ?? config.models?.codesplash }
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
    const seededHistory =
      history ?? (options.nativeTranscriptPath ? await loadTranscript(options.nativeTranscriptPath) : [])
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
    const scope = options.sessionState ? directoryScope(options.sessionState.read().state) : undefined
    const profilePath = directory
      ? scope
        ? join(directory, "cwd-profiles", `${scope}.json`)
        : join(directory, "sandbox-profile.json")
      : undefined
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
              options.sessionState?.directory ? [dirname(dirname(options.sessionState.directory))] : [],
            ),
            profilePath,
          ),
          directory ? join(directory, "sandbox-events.jsonl") : undefined,
        )
    const session = new CodesplashSession(
      options,
      config,
      registry,
      providers,
      seededHistory,
      permissions,
      bridge,
      sandbox,
    )
    try {
      if (!prepared) await session.initializeRecovery()
      return session
    } catch (error) {
      await session.close()
      throw error
    }
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
  changeDirectory?: (
    request: DirectoryRequest,
  ) => Promise<import("../../core/session/working-directory.ts").DirectoryPreview>
  readonly capabilities = CODESPLASH_CAPABILITIES
  readonly events: AsyncIterable<AgentEvent>
  readonly #queue = new AsyncQueue<AgentEvent>()
  readonly #factory: CodesplashEventFactory
  readonly #loop: CodesplashLoop
  readonly #memory: MemorySession
  #memoryText = ""
  #memoryEpoch = 0
  #learningTimer: ReturnType<typeof setTimeout> | undefined
  #learningAbort: AbortController | undefined
  #learningPromise: Promise<void> | undefined
  #lastTurnSucceeded = false
  readonly #inputs: ContextInputs
  #inputPromise: Promise<unknown> | undefined
  #contextSuffix = ""
  #inputSuffix = ""
  #personality: "neutral" | "concise" | "explanatory"
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
  readonly inputQueue: InputQueue
  #turnEventStart = 0
  readonly #recovery: NativeRecovery
  readonly #inputRunner: QueueRunner
  readonly #steering = new Set<string>()
  #lastInputCompletion: InputCompletion = "completed"
  #admissionAbort: AbortController | undefined
  #admissionSettled: Promise<void> | undefined
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
    const state = options.sessionState ?? new MemorySessionState()
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
    const userRoot = resolve(configDirectory(), "context")
    this.#inputs = new ContextInputs(
      options.cwd,
      userRoot,
      options.workspaceTrusted ?? true,
      config.context,
      sandbox.sanitize?.bind(sandbox),
    )
    this.#memory = new MemorySession({
      root: physicalPath(join(dataDirectory(), "memory")),
      cwd: this.#cwd,
      session: options.localSessionId,
      history: !!options.nativeTranscriptPath,
      trusted: options.workspaceTrusted ?? true,
      config: config.memory,
      permissions,
      sanitize: sandbox.sanitize?.bind(sandbox) ?? ((text) => text),
      writable: () => sandbox.profile.mode === "workspace-write" && permissions.mode !== "plan",
    })
    this.#personality = config.context?.personality ?? "neutral"
    this.#registry = createToolRegistry([
      ...builtinTools(),
      ...internalContextTools(),
      contextReadTool(userRoot),
      skillTool,
      ...memoryTools(this.#memory, () => this.#loop.historySnapshot(), options.nativeTranscriptPath),
      memoryGate("memory_access", "memory_search"),
      memoryGate("memory_history_access", "history_read"),
      memoryGate("memory_access_read", "memory_read"),
      memoryGate("memory_change", "memory_write", true),
      embeddingTool(config.memory?.embedding, (tokens, cost) =>
        this.#loop.recordEmbeddingUsage(tokens, cost),
      ),
    ])
    this.#loop = new CodesplashLoop({
      cwd: options.cwd,
      onContextBoundary: (kind, messages) => this.#recovery.capture(kind, kind, messages),
      beforeMutation: async (label, signal) => {
        try {
          return await this.#recovery.checkpoints.begin(label, signal)
        } catch (error) {
          this.#loop.interrupt()
          throw error
        }
      },
      afterMutation: async (id) => {
        try {
          await this.#recovery.checkpoints.end(id)
        } catch (error) {
          this.#loop.interrupt()
          throw error
        }
      },
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
    this.inputQueue = new InputQueue({
      state,
      ...options.promptHistory,
      cwd: options.cwd,
      sanitize: sandbox.sanitize?.bind(sandbox),
      mentions,
    })
    this.#recovery = new NativeRecovery(
      state,
      {
        cwd: this.#cwd,
        scope: directoryScope(state.read().state),
        trusted: () => options.workspaceTrusted ?? true,
        writable: () => sandbox.profile.mode === "workspace-write" && permissions.mode !== "plan",
        readable: (path) =>
          contains(this.#cwd, path) &&
          !sandbox.profile.deniedReadPaths.some((root) => contains(root, path)) &&
          !["deny", "ask"].includes(permissions.decide("read_file", { paths: [path] }, true).kind),
        writablePath: (path) =>
          contains(this.#cwd, path) &&
          !sandbox.profile.protectedPaths.some((root) => contains(root, path)) &&
          !["deny", "ask"].includes(permissions.decide("write_file", { paths: [path] }, false).kind),
        protectedPaths: sandbox.profile.protectedPaths,
        sanitize: sandbox.sanitize?.bind(sandbox) ?? ((text) => text),
      },
      {
        history: () => this.#loop.historySnapshot(),
        replace: (messages) => {
          this.#loop.selectHistory(messages)
          this.#persistedRevision = this.#loop.historyRevision
        },
        usage: () => this.#loop.usageSnapshot(),
        notes: () => Object.fromEntries(this.#memory.notes),
        selectNotes: (notes) => this.#memory.selectBranchNotes(notes),
        sequence: () => this.#factory.nextSequence - 1,
        startSequence: () => this.#turnEventStart,
        reset: () => {
          this.#loop.clearApprovalCache()
          this.#sandbox.resetGrants?.()
          this.#inputs.catalog = { resources: [], diagnostics: [] }
          this.#memory.invalidate()
          this.#contextSuffix = ""
          this.#inputSuffix = ""
          this.#memoryText = ""
          this.#systemPrompt = undefined
          this.#lastTurnSucceeded = false
        },
        pause: () => {
          this.inputQueue.pause()
        },
        flush: () => options.flushSessionEvents?.() ?? Promise.resolve(),
        transcript: options.nativeTranscriptPath,
        notice: (text) => this.#memoryNotice(text),
      },
    )
    if (options.resumeQueuedInput === false) this.inputQueue.pause()
    this.#inputRunner = new QueueRunner(
      this.inputQueue,
      {
        busy: () => this.#turnReserved || this.#loop.isTurnActive,
        run: async (input, item) => {
          await this.#send(input, item.id)
          await this.#turnPromise
          return this.#lastInputCompletion
        },
        interrupt: () => this.#interruptAndSettle(),
      },
      (error) =>
        this.#push(
          this.#factory.event(
            "input/error",
            {},
            { kind: "warning", payload: { message: `Input queue stopped: ${error.message}` } },
          ),
        ),
    )

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
    this.#memory.invalidate()
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
  async initializeRecovery(): Promise<void> {
    await this.#recovery.initialize()
    this.#inputRunner.wake()
  }
  directoryStatus() {
    return { cwd: this.#cwd, trusted: this.options.workspaceTrusted ?? true }
  }
  withIdle<T>(operation: () => Promise<T>) {
    return this.#inputOperation(operation)
  }
  assertRecoveryReady() {
    this.#recovery.assertReady()
  }
  historyForDirectory() {
    return this.#loop.historySnapshot()
  }
  usageForDirectory() {
    return this.#loop.usageSnapshot()
  }
  nextSequenceForDirectory() {
    return this.#factory.nextSequence
  }
  modelForDirectory() {
    return formatModelSelector(this.#model, this.#reasoningEffort)
  }
  directoryPermissionMode() {
    return this.#permissions.mode === "plan" ? ("plan" as const) : ("default" as const)
  }
  prepareDirectoryBoundary(previous: CodesplashSession, context: "carry" | "clear") {
    this.#recovery.branches.copyEphemeralAssets(previous.#recovery.branches)
    this.inputQueue.holdForDirectoryChange()
    this.#memory.selectBranchNotes({})
    const node = this.#recovery.capture("base", `Working directory changed (${context} context)`)
    if (!node) throw new Error("Could not retain directory transition context")
    const state = this.options.sessionState as import("../../core/session/control.ts").SessionStateAccess
    state.update(state.read().revision, "directory/prepared-boundary", (value) => {
      const location = workingDirectory(value)
      if (!location) throw new Error("Missing prepared working directory")
      location.node = node.id
    })
  }
  async finishDirectoryPublication() {
    const state = this.options.sessionState as import("../../core/session/control.ts").SessionStateAccess
    if (this.options.nativeTranscriptPath)
      await writeTranscriptSnapshot(this.options.nativeTranscriptPath, this.#loop.historySnapshot())
    state.update(state.read().revision, "directory/complete", (value) => {
      const location = workingDirectory(value)
      if (location) location.pending = false
    })
    this.#memoryNotice(`Working directory: ${this.#cwd}. Queue paused; edit retained inputs before resuming.`)
  }

  get localSessionId(): string {
    return this.options.localSessionId
  }

  /** The harness session is the native session; there is no external provider thread. */
  get nativeSessionId(): string {
    return this.options.localSessionId
  }

  async submit(
    input: UserInput,
    intent: InputIntent = "follow-up",
    submissionId?: string,
  ): Promise<InputAcknowledgment> {
    this.#requireOpen()
    if (this.#inputRunner.failure) throw this.#inputRunner.failure
    return this.inputQueue.submit(input, intent, submissionId)
  }
  async send(input: UserInput): Promise<void> {
    return this.#send(input)
  }
  async #send(input: UserInput, queuedId?: string): Promise<void> {
    this.#requireOpen()
    if (this.#inputRunner.failure) throw this.#inputRunner.failure
    this.#recovery.assertReady()
    if (this.#turnReserved || this.#loop.isTurnActive) {
      throw new Error("A CodeSplash turn is already running")
    }
    // Reserve the turn before the first await: prompt building below does fs and git work, and a
    // second send arriving in that window must be refused here (to the caller) rather than crash
    // the live turn with a spurious non-recoverable error event.
    this.#turnReserved = true
    let turnStarted = false
    let ownedId: string | undefined
    let settleAdmission!: () => void
    this.#admissionSettled = new Promise<void>((resolve) => {
      settleAdmission = resolve
    })
    const admissionAbort = new AbortController()
    this.#admissionAbort = admissionAbort
    try {
      if (!queuedId) {
        ownedId = this.inputQueue.submit(input).id
        this.inputQueue.admit(ownedId, true)
        this.inputQueue.running(ownedId)
      }
      const inputId = queuedId ?? ownedId
      this.#lastInputCompletion = "completed"
      await this.#cancelLearning()
      this.#requireOpen()
      const provider = this.#providers[this.#model.provider]
      if (!provider) throw new Error(`No provider client for "${this.#model.provider}"`)
      const system = await this.#systemPromptFor()
      admissionAbort.signal.throwIfAborted()
      const userContent: ContentBlock[] = input.text ? [{ type: "text", text: input.text }] : []
      this.#requireOpen()
      this.#turnEventStart = this.#factory.nextSequence
      this.#turnPromise = this.#loop
        .runTurn({
          provider,
          model: this.#model,
          reasoningEffort: this.#reasoningEffort,
          system,
          userText: input.text,
          userMessageId: inputId,
          userContent,
          hasSteering: () => Boolean(this.inputQueue.next("steering")),
          takeSteering: async () => {
            const item = this.inputQueue.next("steering")
            if (!item) return undefined
            let next: UserInput
            try {
              next = this.inputQueue.admit(item.id, false, "within-turn")
              this.inputQueue.running(item.id)
            } catch (error) {
              this.inputQueue.finish(
                item.id,
                "blocked",
                error instanceof Error ? error.message : String(error),
              )
              this.inputQueue.pause()
              return undefined
            }
            this.#steering.add(item.id)
            return {
              id: item.id,
              userText: next.text,
              userContent: next.text ? [{ type: "text" as const, text: next.text }] : [],
              system: await this.#systemPromptFor(),
              prepare: (run: ContextToolRunner, signal: AbortSignal) =>
                this.#prepareInput(next, run, signal, item.id),
            }
          },
          prepare: (run, signal) => this.#prepareInput(input, run, signal, inputId),
          invokeSkill: async (value, run) => {
            if (!value || typeof value !== "object" || !("name" in value) || typeof value.name !== "string")
              throw new Error("skill requires a name")
            const args = "arguments" in value ? value.arguments : ""
            if (typeof args !== "string") throw new Error("skill arguments must be a string")
            return this.#inputs.invoke(value.name, args, run, true)
          },
        })
        .catch((error) => {
          this.#lastInputCompletion = "failed"
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
        .then(() => {
          if (
            this.#snapshotRequired &&
            this.options.nativeTranscriptPath &&
            this.options.sessionState?.durable
          )
            throw new Error("Native transcript persistence failed; inspect the last turn before retrying")
          this.#recovery.capture("turn", input.text.slice(0, 80) || "Attachment input", undefined, inputId)
          for (const id of this.#steering) this.inputQueue.finish(id, this.#lastInputCompletion)
          this.#steering.clear()
          if (ownedId) this.inputQueue.finish(ownedId, this.#lastInputCompletion)
          if (this.#lastInputCompletion === "failed") this.inputQueue.pause()
        })
        .finally(() => {
          this.#turnPromise = undefined
          this.#turnReserved = false
          this.#scheduleLearning()
          this.#inputRunner.wake()
        })
      void this.#turnPromise.catch((error) => {
        try {
          for (const id of [...this.#steering, ...(inputId ? [inputId] : [])])
            this.inputQueue.finish(
              id,
              "execution-uncertain",
              "Turn completion could not be persisted; inspect effects before retrying",
            )
          this.#steering.clear()
          this.inputQueue.pause()
        } catch {
          /* The last durable admitted state remains recoverably uncertain. */
        }
        this.#inputRunner.halt(error)
      })
      turnStarted = true
    } catch (error) {
      if (ownedId)
        this.inputQueue.finish(
          ownedId,
          admissionAbort.signal.aborted ? "cancelled" : "blocked",
          error instanceof Error ? error.message : String(error),
        )
      this.inputQueue.pause()
      throw error
    } finally {
      if (!turnStarted) this.#turnReserved = false
      this.#admissionAbort = undefined
      this.#admissionSettled = undefined
      settleAdmission()
      this.#inputRunner.wake()
    }
  }

  async exportHistory(options: import("../../core/session/portable.ts").ExportOptions) {
    return this.#inputOperation(async () => {
      await this.options.flushSessionEvents?.()
      const { exportPortable } = await import("../../core/session/portable.ts")
      const now = new Date().toISOString()
      return exportPortable(
        this.#recovery.branches,
        {
          engine: "codesplash",
          schemaVersion: 2,
          localSessionId: this.localSessionId,
          projectId: "live",
          projectPath: this.#cwd,
          title: "CodeSplash session",
          createdAt: now,
          updatedAt: now,
          lastStatus: "ready",
          lastSequence: this.#factory.nextSequence - 1,
        },
        options,
      )
    })
  }

  async sessionRecovery(request: RecoveryRequest): Promise<RecoveryResult> {
    this.#requireOpen()
    if (request.action === "tree") return { title: "Session branches", data: this.#recovery.branches.view() }
    if (request.action === "checkpoints")
      return { title: "File checkpoints", data: this.#recovery.checkpoints.view() }
    return this.#inputOperation(async () => {
      this.inputQueue.pause()
      return this.#recovery.execute(request)
    })
  }

  async resolveRequest(requestId: string, decision: EngineDecision): Promise<void> {
    this.#requireOpen()
    this.#loop.resolveRequest(requestId, decision.choice)
  }

  async interrupt(): Promise<void> {
    if (this.#closed) return
    this.inputQueue.pause()
    await this.#interruptAndSettle()
  }
  async #interruptAndSettle(): Promise<void> {
    this.#admissionAbort?.abort(new Error("Input interrupted before provider admission"))
    this.#learningAbort?.abort()
    if (this.#learningTimer) {
      clearTimeout(this.#learningTimer)
      this.#learningTimer = undefined
    }
    this.#maintenanceAbort?.abort()
    this.#loop.interrupt()
    await this.#admissionSettled
    await this.#turnPromise?.catch(() => {})
    await this.#inputPromise?.catch(() => {})
  }
  async #prepareInput(input: UserInput, run: ContextToolRunner, signal: AbortSignal, inputId?: string) {
    this.#contextSuffix = ""
    const references = inputId ? this.inputQueue.references(inputId) : []
    const checkedRun: ContextToolRunner = async (name, args) => {
      const params = args as { root?: unknown; path?: unknown }
      const path =
        name === "context_read" && typeof params?.root === "string" && typeof params.path === "string"
          ? resolve(params.root, params.path)
          : undefined
      const ref = references.find((value) => value.kind === "file" && value.source === path)
      if (ref && attachmentIdentity(ref.source)?.fingerprint !== ref.fingerprint)
        throw new Error("Queued file changed before context preparation; reattach it")
      const result = await run(name, args)
      if (ref && !result.isError && inputId) {
        signal.throwIfAborted()
        if (attachmentIdentity(ref.source)?.fingerprint !== ref.fingerprint)
          throw new Error("Queued file changed during context preparation; reattach it")
        const content = bytes(ref.source, 1024 * 1024)
        if (attachmentIdentity(ref.source)?.fingerprint !== ref.fingerprint)
          throw new Error("Queued file changed during its authorized read")
        this.inputQueue.recordAttachmentHash(inputId, ref.source, digest(content))
      }
      return result
    }
    const prepared = await this.#inputs.prepare(input, checkedRun, signal)
    for (const image of input.images ?? []) {
      const value = await readAttachedImage(
        image,
        this.#cwd,
        run,
        signal,
        inputId ? this.inputQueue.references(inputId) : [],
      )
      prepared.content.push(value.block)
      if (inputId) this.inputQueue.recordAttachmentHash(inputId, value.source, value.hash)
    }
    this.#inputSuffix = prepared.suffix
    if (this.#memory.available) {
      const permission = await run("memory_access", {})
      if (permission.isError) throw new Error(permission.text)
      if (this.#memoryEpoch !== this.#loop.historyRevision) {
        this.#memory.invalidate()
        this.#memoryEpoch = this.#loop.historyRevision
      }
      this.#memoryText = await this.#memory.prepare(input.text, signal, run)
      if (this.#memory.lastSearch.reason)
        this.#memoryNotice(
          `Memory retrieval: ${this.#memory.lastSearch.mode}: ${this.#memory.lastSearch.reason}`,
        )
      prepared.suffix = [prepared.suffix, this.#memoryText].filter(Boolean).join("\n\n")
    }
    for (const ref of references)
      if (
        (ref.kind === "file" || ref.kind === "image") &&
        attachmentIdentity(ref.source)?.fingerprint !== ref.fingerprint
      )
        throw new Error("Queued attachment changed before provider admission; reattach it")
    this.#contextSuffix = prepared.suffix
    return prepared
  }

  async #inputOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.#requireOpen()
    if (this.#turnReserved || this.#loop.isTurnActive) throw new Error("Wait for the current turn")
    this.#turnReserved = true
    const promise = (async () => {
      await this.#cancelLearning()
      this.#requireOpen()
      return operation()
    })()
    this.#inputPromise = promise
    try {
      return await promise
    } finally {
      this.#turnReserved = false
      this.#inputPromise = undefined
      this.#inputRunner.wake()
    }
  }

  async contextResources(kind: "skill" | "command") {
    return this.#inputOperation(() =>
      this.#loop.withContextTools(async (run, signal) => {
        const catalog = await this.#inputs.discover(run, signal)
        return catalog.resources
          .filter((r) => r.kind === kind)
          .map((r) => ({
            ...r,
            description: `${r.description}${r.disabled ? " [user invocation only]" : ""}${r.fork ? " [requires M7]" : ""}`,
          }))
      }),
    )
  }

  async completeFileMention(query: string) {
    return this.#inputOperation(() =>
      this.#loop.withContextTools(async (run) => {
        const result = await run("context_files", { root: this.#cwd })
        if (result.isError) throw new Error(result.text)
        const paths: unknown = JSON.parse(result.text)
        if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string"))
          throw new Error("Invalid filename index")
        return fuzzyFiles(query, paths)
      }),
    )
  }

  async setPersonality(personality: string): Promise<void> {
    await this.#inputOperation(async () => {
      if (personality !== "neutral" && personality !== "concise" && personality !== "explanatory")
        throw new Error("Use neutral, concise or explanatory")
      this.#personality = personality
      this.#systemPrompt = undefined
    })
  }

  async createSkill(name: string, write = false): Promise<string> {
    return this.#inputOperation(async () => {
      if (
        write &&
        (!(this.options.workspaceTrusted ?? true) ||
          this.#sandbox.profile.mode !== "workspace-write" ||
          this.#permissions.mode === "plan")
      )
        throw new Error(
          "Creating a skill requires a trusted workspace in workspace-write mode outside plan mode",
        )
      return writeSkill(this.#cwd, name, write)
    })
  }

  async inspectContext() {
    this.#requireOpen()
    if (this.#turnReserved || this.#loop.isTurnActive)
      throw new Error("Wait for the current turn before inspecting context")
    this.#turnReserved = true
    try {
      await this.#cancelLearning()
      this.#requireOpen()
      const system = [await this.#systemPromptFor(), this.#contextSuffix].filter(Boolean).join("\n\n")
      this.#requireOpen()
      return {
        ...this.#loop.inspectContext(this.#model, system, this.#reasoningEffort),
        ...(this.#memory.available
          ? { memoryTokens: estimateText(this.#memoryText), memoryMode: this.#memory.lastSearch.mode }
          : {}),
      }
    } finally {
      this.#turnReserved = false
      this.#inputRunner.wake()
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
    this.#turnEventStart = this.#factory.nextSequence
    this.#turnPromise = (async () => {
      try {
        await this.#cancelLearning()
        this.#requireOpen()
        abort.signal.throwIfAborted()
        await this.#loop.compact(async () => {
          const system = [await this.#systemPromptFor(), this.#contextSuffix].filter(Boolean).join("\n\n")
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
        this.#inputRunner.wake()
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
      await this.#cancelLearning()
      this.#requireOpen()
      const updated = await editPermissionRule(parsePermissionEdit(command), {
        cwd: this.#cwd,
        trusted: this.options.workspaceTrusted ?? true,
        grantsPath: this.options.permissionGrantsPath,
      })
      if (updated) Object.assign(this.#config.permissions, updated)
      await this.#permissions.reload?.()
      this.#contextSuffix = ""
      this.#inputs.catalog = { resources: [], diagnostics: [] }
      this.#memory.invalidate()
      this.#memoryText = ""
      this.#loop.clearApprovalCache()
      this.#systemPrompt = undefined
    } finally {
      this.#turnReserved = false
      this.#inputRunner.wake()
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
    this.#inputRunner.stop()
    this.#admissionAbort?.abort(new Error("Session closed"))
    this.#learningAbort?.abort()
    if (this.#learningTimer) {
      clearTimeout(this.#learningTimer)
      this.#learningTimer = undefined
    }
    this.#maintenanceAbort?.abort()
    this.#loop.interrupt()
    await this.#admissionSettled?.catch(() => {})
    await this.#turnPromise?.catch(() => {})
    await this.#inputPromise?.catch(() => {})
    await this.#cancelLearning()
    await this.#inputRunner.settled()
    try {
      await this.#sandbox.close()
    } finally {
      this.#ended = true
      this.#queue.end()
    }
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
    await this.#inputOperation(async () => {
      const selection = this.#selectModel(model)
      this.#memory.invalidate()
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
      this.#memoryText = ""
      this.#contextSuffix = this.#inputSuffix
    })
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
    await this.#inputOperation(async () => {
      this.#memory.invalidate()
      this.#memoryText = ""
      this.#permissions.setMode(mode)
      this.#contextSuffix = ""
      this.#inputs.catalog = { resources: [], diagnostics: [] }
    })
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
    const key = `${this.#model.id}\0${permissionMode}\0${workspaceTrusted}\0${this.#personality}`
    if (this.#systemPrompt?.key === key) return this.#systemPrompt.text
    const text = await buildSystemPrompt({
      cwd: this.#cwd,
      model: this.#model,
      policy: this.#policy,
      toolNames: this.#registry.specs().map((spec) => spec.name),
      permissionMode,
      workspaceTrusted,
      rules: [],
      personality: this.#personality,
    })
    this.#systemPrompt = { key, text }
    return text
  }

  async memoryCommand(command: string): Promise<string> {
    return this.#inputOperation(() =>
      this.#loop.withContextTools(async (run, signal) => {
        const action = command.trim().split(/\s+/)[0] || "list"
        if (action === "status" && !this.#memory.available)
          return "Durable memory is disabled for this untrusted, no-history or disabled session."
        const write =
          ["remember", "edit", "forget", "accept", "repair", "index", "extract", "consolidate"].includes(
            action,
          ) ||
          (action === "link" && command.includes("--apply"))
        const result = await run(
          write ? "memory_change" : action === "show" ? "memory_access_read" : "memory_access",
          {},
        )
        if (result.isError) throw new Error(result.text)
        if (action === "extract" || action === "consolidate") {
          const recovered = await run("memory_history_access", {})
          if (recovered.isError) throw new Error(recovered.text)
          return this.#maintain(action, signal)
        }
        const output = await this.#memory.command(command, signal, run)
        if (write || action === "refresh") {
          this.#memoryText = ""
          this.#contextSuffix = this.#inputSuffix
        }
        return output
      }),
    )
  }
  async #maintain(action: "extract" | "consolidate", signal: AbortSignal): Promise<string> {
    const model = this.#model,
      provider = this.#providers[model.provider]
    if (!provider) throw new Error("No provider for memory maintenance")
    return maintainMemory({
      memory: this.#memory,
      messages: this.#loop.historySnapshot(),
      model,
      provider,
      signal,
      action,
      onUsage: (usage) => this.#loop.recordAuxiliaryUsage(usage, model),
    })
  }
  #memoryNotice(message: string): void {
    this.#push(
      this.#factory.event(
        "memory/status",
        {},
        { kind: "warning", payload: { message: this.#sandbox.sanitize?.(message) ?? message } },
      ),
    )
  }
  #scheduleLearning(): void {
    if (
      this.#closed ||
      this.#inputRunner.failure ||
      this.inputQueue.next() ||
      !this.#lastTurnSucceeded ||
      !this.#config.memory?.autoLearn ||
      !this.#memory.available ||
      !this.#memory.options.writable() ||
      this.#learningPromise
    )
      return
    if (
      ["memory_search", "memory_write", "history_read"].some((name) =>
        ["deny", "ask"].includes(this.#permissions.decide(name, undefined, name !== "memory_write").kind),
      )
    )
      return
    this.#learningTimer = setTimeout(() => {
      this.#learningTimer = undefined
      if (this.#closed || this.#turnReserved || this.#loop.isTurnActive) return
      const abort = new AbortController()
      this.#learningAbort = abort
      this.#learningPromise = (async () => {
        const timer = setTimeout(
          () => abort.abort(new Error("Automatic memory maintenance reached its 60-second limit")),
          60000,
        )
        try {
          const extracted = await this.#maintain("extract", abort.signal)
          this.#memoryNotice(extracted)
          if (/^[1-9][0-9]* memory candidates saved/.test(extracted)) {
            const snapshot = (await this.#memory.store(abort.signal))?.snapshot()
            if ((snapshot?.records.filter((r) => r.kind === "candidate").length ?? 0) > 1)
              this.#memoryNotice(await this.#maintain("consolidate", abort.signal))
          }
        } finally {
          clearTimeout(timer)
        }
      })()
        .catch((error) => {
          if (!abort.signal.aborted)
            this.#memoryNotice(
              `Memory learning stopped: ${error instanceof Error ? error.message : String(error)}`,
            )
        })
        .finally(() => {
          this.#learningAbort = undefined
          this.#learningPromise = undefined
        })
    }, 100)
  }
  async #cancelLearning(): Promise<void> {
    if (this.#learningTimer) {
      clearTimeout(this.#learningTimer)
      this.#learningTimer = undefined
    }
    this.#learningAbort?.abort(new Error("Foreground work or shutdown interrupted memory learning"))
    await this.#learningPromise
  }

  #push(event: AgentEvent): void {
    if (event.kind === "turn.completed") {
      this.#lastTurnSucceeded = event.payload.status === "completed"
      this.#lastInputCompletion = event.payload.status === "interrupted" ? "cancelled" : event.payload.status
    }
    if (this.#ended) return
    this.#queue.push(event)
  }

  #requireOpen(): void {
    if (this.#closed) throw new Error("CodeSplash session is closed")
  }
}
