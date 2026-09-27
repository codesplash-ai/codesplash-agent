/**
 * The first-party CodeSplash engine behind the EngineDriver/EngineSession contract. Sessions run
 * entirely in-process: provider adapters stream model responses and the loop executes tools.
 */
import { dirname, join, resolve } from "node:path"
import { assertManagedMode, assertManagedPolicy } from "../../core/config/policy.ts"
import { resolveConfigForWorkspace } from "../../core/config/resolver.ts"
import { stableValue } from "../../core/config/source.ts"
import { configDirectory, dataDirectory } from "../../core/config.ts"
import { Diagnostics, diagnosticContext } from "../../core/diagnostics.ts"
import { featureAnnouncements, resolveFeatures } from "../../core/features.ts"
import { type HookEventName, type HookFields, hookIsGate } from "../../core/hooks.ts"
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
import {
  AutomationJournal,
  type GoalRequest,
  type WorkflowRequest,
} from "../../core/orchestration/automation.ts"
import type { TaskRequest } from "../../core/orchestration/contracts.ts"
import type { ScheduleRequest } from "../../core/orchestration/scheduler.ts"
import { coordinatorTools, type TeamRequest } from "../../core/orchestration/teams.ts"
import { WorktreeStore } from "../../core/orchestration/worktrees.ts"
import { BranchStore, validNativeContext } from "../../core/session/branches.ts"
import { MemorySessionState } from "../../core/session/control.ts"
import { bytes, digest } from "../../core/session/files.ts"
import {
  attachmentIdentity,
  type InputAcknowledgment,
  type InputIntent,
  InputQueue,
} from "../../core/session/input-queue.ts"
import { OwnedMaintenance } from "../../core/session/maintenance.ts"
import {
  type PresentationRequest,
  renameSession,
  sessionInfo,
  titleText,
  titleToken,
} from "../../core/session/presentation.ts"
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
import { hydrateKeyringCredentials, PROVIDER_ENV_VARS, resolveApiKey } from "./auth.ts"
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
import {
  advancedFeatures,
  DollarBudget,
  type DollarState,
  selectedRegistry,
  validateLimits,
} from "./execution.ts"
import { type ExtensionHost, ExtensionRuntime } from "./extensions/runtime.ts"
import { HookManager } from "./hooks/manager.ts"
import { hookTrusted, reviewHook } from "./hooks/trust.ts"
import { createSkill as writeSkill } from "./inputs/authoring.ts"
import type { ContextToolRunner } from "./inputs/contracts.ts"
import { readAttachedImage } from "./inputs/images.ts"
import { contextReadTool, internalContextTools } from "./inputs/io.ts"
import { ContextInputs, skillTool } from "./inputs/session.ts"
import { fuzzyFiles, mentions } from "./inputs/syntax.ts"
import { LanguageServices } from "./language/service.ts"
import { CodesplashEventFactory, CodesplashLoop } from "./loop.ts"
import { McpManager } from "./mcp/manager.ts"
import { createMcpToolRegistry } from "./mcp/registry.ts"
import { embeddingTool } from "./memory/embedding.ts"
import { maintainMemory } from "./memory/maintenance.ts"
import { MemorySession } from "./memory/session.ts"
import { memoryGate, memoryTools } from "./memory/tools.ts"
import { NativeAutomation } from "./orchestration/automation.ts"
import {
  type ChildLaunch,
  type ChildRuntime,
  NativeChildren,
  type SpawnAgentInput,
} from "./orchestration/children.ts"
import { NativeCommands } from "./orchestration/commands.ts"
import { NativeScheduler } from "./orchestration/scheduler.ts"
import {
  ChildSandbox,
  configurationIdentity,
  narrowedMode,
  scopedConfig,
  scopedPermissions,
  scopedProfile,
  scopedRegistry,
} from "./orchestration/scope.ts"
import { NativeTeams } from "./orchestration/teams.ts"
import { NativeWorktrees } from "./orchestration/worktrees.ts"
import { editPermissionRule, parsePermissionEdit, ruleConflict } from "./permission-editor.ts"
import {
  createPermissionRuntime,
  describePermissionRules,
  type PermissionRuntimeOptions,
} from "./permissions.ts"
import { readPluginManifest } from "./plugins/manifest.ts"
import { verifySelection } from "./plugins/store.ts"
import { generatePresentation } from "./presentation.ts"
import { buildSystemPrompt } from "./prompt.ts"
import { observedProvider } from "./providers/observed.ts"
import { NativeRecovery } from "./recovery.ts"
import type { SandboxRuntime } from "./sandbox/contracts.ts"
import { contains, createProfile, physicalPath, pinProfile } from "./sandbox/profile.ts"
import { NativeSandbox } from "./sandbox/runtime.ts"
import { ToolOutputStore } from "./tool-output-store.ts"
import { advancedTools } from "./tools/advanced.ts"
import { BrowserTools } from "./tools/browser.ts"
import { environmentTool } from "./tools/environments.ts"
import { GenerationTools } from "./tools/generation.ts"
import { pluginSuggestions } from "./tools/plugin-suggestions.ts"
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
  hostExtensions?: readonly import("./extensions/api.ts").HostExtension[]
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

type ChildScope = ChildLaunch & {
  parentPermissions: PermissionRuntime
  parentProfile: import("./sandbox/contracts.ts").SandboxProfile
  resolveParent: () => Promise<AgentConfig>
}

export class CodesplashDriver implements EngineDriver {
  readonly id = "codesplash" as const
  #configPromise: Promise<AgentConfig> | undefined

  constructor(readonly options: CodesplashDriverOptions = {}) {}

  async #config(workspace?: {
    cwd: string
    workspaceTrusted?: boolean
    trustDataDirectory?: string
  }): Promise<AgentConfig> {
    if (workspace) {
      if (this.options.config)
        return resolveConfigForWorkspace(this.options.config, workspace.cwd, workspace.workspaceTrusted)
      return loadConfig(undefined, [], {
        cwd: workspace.cwd,
        workspaceTrusted: workspace.workspaceTrusted,
        dataDir: workspace.trustDataDirectory,
      })
    }
    if (this.options.config) return this.options.config
    this.#configPromise ??= loadConfig(undefined, [], {})
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
    await hydrateKeyringCredentials()
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

    const possibleExtensionProvider =
      !config.extensions?.disabled &&
      Object.values(config.extensions?.entries ?? {}).some((entry) => entry.enabled)
    if (resolved.length === 0 && !anyCustomAvailable && !possibleExtensionProvider) {
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
      detail: [
        ...builtinDetails,
        ...customDetails,
        ...(possibleExtensionProvider
          ? ["Configured extensions; provider availability is checked after explicit source trust"]
          : []),
      ].join(" · "),
    }
  }

  async openSession(options: OpenSessionOptions): Promise<EngineSession> {
    options = {
      ...options,
      execution: {
        ...(process.env.CODESPLASH_AGENT_FEATURES
          ? { features: process.env.CODESPLASH_AGENT_FEATURES.split(",") }
          : {}),
        ...(process.env.CODESPLASH_BROWSER_ORIGINS
          ? { browserOrigins: process.env.CODESPLASH_BROWSER_ORIGINS.split(",") }
          : {}),
        ...options.execution,
      },
      sessionState: options.sessionState ?? new MemorySessionState(),
    }
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
            runtime.assertTasksIdle()
            const state = runtime.options
              .sessionState as import("../../core/session/control.ts").SessionStateAccess
            const from = runtime.options.cwd,
              cwd = destinationDirectory(from, request.path)
            const trusted =
              (await readTrustDecision(cwd, runtime.options.trustDataDirectory))?.trusted === true
            const destinationConfig = await this.#config({
              ...runtime.options,
              cwd,
              workspaceTrusted: trusted,
            })
            const generation = destinationConfig.resolution?.generation
            const revision = digest(JSON.stringify([state.read().revision, cwd, trusted, generation]))
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
            await runtime.lifecycleHook("cwd.before", {
              transition: { from, to: cwd, context: request.context },
            })
            await runtime.suspendHooks()
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
            await next.initializeRecovery(false)
            // Trust and physical identity are admission inputs, not facts captured indefinitely by preview.
            if (
              destinationDirectory(from, request.path) !== cwd ||
              (await this.#config({ ...runtime.options, cwd, workspaceTrusted: trusted })).resolution
                ?.generation !== generation ||
              ((await readTrustDecision(cwd, runtime.options.trustDataDirectory))?.trusted === true) !==
                trusted
            )
              throw new Error("Destination, configuration or trust changed during preparation; preview again")
            prepared.publish()
            return { ...preview, applied: true }
          })
          if (next) {
            const replacement = next
            next = undefined
            attach(replacement)
            runtime.retireDirectoryHooks()
            await routed.replace(replacement)
            await replacement.finishDirectoryPublication()
            await replacement.lifecycleHook("cwd.after", {
              transition: { from: result.from, to: result.cwd, context: result.context ?? "clear" },
            })
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
    scope?: ChildScope,
    inheritedBudget?: DollarBudget,
  ): Promise<CodesplashSession> {
    options = { ...options, execution: options.execution ? structuredClone(options.execution) : undefined }
    validateLimits(options.execution)
    const dollarBudget =
      inheritedBudget ??
      (options.execution?.maxBudgetUsd === undefined
        ? undefined
        : new DollarBudget(
            options.execution.maxBudgetUsd,
            options.initialUsage,
            (state) => {
              if (options.sessionState)
                options.sessionState.update(
                  options.sessionState.read().revision,
                  "execution-budget",
                  (draft) => {
                    draft.values.executionBudget = state
                  },
                )
            },
            options.sessionState?.read().state.values.executionBudget as DollarState | undefined,
          ))
    const resolveNative = async () => {
      if (!scope) return this.#config(options)
      const parent = await scope.resolveParent()
      if (configurationIdentity(parent) !== scope.identity.config)
        throw new Error("Child parent configuration changed")
      return scopedConfig(parent, scope.definition)
    }
    scope?.signal.throwIfAborted()
    const config = await resolveNative()
    const featureRoot = config.resolution ? dirname(config.resolution.request.userPath) : configDirectory()
    const features = resolveFeatures(options.execution?.features, featureRoot).filter(
      (name) =>
        (!scope || options.execution?.features?.includes(name)) &&
        (!config.resolution?.constraints.featureIds ||
          config.resolution.constraints.featureIds.includes(name)),
    )
    options = { ...options, execution: { ...options.execution, features } }
    // Lifecycle gates are initialized before the session is published.
    assertManagedPolicy(
      config,
      options.policy ?? { ...config.codex, permissionMode: config.permissions.mode },
    )
    options = { ...options, model: options.model ?? config.models?.codesplash }
    const extensions = new ExtensionRuntime({
      config,
      cwd: options.cwd,
      dataDir: options.trustDataDirectory ?? dataDirectory(),
      disabled: options.disableExtensions,
      hostExtensions: scope
        ? this.options.hostExtensions?.filter((extension) => scope.identity.extensions.includes(extension.id))
        : this.options.hostExtensions,
      resolveConfig: resolveNative,
    })
    const workspaceClaim = scope
      ? undefined
      : await WorktreeStore.claimWorkspace(options.cwd, options.trustDataDirectory ?? dataDirectory())
    try {
      await extensions.stage()
    } catch (error) {
      workspaceClaim?.release()
      throw error
    }
    try {
      scope?.signal.throwIfAborted()
      await hydrateKeyringCredentials()
      const registry = buildProviderRegistry(config, process.env, extensions.providers())
      if (registry.providers.length === 0) {
        throw new Error(`${NO_KEYS_DETAIL} to use the CodeSplash engine`)
      }
      const providers: Record<string, ProviderClient> = {}
      for (const runtime of registry.providers) {
        const provider = this.options.providers?.[runtime.id] ?? runtime.client
        const bounded = dollarBudget ? dollarBudget.wrap(provider) : provider
        providers[runtime.id] = scope ? scope.budget.wrap(bounded) : bounded
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
      let permissions = await factory({
        cwd: options.cwd,
        mode: options.policy?.permissionMode ?? "default",
        workspaceTrusted: options.workspaceTrusted ?? true,
        configRules: config.permissions,
        constraints: config.resolution?.constraints,
        overrides: options.permissionOverrides,
        grantsPath: options.permissionGrantsPath,
        onWarning: (message) => bridge.warning(message),
        onModeChange: (mode) => bridge.modeChanged(mode),
      })
      if (scope) permissions = scopedPermissions(permissions, scope.parentPermissions, scope.definition)
      const directory = options.nativeTranscriptPath ? dirname(options.nativeTranscriptPath) : undefined
      const directoryId = options.sessionState ? directoryScope(options.sessionState.read().state) : undefined
      const profilePath = directory
        ? directoryId
          ? join(directory, "cwd-profiles", `${directoryId}.json`)
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
      const sandbox = scope
        ? new ChildSandbox(
            await pinProfile(
              scopedProfile(scope.parentProfile, scope.definition, permissions.mode, options.cwd),
              profilePath,
            ),
            directory ? join(directory, "sandbox-events.jsonl") : undefined,
            undefined,
            config.resolution?.constraints,
          )
        : this.options.sandbox
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
              undefined,
              config.resolution?.constraints,
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
        extensions,
        resolveNative,
        (childOptions, launch, parentPermissions, parentProfile, resolveParent) =>
          this.#openNative(
            { ...childOptions, agent: undefined, execution: options.execution },
            launch.history,
            false,
            {
              ...launch,
              parentPermissions,
              parentProfile,
              resolveParent,
            },
            dollarBudget,
          ),
        scope,
      )
      try {
        session.retainWorktreeClaim(workspaceClaim?.release)
        if (!prepared) await session.initializeRecovery()
        return session
      } catch (error) {
        await session.close()
        throw error
      }
    } catch (error) {
      workspaceClaim?.release()
      await extensions.close()
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
  readonly #commands: NativeCommands
  #releaseWorktree?: () => void
  retainWorktreeClaim(release?: () => void) {
    this.#releaseWorktree = release
  }
  readonly #worktrees: NativeWorktrees
  readonly #teams: NativeTeams
  readonly #scheduler: NativeScheduler
  readonly #automation: NativeAutomation
  readonly #children: NativeChildren

  changeDirectory?: (
    request: DirectoryRequest,
  ) => Promise<import("../../core/session/working-directory.ts").DirectoryPreview>
  readonly capabilities = CODESPLASH_CAPABILITIES
  readonly events: AsyncIterable<AgentEvent>
  readonly #queue = new AsyncQueue<AgentEvent>()
  readonly #diagnostics: Diagnostics
  readonly #browser: BrowserTools
  readonly #factory: CodesplashEventFactory
  readonly #loop: CodesplashLoop
  readonly #memory: MemorySession
  #memoryText = ""
  #memoryEpoch = 0
  #ownedMaintenance = new OwnedMaintenance()
  #sideQueries = new OwnedMaintenance()
  #lastTurnSucceeded = false
  #inputs: ContextInputs
  #inputPromise: Promise<unknown> | undefined
  #contextSuffix = ""
  #inputSuffix = ""
  #personality: "neutral" | "concise" | "explanatory"
  #selectedTask?: string
  #selectedInterrupted = false
  #language: LanguageServices
  #registry: ToolRegistry
  #mcp: McpManager
  #hooks: HookManager
  #extensions: ExtensionRuntime
  readonly #extensionBase: ToolRegistry
  #extensionTools: ToolRegistry
  #extensionComposer?: (text: string) => boolean
  #extensionsPublished = false
  #extensionAuxiliary = 0
  #extensionAuxiliaryBusy = false
  #extensionCommandAbort = new AbortController()
  #hooksInitialized = false
  #suppressSessionEnd = false
  #mcpInitialized = false
  readonly #providerRegistry: ProviderRegistry
  /** Provider clients keyed by runtime id ("anthropic", "openai", or a custom config key). */
  readonly #providers: Record<string, ProviderClient>
  #config: AgentConfig
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
    extensions: ExtensionRuntime,
    readonly resolveNative: () => Promise<AgentConfig>,
    readonly openChild: (
      options: OpenSessionOptions,
      launch: ChildLaunch,
      parentPermissions: PermissionRuntime,
      parentProfile: import("./sandbox/contracts.ts").SandboxProfile,
      resolveParent: () => Promise<AgentConfig>,
    ) => Promise<CodesplashSession>,
    readonly childScope?: ChildScope,
  ) {
    this.#extensions = extensions
    const state = options.sessionState ?? new MemorySessionState()
    this.events = this.#queue
    this.#config = config
    this.#providerRegistry = providerRegistry
    this.#diagnostics = new Diagnostics(
      options.nativeTranscriptPath
        ? join(options.trustDataDirectory ?? dataDirectory(), "diagnostics")
        : undefined,
    )
    this.#diagnostics.record("session.start")
    this.#providers = Object.fromEntries(
      Object.entries(providers).map(([id, provider]) => [id, observedProvider(provider, this.#diagnostics)]),
    )
    this.#policy = options.policy ?? defaultSessionPolicy
    this.#cwd = options.cwd
    this.#permissions = permissions
    this.#sandbox = sandbox
    this.#commands = new NativeCommands(
      options.localSessionId,
      state,
      sandbox,
      () => this.#permissions.mode,
      config.orchestration,
      options.trustDataDirectory ?? dataDirectory(),
      childScope?.commands,
      childScope?.task,
    )
    this.#worktrees = new NativeWorktrees(
      options.cwd,
      options.trustDataDirectory ?? dataDirectory(),
      () => sandbox.profile,
      () => permissions.mode,
      options.workspaceTrusted ?? true,
      () => permissions,
      () => this.resolveNative(),
    )
    this.#children = new NativeChildren({
      identity: childScope?.identity.id,
      team: () => childScope?.identity.team ?? this.#teams.store.read().coordinator,
      history: () => this.historyForDirectory(),
      worktrees: this.#worktrees,
      memory: childScope?.memory,
      outputSanitizer: () =>
        sandbox.outputSanitizer?.() ?? { push: (text) => sandbox.sanitize?.(text) ?? text },
      root: childScope?.identity.root ?? options.localSessionId,
      cwd: options.cwd,
      userRoot: resolve(configDirectory(), "context"),
      trusted: options.workspaceTrusted ?? true,
      state,
      parentTask: childScope?.task,
      budget: childScope?.budget,
      commands: this.#commands,
      sanitize: (text) => sandbox.sanitize?.(text) ?? text,
      extensions: () =>
        this.#extensions
          .status()
          .entries.filter((entry) => entry.state === "active")
          .map((entry) => entry.id)
          .sort(),
      config: () => this.#childConfig(),
      model: () => this.modelForDirectory(),
      profile: () => sandbox.profile,
      open: async (launch) => {
        const mode = narrowedMode(permissions.mode, launch.definition.mode)
        return this.openChild(
          {
            ...options,
            cwd: launch.identity.cwd,
            localSessionId: launch.identity.id,
            nativeSessionId: undefined,
            sessionState: launch.state,
            model: launch.identity.model,
            initialUsage: undefined,
            firstSequence: 0,
            permissionGrantsPath: undefined,
            resuming: launch.resuming,
            nativeTranscriptPath: launch.state.directory
              ? join(launch.state.directory, "transcript.jsonl")
              : undefined,
            flushSessionEvents: undefined,
            promptHistory: undefined,
            policy: {
              ...this.#policy,
              permissionMode: mode,
              sandbox:
                mode === "plan" || sandbox.profile.mode === "read-only" ? "read-only" : "workspace-write",
            },
          },
          launch,
          permissions,
          sandbox.profile,
          () => this.#childConfig(),
        )
      },
      emit: (event) => this.#push(this.#factory.event("child/event", {}, event)),
      usage: (delta) => this.#loop.recordChildUsage(delta),
      hook: async (name, signal, task, agent) => {
        await this.#loop.hook(name, signal, { transition: { task, agent } })
      },
    })
    this.#automation = new NativeAutomation({
      journal: new AutomationJournal(state),
      children: this.#children,
      commands: this.#commands,
      root: !childScope,
      cwd: options.cwd,
      identity: async () =>
        configurationIdentity(await this.#childConfig()) +
        ":" +
        this.#sandbox.profile.hash +
        ":" +
        this.#cwd +
        ":" +
        this.modelForDirectory() +
        ":" +
        this.#permissions.mode,
      canRead: async (path) => {
        const config = await this.resolveNative()
        const fresh = await createPermissionRuntime({
          cwd: this.#cwd,
          mode: this.#permissions.mode,
          workspaceTrusted: options.workspaceTrusted ?? true,
          configRules: config.permissions,
          constraints: config.resolution?.constraints,
        })
        return (
          (options.workspaceTrusted ?? true) &&
          [fresh, this.#permissions].every(
            (p) => !["ask", "deny"].includes(p.decide("read_file", { paths: [path] }, true).kind),
          )
        )
      },
      admit: async (name, input, parent, budget, signal) => {
        while (true) {
          signal.throwIfAborted()
          this.#requireOpen()
          if (Date.now() >= budget.deadline) throw new Error("Automation admission deadline exceeded")
          if (!this.#turnReserved && !this.#loop.isTurnActive && !this.inputQueue.next()) {
            return this.#inputOperation(async () => {
              signal.throwIfAborted()
              this.#children.admission = { parent, budget }
              this.#commands.admission = { parent }
              const cancel = () => this.#loop.interrupt()
              signal.addEventListener("abort", cancel, { once: true })
              try {
                return await this.#loop.runUserTool(name, input, false)
              } finally {
                this.#children.admission = undefined
                this.#commands.admission = undefined
                signal.removeEventListener("abort", cancel)
              }
            }, true)
          }
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      },
    })
    let schedulerPermissions = this.#permissions
    this.#scheduler = new NativeScheduler({
      cwd: options.cwd,
      dataRoot: options.trustDataDirectory ?? dataDirectory(),
      session: options.localSessionId,
      root: !childScope,
      automation: this.#automation,
      commands: this.#commands,
      identity: () => this.#automation.host.identity(),
      observable: (path) =>
        this.#sandbox.profile.readRoots.some((root) => contains(root, path)) &&
        !this.#sandbox.profile.deniedReadPaths.some((root) => contains(root, path)) &&
        [schedulerPermissions, this.#permissions].every(
          (p) => !["ask", "deny"].includes(p.decide("read_file", { paths: [path] }, true).kind),
        ),
      authorize: async (action, path) => {
        const fresh = await this.resolveNative()
        if (!(options.workspaceTrusted ?? true) || fresh.history.enabled === false)
          throw new Error("Persistent scheduling requires a trusted workspace and enabled history policy")
        const permissions = await createPermissionRuntime({
          cwd: this.#cwd,
          mode: this.#permissions.mode,
          workspaceTrusted: true,
          configRules: fresh.permissions,
          constraints: fresh.resolution?.constraints,
        })
        schedulerPermissions = permissions
        const tool = ["create", "enable", "start", "run"].includes(action)
          ? "scheduler_create"
          : action === "list"
            ? "scheduler_list"
            : "scheduler_delete"
        for (const runtime of [permissions, this.#permissions]) {
          if (
            ["scheduler", tool].some(
              (name) => runtime.decide(name, undefined, action === "list").kind === "deny",
            )
          )
            throw new Error("Scheduling denied by current policy")
          if (path && ["ask", "deny"].includes(runtime.decide("read_file", { paths: [path] }, true).kind))
            throw new Error("Watch root is not authorized for background observation")
        }
        if (
          path &&
          (!this.#sandbox.profile.readRoots.some((root) => contains(root, path)) ||
            this.#sandbox.profile.deniedReadPaths.some((root) => contains(root, path)))
        )
          throw new Error("Watch root exceeds filesystem authority")
      },
    })
    this.#teams = new NativeTeams({
      root: !childScope,
      state,
      children: this.#children,
      commands: this.#commands,
      usage: () => this.usageForDirectory(),
      sanitize: (text) => sandbox.sanitize?.(text) ?? text,
      authorize: async (action, context) => {
        const config = await this.resolveNative()
        const fresh = await createPermissionRuntime({
          cwd: this.#cwd,
          mode: this.#permissions.mode,
          workspaceTrusted: options.workspaceTrusted ?? true,
          configRules: config.permissions,
          constraints: config.resolution?.constraints,
        })
        for (const p of [fresh, this.#permissions]) {
          for (const name of action === "dispatch" ? ["teams", "agent"] : ["teams"]) {
            const decision = p.decide(name, undefined, true)
            if (decision.kind === "deny") throw new Error(`Team control denied: ${name}`)
            if (
              decision.kind === "ask" &&
              (!context || this.#permissions.decide(name, undefined, true).kind !== "ask")
            )
              throw new Error(
                "Team action requires current native approval; reload changed configuration before retrying",
              )
          }
        }
      },
    })
    this.#commands.onTaskUpdate = (item) =>
      this.#push(this.#factory.event("tasks/status", {}, { kind: "item.updated", payload: item }))
    this.#commands.onForget = (id) => this.#children.forget(id)
    this.#bypassAllowed = options.policy?.permissionMode === "bypass"
    this.#factory = new CodesplashEventFactory(options.localSessionId, options.firstSequence ?? 0)
    const userRoot = resolve(configDirectory(), "context")
    this.#inputs = new ContextInputs(
      options.cwd,
      userRoot,
      options.workspaceTrusted ?? true,
      config.context,
      sandbox.sanitize?.bind(sandbox),
      config.pluginResources,
      true,
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
    const outputs = new ToolOutputStore(
      options.nativeTranscriptPath ? join(dirname(options.nativeTranscriptPath), "tool-outputs") : undefined,
    )
    this.#hooks = new HookManager({
      cwd: options.cwd,
      dataDir: options.trustDataDirectory ?? dataDirectory(),
      config,
      resolveConfig: () => this.resolveNative(),
      mode: () => permissions.mode,
      sandbox,
      state,
      outputs,
      activity: (activity) =>
        this.#push(this.#factory.event("hooks/activity", {}, { kind: "hook.activity", payload: activity })),
      diagnostic: (message) =>
        this.#push(this.#factory.event("hooks/diagnostic", {}, { kind: "warning", payload: { message } })),
    })
    this.#mcp = new McpManager({
      cwd: options.cwd,
      dataDir: options.trustDataDirectory ?? dataDirectory(),
      sandbox,
      mode: () => permissions.mode,
      configurationBoundary: structuredClone(config),
      resolveConfig: () => this.resolveNative(),
      toolAllowed: (id, readOnly) => permissions.decide(id, undefined, readOnly).kind !== "deny",
      elicitation: {
        busy: () => this.#loop.hasPendingInteraction,
        respond: (form, signal) => this.#loop.requestForm(form, signal),
      },
      diagnostic: (message) =>
        this.#push(this.#factory.event("mcp/status", {}, { kind: "warning", payload: { message } })),
      changed: () => {
        this.#loop?.clearApprovalCache()
        this.#systemPrompt = undefined
      },
    })
    this.#browser = new BrowserTools(
      sandbox.profile.allowedHosts,
      options.execution?.browserOrigins ?? [],
      undefined,
      config.resolution?.constraints?.allowedHosts === undefined,
    )
    this.#language = new LanguageServices({
      root: join(options.trustDataDirectory ?? dataDirectory(), "language-services"),
      persistent: options.nativeTranscriptPath !== undefined,
      cwd: options.cwd,
      sandbox,
      permissions,
      trusted: options.workspaceTrusted === true,
    })
    this.#extensionBase = createToolRegistry(
      [
        ...builtinTools(),
        ...(options.execution?.features?.includes("generation")
          ? [
              new GenerationTools(
                join(options.trustDataDirectory ?? dataDirectory(), "generation", options.localSessionId),
                sandbox.profile.allowedHosts,
                undefined,
                options.execution?.maxBudgetUsd !== undefined,
                config.resolution?.constraints?.allowedHosts === undefined,
              ).tool(),
            ]
          : []),
        ...(options.execution?.features?.includes("environments")
          ? [
              environmentTool(
                options.execution.environments ?? [{ id: "local", transport: "local" }],
                sandbox,
                config.resolution?.constraints?.allowedHosts === undefined,
              ),
            ]
          : []),
        ...(options.execution?.features?.includes("plugins") ? [pluginSuggestions(() => this.#config)] : []),
        ...(options.execution?.features?.includes("browser") ? [this.#browser.tool()] : []),
        ...advancedTools().filter((tool) =>
          options.execution?.features?.some((feature) => advancedFeatures[feature]?.includes(tool.name)),
        ),
        this.#language.tool(),
        this.#language.workspaceTool(),
        ...this.#commands.tools(),
        ...this.#children.tools(),
        ...this.#automation.tools(),
        ...this.#scheduler.tools(),
        ...this.#teams.tools(),
        this.#worktrees.tool(),
        ...internalContextTools(),
        contextReadTool(userRoot, () => this.#config.pluginResources ?? []),
        skillTool,
        ...memoryTools(this.#memory, () => this.#loop.historySnapshot(), options.nativeTranscriptPath),
        memoryGate("memory_access", "memory_search"),
        memoryGate("memory_history_access", "history_read"),
        memoryGate("memory_access_read", "memory_read"),
        memoryGate("memory_change", "memory_write", true),
        embeddingTool(
          options.execution?.maxBudgetUsd === undefined ? config.memory?.embedding : undefined,
          (tokens, cost) => this.#loop.recordEmbeddingUsage(tokens, cost),
          childScope?.budget,
        ),
      ],
      config.resolution?.generation,
    )
    this.#extensionTools = extensions.registry(this.#extensionBase)
    const owner = this
    this.#registry = createMcpToolRegistry(
      {
        get generation() {
          return owner.#extensionTools.generation
        },
        specs: () => this.#extensionTools.specs(),
        get: (name, generation) => this.#extensionTools.get(name, generation),
        source: (name) => this.#extensionTools.source(name),
      },
      this.#mcp,
    )
    if (childScope) this.#registry = scopedRegistry(this.#registry, permissions)
    this.#registry = selectedRegistry(this.#registry, options.execution)
    this.#loop = new CodesplashLoop({
      postEdit: (outcome, context) => this.#language.afterEdit(outcome, context),
      modelToolAllowed: (name) =>
        !Object.entries(advancedFeatures).some(
          ([feature, tools]) =>
            tools.includes(name) &&
            (!resolveFeatures(
              this.options.execution?.features,
              this.#config.resolution ? dirname(this.#config.resolution.request.userPath) : configDirectory(),
            ).includes(feature) ||
              (this.#config.resolution?.constraints.featureIds &&
                !this.#config.resolution.constraints.featureIds.includes(feature))),
        ) &&
        (!(
          this.childScope?.definition.id === "builtin/coordinator" ||
          (!this.childScope && this.#teams.store.read().coordinator)
        ) ||
          coordinatorTools.has(name)),
      extensionsEnabled: () => this.#extensions.enabled,
      observeHook: async (event, signal) => {
        if (event.name === "turn.start") this.#extensionAuxiliary = 0
        await this.#extensions.observe(event, signal)
      },
      hooks: this.#hooks,
      cwd: options.cwd,
      onContextBoundary: (kind, messages) => {
        this.#diagnostics.record(kind === "before-compaction" ? "compaction.start" : "compaction.end")
        return this.#recovery.capture(kind, kind, messages)
      },
      beforeMutation: async (label, signal) => {
        try {
          return await this.#recovery.checkpoints.begin(label, signal)
        } catch (error) {
          this.#loop.interrupt(
            new Error(`Checkpoint failed: ${error instanceof Error ? error.message : String(error)}`),
          )
          throw error
        }
      },
      afterMutation: async (id) => {
        try {
          await this.#recovery.checkpoints.end(id)
        } catch (error) {
          this.#loop.interrupt(
            new Error(`Checkpoint failed: ${error instanceof Error ? error.message : String(error)}`),
          )
          throw error
        }
      },
      policy: this.#policy,
      registry: this.#registry,
      beforePermissionModeChange: async () => {
        this.#commands.assertIdle()
        this.#extensions.suspend()
        await this.#mcp.suspend()
      },
      events: this.#factory,
      emit: (event) => this.#push(event),
      fallbackModel: config.codesplash.fallbackModel,
      streamPolicy: config.codesplash,
      context: config.codesplash,
      outputStore: outputs,
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
    extensions.activate(this.#extensionHost())
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
  async initializeRecovery(startLifecycle = true): Promise<void> {
    await this.#recovery.initialize()
    if (startLifecycle && !this.childScope)
      for (const notice of featureAnnouncements(
        this.#config.resolution ? dirname(this.#config.resolution.request.userPath) : configDirectory(),
      ))
        this.#push(
          this.#factory.event(
            "fleet/announcement",
            {},
            { kind: "warning", payload: { message: notice.text } },
          ),
        )
    if (!this.#hooksInitialized) {
      const started = startLifecycle
        ? await this.#loop.hook(
            this.options.resuming ? "session.resume" : "session.start",
            AbortSignal.timeout(30000),
            { cwd: this.#cwd },
          )
        : undefined
      if (started?.context.length)
        this.#loop.seedHistory([
          ...this.#loop.historySnapshot(),
          { role: "user", content: started.context.map((text) => ({ type: "text", text })) },
        ])
      this.#hooksInitialized = true
      const enabled = Object.entries(this.#config.hooks?.handlers ?? {}).filter(
        ([, handler]) => handler.enabled,
      )
      if (enabled.length)
        this.#push(
          this.#factory.event(
            "hooks/review",
            {},
            {
              kind: "warning",
              payload: {
                message: `Configured hooks: ${enabled.map(([id, handler]) => `${id} (${handler.kind}, shares ${handler.share.join(", ") || "metadata only"})`).join("; ")}. Inspect /hooks show ID for source trust and execution limits.`,
              },
            },
          ),
        )
    }
    if (!this.#mcpInitialized) {
      this.#mcpInitialized = true
      for (const [id, server] of Object.entries(this.#config.mcp?.servers ?? {})) {
        if (!server.enabled || this.#closed) continue
        try {
          await this.#mcp.connect(id)
        } catch (error) {
          const message = this.#mcp.sanitize(error instanceof Error ? error.message : "Connection failed")
          this.#push(
            this.#factory.event(
              "mcp/status",
              {},
              { kind: "warning", payload: { message: `MCP ${id}: ${message}` } },
            ),
          )
        }
      }
    }
    this.#extensionsPublished = true
    if (this.#extensions.enabled)
      this.#push(
        this.#factory.event(
          "extensions/review",
          {},
          {
            kind: "warning",
            payload: {
              message:
                "Reviewed extensions run with harness-process privileges. Use --no-extensions to recover from a faulty extension.",
            },
          },
        ),
      )
    this.#inputRunner.wake()
  }
  directoryStatus() {
    return { cwd: this.#cwd, trusted: this.options.workspaceTrusted ?? true }
  }
  async lifecycleHook(name: HookEventName, fields: HookFields = {}): Promise<void> {
    try {
      await this.#loop.hook(name, AbortSignal.timeout(30000), { cwd: this.#cwd, ...fields })
    } catch (error) {
      if (hookIsGate(name)) throw error
    }
  }
  retireDirectoryHooks(): void {
    this.#suppressSessionEnd = true
  }
  async suspendHooks(): Promise<void> {
    this.#extensions.suspend()
    await this.#hooks.suspend()
  }
  async sessionPresentation(request: PresentationRequest): Promise<unknown> {
    this.#requireOpen()
    const state = this.#recovery.branches.state
    if (request.action === "info")
      return sessionInfo({
        state,
        id: this.localSessionId,
        nativeId: this.nativeSessionId,
        engine: "codesplash",
        cwd: this.#cwd,
        model: this.modelForDirectory(),
        sequence: this.#factory.nextSequence - 1,
        usage: this.#loop.usageSnapshot(),
        status: this.#loop.isTurnActive ? "running" : "ready",
        policy: {
          source: "live",
          sandbox: this.#policy.sandbox,
          approval: this.#policy.approvalPolicy,
          permission: this.#permissions.mode,
          trusted: this.options.workspaceTrusted ?? true,
          profile: this.#sandbox.profile.hash,
        },
        checkpointAvailability: this.#recovery.checkpoints.availability(),
      })
    if (request.generate) {
      // Reserve only preparation. Foreground work can cancel the owned request while it awaits I/O.
      const prepared = await this.#inputOperation(async () => {
        const model = this.#model,
          provider = this.#providers[model.provider]
        if (!provider) throw new Error("No provider for session summary")
        return {
          model,
          provider,
          messages: this.#loop.historySnapshot(),
          token: titleToken(state, this.modelForDirectory()),
        }
      })
      this.#requireOpen()
      if (this.#turnReserved || this.#loop.isTurnActive || this.inputQueue.next())
        throw new Error("Foreground input takes priority over session summaries")
      return this.#ownedMaintenance.run(`session-${request.action}`, async (signal) => {
        const text = await generatePresentation({
          ...prepared,
          kind: request.action === "rename" ? "title" : "recap",
          signal,
          sanitize: (text) => this.#sandbox.sanitize?.(text) ?? text,
          onUsage: (usage) =>
            usage
              ? this.#loop.recordAuxiliaryUsage(usage, prepared.model)
              : this.#loop.recordUnknownAuxiliaryUsage(),
        })
        signal.throwIfAborted()
        if (titleToken(state, this.modelForDirectory()) !== prepared.token)
          throw new Error("Session context changed; generated summary discarded")
        return request.action === "rename"
          ? renameSession(state, text, false, prepared.token, this.modelForDirectory())
          : text
      })
    }
    if (request.action === "rename")
      return this.#inputOperation(async () => {
        const user = [...this.#loop.historySnapshot()]
          .reverse()
          .find(
            (message) =>
              message.role === "user" &&
              message.content.some((block) => block.type === "text" && block.text.trim()),
          )
        const automatic =
          user?.content
            .filter((block) => block.type === "text")
            .map((block) => (block.type === "text" ? block.text : ""))
            .join(" ") ?? "Untitled session"
        return renameSession(
          state,
          request.auto ? titleText(automatic) : (request.title ?? ""),
          !request.auto,
        )
      })
    throw new Error("Local recaps and outcomes are projected by the session controller")
  }
  async sideQuery(
    request: { kind: "question" | "suggestion"; question?: string },
    signal?: AbortSignal,
  ): Promise<string> {
    this.#requireOpen()
    if (request.kind !== "question" && request.kind !== "suggestion") throw new Error("Invalid side query")
    if (request.kind === "question") {
      await this.#sideQueries.cancelAndSettle()
      this.#requireOpen()
    }
    if (request.kind === "suggestion" && (this.#loop.isTurnActive || this.inputQueue.next()))
      throw new Error("Foreground work takes priority over suggestions")
    const model = this.#model,
      provider = this.#providers[model.provider],
      messages = this.#loop.historySnapshot()
    if (!provider) throw new Error("No provider for side query")
    return this.#sideQueries.run(request.kind, async (owned) =>
      generatePresentation({
        ...request,
        model,
        provider,
        messages,
        signal: signal ? AbortSignal.any([owned, signal]) : owned,
        sanitize: (text) => this.#sandbox.sanitize?.(text) ?? text,
        onUsage: (usage) =>
          usage ? this.#loop.recordAuxiliaryUsage(usage, model) : this.#loop.recordUnknownAuxiliaryUsage(),
      }),
    )
  }
  async #childConfig(): Promise<AgentConfig> {
    const config = structuredClone(await this.resolveNative())
    const active = new Set(
      this.#extensions
        .status()
        .entries.filter((entry) => entry.state === "active")
        .map((entry) => entry.id),
    )
    for (const [id, entry] of Object.entries(config.extensions?.entries ?? {}))
      entry.enabled &&= active.has(id)
    for (const [id, handler] of Object.entries(config.hooks?.handlers ?? {}))
      handler.enabled &&= !this.#hooks.disabled(id)
    return config
  }
  async settled(): Promise<void> {
    await this.#admissionSettled
    await this.#turnPromise
    await this.#inputPromise
  }
  async spawnAgent(input: SpawnAgentInput) {
    return this.#inputOperation(() => this.#loop.runUserTool("agent", input, true))
  }
  async teams(input: TeamRequest) {
    this.#requireOpen()
    if (
      ["list", "peek", "reply", "interrupt", "close-panes"].includes(input.action) &&
      this.#permissions.decide("teams", undefined, true).kind !== "ask"
    )
      return { text: JSON.stringify(await this.#teams.control(input)) }
    return this.#inputOperation(() => this.#loop.runUserTool("teams", input, false), true)
  }
  async schedules(input: ScheduleRequest) {
    this.#requireOpen()
    if (["list", "stop"].includes(input.action))
      return { text: JSON.stringify(await this.#scheduler.control(input)) }
    return this.#inputOperation(() => this.#loop.runUserTool("scheduler", input, false), true)
  }
  async goals(input: GoalRequest) {
    this.#requireOpen()
    if (["get", "pause"].includes(input.action)) {
      if (this.#permissions.decide("goal", undefined, input.action === "get").kind === "deny")
        throw new Error("Goal controls denied")
      return { text: JSON.stringify(await this.#automation.control("goal", input)) }
    }
    return this.#inputOperation(() => this.#loop.runUserTool("goal", input, false), true)
  }
  async workflows(input: WorkflowRequest) {
    this.#requireOpen()
    if (["list", "pause"].includes(input.action)) {
      if (this.#permissions.decide("workflow", undefined, input.action === "list").kind === "deny")
        throw new Error("Workflow controls denied")
      return { text: JSON.stringify(await this.#automation.control("workflow", input)) }
    }
    return this.#inputOperation(() => this.#loop.runUserTool("workflow", input, false), true)
  }
  async worktrees(input: import("../../core/orchestration/worktrees.ts").WorktreeRequest) {
    return this.#inputOperation(() => this.#loop.runUserTool("worktree", input, false))
  }
  async peers(input: import("../../core/orchestration/peers.ts").PeerRequest) {
    this.#requireOpen()
    const name =
      input.action === "send"
        ? "send_message"
        : input.action === "interrupt"
          ? "interrupt_agent"
          : input.action === "wait"
            ? "wait_agent"
            : "peers"
    const decision = this.#permissions.decide(name, undefined, true)
    if (decision.kind === "deny") throw new Error(`Peer control denied: ${decision.reason}`)
    if (
      input.action === "endpoint" ||
      input.action === "followup" ||
      (input.action === "send" && input.endpoint) ||
      decision.kind === "ask"
    ) {
      const { action, ...fields } = input
      return this.#inputOperation(() =>
        this.#loop.runUserTool(name, name === "peers" ? input : fields, false),
      )
    }
    return this.#children.peer(input)
  }
  async agentDefinitions() {
    return this.#inputOperation(() => this.#loop.runUserTool("list_agents", {}, false))
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
    return diagnosticContext.run(this.#diagnostics, () => this.#sendObserved(input, queuedId))
  }
  async #sendObserved(input: UserInput, queuedId?: string): Promise<void> {
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
      this.#turnPromise = (
        this.options.agent
          ? this.#runSelectedAgent(input)
          : this.#loop.runTurn({
              provider,
              model: this.#model,
              reasoningEffort: this.#reasoningEffort,
              system: this.childScope
                ? `${system}\n\n[Child role ${this.childScope.definition.id}]\n${this.childScope.definition.prompt}\n${this.childScope.identity.persona}\n${this.childScope.identity.directive ?? ""}`
                : this.#teams.store.read().coordinator
                  ? `${system}\n\nYou are a coordinator for team ${this.#teams.store.read().coordinator}. Delegate work through teams/agent, inspect progress and queue messages. Your model tools are restricted to orchestration. Receiving a message never authorizes new work.`
                  : system,
              userText: input.text,
              userMessageId: inputId,
              userContent,
              takeTaskNotices: () => this.#commands.takeNotices(),
              takePeerMessages: () => this.#children.takeMessages(),
              hasSteering: () => Boolean(this.inputQueue.next("steering")),
              hasForegroundInput: () => Boolean(this.inputQueue.next()),
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
                  prepare: (run: ContextToolRunner, signal: AbortSignal, admittedText?: string) =>
                    this.#prepareInput({ ...next, text: admittedText ?? next.text }, run, signal, item.id),
                }
              },
              prepare: (run, signal, admittedText) =>
                this.#prepareInput({ ...input, text: admittedText ?? input.text }, run, signal, inputId),
              invokeSkill: async (value, run, signal) => {
                if (
                  !value ||
                  typeof value !== "object" ||
                  !("name" in value) ||
                  typeof value.name !== "string"
                )
                  throw new Error("skill requires a name")
                const args = "arguments" in value ? value.arguments : ""
                if (typeof args !== "string") throw new Error("skill arguments must be a string")
                const before = await this.#loop.hook(
                  "resource.before",
                  signal,
                  { text: args, cwd: this.#cwd },
                  { kind: "skill", toolName: value.name },
                )
                const result = await this.#inputs.invoke(value.name, args, run, true)
                const after = await this.#loop.hook(
                  "resource.after",
                  signal,
                  { cwd: this.#cwd },
                  { kind: "skill", toolName: value.name },
                )
                return [result, ...(before?.context ?? []), ...(after?.context ?? [])].join("\n\n")
              },
            })
      )
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

  async #runSelectedAgent(input: UserInput): Promise<void> {
    const turnId = crypto.randomUUID(),
      messageId = crypto.randomUUID()
    this.#selectedInterrupted = false
    const emit = (event: import("../../core/events.ts").AgentEventInput) =>
      this.#push(this.#factory.event("agent/selected", { turnId }, event))
    emit({ kind: "user.message", payload: { id: crypto.randomUUID(), text: input.text } })
    emit({ kind: "turn.started", payload: {} })
    let text = "",
      status: "completed" | "failed" | "interrupted" = "failed"
    try {
      if (input.images?.length || input.files?.length)
        throw new Error("Selected-agent prompts currently require text; include explicit file references")
      const started = await this.#loop.runUserTool(
        "agent",
        { agent: this.options.agent, prompt: input.text, context: "fork", yieldMs: 0 },
        false,
      )
      if (started.isError) throw new Error(started.text)
      const value = JSON.parse(started.text) as { task?: { id?: string } }
      if (!value.task?.id) throw new Error("Selected agent did not return a native task")
      this.#selectedTask = value.task.id
      if (this.#selectedInterrupted) this.#commands.tasks.interrupt(value.task.id)
      for await (const page of this.#commands.monitor(value.task.id)) {
        if (page.lost || Buffer.byteLength(text + page.text) > 1024 * 1024)
          throw new Error("Selected-agent output exceeds retention limit")
        text += page.text
        if (page.text) emit({ kind: "message.delta", payload: { id: messageId, text: page.text } })
      }
      const task = this.#commands.output(value.task.id).task
      status =
        task?.status === "completed" ? "completed" : task?.status === "cancelled" ? "interrupted" : "failed"
      this.#loop.recordDelegatedTurn(input.text, text)
      emit({ kind: "message.completed", payload: { id: messageId, text } })
    } catch (error) {
      if (this.#selectedTask) this.#commands.tasks.interrupt(this.#selectedTask)
      status = this.#selectedInterrupted ? "interrupted" : "failed"
      emit({
        kind: "error",
        payload: { message: error instanceof Error ? error.message : String(error), recoverable: true },
      })
    } finally {
      this.#selectedTask = undefined
      emit({ kind: "turn.completed", payload: { status } })
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

  assertTasksIdle() {
    this.#commands.assertIdle()
  }
  async tasks(request: TaskRequest): Promise<unknown> {
    this.#requireOpen()
    if (request.action === "stdin")
      return this.#inputOperation(
        () => this.#loop.runUserTool("write_stdin", { id: request.id, text: request.text }),
        true,
      )
    return this.#commands.control(request)
  }
  monitorTask(id: string, cursor = 0) {
    this.#requireOpen()
    return this.#commands.monitor(id, cursor)
  }
  async runCommand(
    command: string,
    includeContext = false,
    snapshot?: import("./orchestration/shell-state.ts").ShellSelection,
  ): Promise<unknown> {
    if (/^\/(?:share|unshare)(?:\s|$)/.test(command))
      throw new Error("Session links are owned by the daemon; use codesplash serve and attach")
    return this.#inputOperation(
      () =>
        this.#loop.runUserTool(
          "exec_command",
          { command, yieldMs: 1000, ...(snapshot ? { snapshot } : {}) },
          includeContext,
        ),
      true,
    )
  }
  async sessionRecovery(request: RecoveryRequest): Promise<RecoveryResult> {
    this.#requireOpen()
    if (request.action === "tree") return { title: "Session branches", data: this.#recovery.branches.view() }
    if (request.action === "checkpoints")
      return { title: "File checkpoints", data: this.#recovery.checkpoints.view() }
    return this.#inputOperation(async () => {
      // Recorder outcome materialization shares the recovery revision. Drain it before reviewing
      // a target, and again after lifecycle callbacks, so it cannot race blob validation/apply.
      await this.options.flushSessionEvents?.()
      this.inputQueue.pause()
      const transition =
        request.action === "fork" ||
        request.action === "recover-restore" ||
        ((request.action === "rewind" || request.action === "restore") && request.apply === true)
      let reviewed: RecoveryResult | undefined
      if ((request.action === "rewind" || request.action === "restore") && request.apply) {
        reviewed = await this.#recovery.execute({ ...request, apply: false })
        if (!("revision" in reviewed.data) || request.revision !== reviewed.data.revision)
          throw new Error("Recovery preview is stale; review it again")
      }
      if (transition) {
        await this.lifecycleHook("branch.before", { transition: { action: request.action } })
        await this.#hooks.suspend()
        await this.#mcp.suspend()
        await this.options.flushSessionEvents?.()
      }
      if (reviewed && (request.action === "rewind" || request.action === "restore")) {
        const fresh = await this.#recovery.execute({ ...request, apply: false })
        if (
          JSON.stringify({ ...reviewed.data, revision: undefined }) !==
            JSON.stringify({ ...fresh.data, revision: undefined }) ||
          !("revision" in fresh.data) ||
          typeof fresh.data.revision !== "string"
        )
          throw new Error("Hook changed the recovery target; review the updated preview")
        request = { ...request, revision: fresh.data.revision }
      }
      const result = await this.#recovery.execute(request)
      if (transition) await this.lifecycleHook("branch.after", { transition: { action: request.action } })
      if (request.action === "rewind" && request.apply) result.data = this.#recovery.branches.view()
      return result
    })
  }

  async resolveRequest(requestId: string, decision: EngineDecision): Promise<void> {
    this.#requireOpen()
    if (await this.#children.resolve(requestId, decision)) return
    this.#loop.resolveRequest(requestId, decision.choice, decision.data)
  }

  async interrupt(): Promise<void> {
    this.#extensionCommandAbort.abort()
    this.#extensionCommandAbort = new AbortController()
    this.#extensions.suspend()
    if (this.#closed) return
    this.inputQueue.pause()
    await this.#interruptAndSettle()
  }
  async #interruptAndSettle(): Promise<void> {
    this.#selectedInterrupted = true
    if (this.#selectedTask) this.#commands.tasks.interrupt(this.#selectedTask)
    this.#sideQueries.cancel()
    this.#admissionAbort?.abort(new Error("Input interrupted before provider admission"))
    this.#ownedMaintenance.cancel()
    this.#maintenanceAbort?.abort()
    this.#loop.interrupt()
    await this.#ownedMaintenance.settle()
    await this.#sideQueries.settle()
    await this.#admissionSettled
    await this.#turnPromise?.catch(() => {})
    await this.#inputPromise?.catch(() => {})
  }
  async #prepareInput(input: UserInput, run: ContextToolRunner, signal: AbortSignal, inputId?: string) {
    await this.#mcp.revalidate()
    signal.throwIfAborted()
    const before = await this.#loop.hook(
      "resource.before",
      signal,
      { text: input.text, cwd: this.#cwd },
      { kind: "context-input" },
      inputId,
    )
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
    const after = await this.#loop.hook(
      "resource.after",
      signal,
      { cwd: this.#cwd },
      { kind: "context-input" },
      inputId,
    )
    prepared.content.push(
      ...[...(before?.context ?? []), ...(after?.context ?? [])].map((text) => ({
        type: "text" as const,
        text,
      })),
    )
    return prepared
  }

  async #inputOperation<T>(operation: () => Promise<T>, commandControl = false): Promise<T> {
    this.#requireOpen()
    if (!commandControl) this.#loop.assertMutationsSettled()
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
            description: `${r.description}${r.disabled ? " [user invocation only]" : ""}${r.fork ? " [child agent]" : ""}`,
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
      await this.lifecycleHook("config.before", {
        transition: { kind: "personality", from: this.#personality, to: personality },
      })
      await this.#hooks.suspend()
      this.#personality = personality
      this.#systemPrompt = undefined
      await this.lifecycleHook("config.after", { transition: { kind: "personality", to: personality } })
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
    this.#commands.assertIdle()
    if (this.#turnReserved || this.#loop.isTurnActive)
      throw new Error("Wait for the current turn before editing permission rules")
    // Reserve admission across disk I/O so send()/mode changes cannot race a policy edit.
    this.#turnReserved = true
    try {
      await this.#cancelLearning()
      this.#requireOpen()
      await this.lifecycleHook("config.before", { transition: { kind: "permission-rules", command } })
      await this.#hooks.suspend()
      const updated = await editPermissionRule(parsePermissionEdit(command), {
        cwd: this.#cwd,
        trusted: this.options.workspaceTrusted ?? true,
        grantsPath: this.options.permissionGrantsPath,
        userConfigPath: this.#config.resolution?.request.userPath,
      })
      if (updated) {
        const resolved = await resolveConfigForWorkspace(
          this.#config,
          this.#cwd,
          this.options.workspaceTrusted,
        )
        Object.assign(this.#config.permissions, resolved.resolution ? resolved.permissions : updated)
      }
      await this.#mcp.suspend()
      await this.#permissions.reload?.()
      this.#contextSuffix = ""
      this.#inputs.catalog = { resources: [], diagnostics: [] }
      this.#memory.invalidate()
      this.#memoryText = ""
      this.#loop.clearApprovalCache()
      this.#systemPrompt = undefined
      await this.lifecycleHook("config.after", { transition: { kind: "permission-rules" } })
    } finally {
      this.#turnReserved = false
      this.#inputRunner.wake()
    }
  }
  permissionRules() {
    const rules = describePermissionRules(this.#permissions)
    return rules.map((rule) => ({ ...rule, conflict: ruleConflict(rule, rules) }))
  }
  async mcpCommand(command: string): Promise<unknown> {
    const [action = "status", id, ...extra] = command.trim().split(/\s+/)
    if (
      extra.length ||
      !["status", "enable", "disable", "reconnect"].includes(action) ||
      (action === "status" ? !!id : !id)
    )
      throw new Error("Usage: /mcp status|enable ID|disable ID|reconnect ID")
    if (action !== "status") this.#commands.assertIdle()
    return this.#inputOperation(async () => {
      const config = await resolveConfigForWorkspace(this.#config, this.#cwd, this.options.workspaceTrusted)
      if (action !== "status" && id) {
        if (action === "disable") await this.#mcp.disconnect(id)
        else {
          if (!config.mcp?.servers[id]) throw new Error("MCP server is not configured")
          if (!config.mcp.servers[id].enabled)
            throw new Error(
              "Enable this source with codesplash mcp enable ID, then inspect and trust its fingerprint before connecting",
            )
          await this.#mcp.connect(id)
        }
      }
      if (action === "status") await this.#mcp.revalidate()
      const active = this.#mcp.statuses()
      return {
        scope:
          "Current session connections; configuration and fingerprint trust are managed by codesplash mcp",
        servers: Object.entries(config.mcp?.servers ?? {}).map(([id, server]) => ({
          transport: server.transport,
          configuredEnabled: server.enabled,
          permitted: config.resolution?.constraints.mcpServers?.includes(id) ?? true,
          source: config.resolution?.provenance[`mcp.servers.${id}.transport`] ?? [],
          authentication: server.oauth
            ? "protected OAuth"
            : server.bearerEnv
              ? "environment reference"
              : "none",
          ...(active.find((entry) => entry.id === id) ?? { id, state: "disconnected", tools: 0 }),
        })),
      }
    })
  }
  #extensionHost(): ExtensionHost {
    return {
      interactive: () =>
        this.#extensionsPublished && this.options.interactiveExtensions === true && !this.#closed,
      ui: (update) => {
        if (update.operation === "composer")
          return (
            this.#extensionsPublished &&
            !this.#loop.isTurnActive &&
            !this.#loop.hasPendingInteraction &&
            this.#extensionComposer?.(update.text) === true
          )
        if (this.#ended) return false
        this.#push(this.#factory.event("extensions/ui", {}, { kind: "extension.ui", payload: update }))
        return this.options.interactiveExtensions === true
      },
      dialog: (form, signal) => this.#loop.requestForm(form, signal, true),
      diagnostic: (message) =>
        this.#push(
          this.#factory.event("extensions/diagnostic", {}, { kind: "warning", payload: { message } }),
        ),
      complete: async (selector, prompt, signal) => {
        if (
          !this.#extensionsPublished ||
          this.#closed ||
          this.#extensionAuxiliaryBusy ||
          (!this.#loop.isTurnActive && !this.#turnReserved) ||
          ++this.#extensionAuxiliary > 8
        )
          throw new Error("Extension auxiliary work is unavailable or its budget is exhausted")
        const model = this.#providerRegistry.find(selector),
          provider = model ? this.#providers[model.provider] : undefined
        if (
          !model ||
          !provider ||
          prompt.length / 3 + Math.min(model.maxOutputTokens, 8192) + 512 > model.contextWindow
        )
          throw new Error(
            "Extension auxiliary model unavailable or exceeds its 8192-token output/context budget",
          )
        this.#extensionAuxiliaryBusy = true
        try {
          return this.#extensions.sanitize(
            await this.#loop.extensionComplete(
              { ...model, maxOutputTokens: Math.min(model.maxOutputTokens, 8192) },
              provider,
              prompt,
              signal,
            ),
          )
        } finally {
          this.#extensionAuxiliaryBusy = false
        }
      },
    }
  }
  setExtensionComposer(callback?: (text: string) => boolean): void {
    this.#extensionComposer = callback
  }
  async pluginsCommand(command: string): Promise<unknown> {
    if (!["status", "reload"].includes(command.trim())) throw new Error("Usage: /plugins status|reload")
    if (command.trim() === "reload") this.#commands.assertIdle()
    return this.#inputOperation(async () => {
      if (command.trim() === "reload") {
        const signal = this.#extensionCommandSignal()
        const config = await resolveConfigForWorkspace(
          this.#config,
          this.#cwd,
          this.options.workspaceTrusted,
          true,
        )
        const policy = (value: AgentConfig) =>
          stableValue([value.permissions, value.codex, value.sandbox, value.resolution?.constraints])
        if (policy(config) !== policy(this.#config))
          throw new Error("Plugin reload cannot change pinned policy; open a new session")
        const resolveCurrent = () =>
          resolveConfigForWorkspace(config, this.#cwd, this.options.workspaceTrusted)
        const extensions = new ExtensionRuntime({
          ...this.#extensions.options,
          config,
          resolveConfig: resolveCurrent,
        })
        const hooks = new HookManager({ ...this.#hooks.options, config, resolveConfig: resolveCurrent })
        let published = false
        const mcp = new McpManager({
          ...this.#mcp.options,
          configurationBoundary: config,
          resolveConfig: resolveCurrent,
          changed: () => {
            if (published) {
              this.#loop.clearApprovalCache()
              this.#systemPrompt = undefined
            }
          },
        })
        const abortStaging = () => {
          if (!published) void Promise.allSettled([extensions.close(), hooks.close(), mcp.close()])
        }
        signal.addEventListener("abort", abortStaging, { once: true })
        try {
          signal.throwIfAborted()
          await extensions.stage(signal)
          if (extensions.providers().length || this.#extensions.providers().length)
            throw new Error("Plugin provider changes require a new session")
          const tools = extensions.registry(this.#extensionBase)
          await hooks.reload()
          for (const [id, server] of Object.entries(config.mcp?.servers ?? {}))
            if (server.enabled) {
              signal.throwIfAborted()
              await mcp.connect(id)
            }
          const inputs = new ContextInputs(
            this.#cwd,
            resolve(configDirectory(), "context"),
            this.options.workspaceTrusted ?? true,
            config.context,
            this.#sandbox.sanitize?.bind(this.#sandbox),
            config.pluginResources,
            true,
          )
          // Metadata and integrity are staged without prematurely granting resource read permissions.
          for (const selection of config.pluginResources ?? [])
            await verifySelection(selection, "plugin", signal)
          const owner = this
          const registry = createMcpToolRegistry(
            {
              get generation() {
                return owner.#extensionTools.generation
              },
              specs: () => this.#extensionTools.specs(),
              get: (name, generation) => this.#extensionTools.get(name, generation),
              source: (name) => this.#extensionTools.source(name),
            },
            mcp,
          )
          await this.lifecycleHook("config.before", { transition: { kind: "plugins-reload" } })
          signal.throwIfAborted()
          this.#requireOpen()
          await extensions.revalidate(signal)
          const fresh = await resolveConfigForWorkspace(
            this.#config,
            this.#cwd,
            this.options.workspaceTrusted,
            true,
          )
          if (fresh.resolution?.generation !== config.resolution?.generation)
            throw new Error("Plugin selection changed during staging; retry the reviewed reload")
          await this.#hooks.suspend()
          signal.throwIfAborted()
          this.#requireOpen()
          const old = { extensions: this.#extensions, hooks: this.#hooks, mcp: this.#mcp }
          if (this.#loop.hasPendingInteraction)
            throw new Error("Resolve the pending interaction before plugin reload")
          const retiring = Promise.allSettled([old.extensions.close(), old.hooks.close(), old.mcp.close()])
          // No await between final owner check and publication.
          this.#config = config
          this.#extensions = extensions
          this.#extensionTools = tools
          this.#hooks = hooks
          this.#mcp = mcp
          this.#inputs = inputs
          this.#registry = selectedRegistry(registry, this.options.execution)
          this.#loop.replaceIntegrations(hooks, this.#registry)
          extensions.activate(this.#extensionHost())
          published = true
          this.#contextSuffix = ""
          this.#systemPrompt = undefined
          this.#memory.invalidate()
          await retiring
          await this.lifecycleHook("config.after", { transition: { kind: "plugins-reload" } })
        } finally {
          signal.removeEventListener("abort", abortStaging)
          if (!published) await Promise.allSettled([extensions.close(), hooks.close(), mcp.close()])
        }
      }
      return {
        generation: this.#config.resolution?.generation,
        plugins: Object.entries(this.#config.plugins?.entries ?? {}).map(([id, selection]) => ({
          id,
          ...selection,
          agents: selection.enabled ? readPluginManifest(selection.root).agents : [],
        })),
        message:
          "Selected immutable versions stay pinned until explicit reload. Enabled, verified agent definitions use native child admission. Executable changes require native component fingerprint trust.",
      }
    })
  }
  async extensionsCommand(command: string): Promise<unknown> {
    const match = /^(status|disable|reload|run|complete)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(command.trim())
    if (!match)
      throw new Error(
        "Usage: /extensions status|disable ID|reload|run ID/COMMAND [ARGUMENT]|complete ID/COMMAND [ARGUMENT]",
      )
    const [, action, id, argument = ""] = match
    if (action === "reload" || action === "disable") this.#commands.assertIdle()
    if (["status", "reload"].includes(action!) ? !!id : !id)
      throw new Error("Invalid extension command arguments")
    return this.#inputOperation(async () => {
      if (action === "run")
        return { result: await this.#extensions.command(id!, argument, this.#extensionCommandSignal()) }
      if (action === "complete")
        return {
          completions: await this.#extensions.completeCommand(id!, argument, this.#extensionCommandSignal()),
        }
      if (action === "disable") {
        if (this.#providers[this.#model.provider] && this.#model.provider.startsWith(`ext_${id}_`))
          throw new Error("Select another provider before disabling its extension")
        await this.#extensions.disable(id!)
      }
      if (action === "reload") {
        const config = await resolveConfigForWorkspace(this.#config, this.#cwd, this.options.workspaceTrusted)
        const policy = (value: AgentConfig) => ({
          permissions: value.permissions,
          sandbox: value.codex.sandbox,
          sandboxConfig: value.sandbox,
          managed: value.resolution?.constraints,
        })
        if (stableValue(policy(config)) !== stableValue(policy(this.#config)))
          throw new Error(
            "Extension reload cannot change the pinned permission/sandbox policy; open a new session",
          )
        const next = new ExtensionRuntime({
          config,
          cwd: this.#cwd,
          dataDir: this.options.trustDataDirectory ?? dataDirectory(),
          disabled: this.options.disableExtensions,
          hostExtensions: this.#extensions.options.hostExtensions,
          resolveConfig: () => resolveConfigForWorkspace(config, this.#cwd, this.options.workspaceTrusted),
          sanitize: this.#sandbox.sanitize?.bind(this.#sandbox),
        })
        try {
          await next.stage(this.#extensionCommandSignal())
          const tools = next.registry(this.#extensionBase)
          if (next.providers().length || this.#extensions.providers().length)
            throw new Error(
              "Extension provider changes require a new session; the current registry is preserved",
            )
          await this.lifecycleHook("config.before", { transition: { kind: "extensions-reload" } })
          this.#requireOpen()
          const old = this.#extensions
          await old.close()
          this.#requireOpen()
          this.#extensions = next
          this.#extensionTools = tools
          next.activate(this.#extensionHost())
          this.#loop.clearApprovalCache()
          this.#systemPrompt = undefined
        } catch (error) {
          await next.close()
          throw error
        }
        await this.lifecycleHook("config.after", { transition: { kind: "extensions-reload" } })
      }
      return this.#extensions.status()
    })
  }
  #extensionCommandSignal(): AbortSignal {
    return AbortSignal.any([this.#extensionCommandAbort.signal, AbortSignal.timeout(30000)])
  }

  async hooksCommand(command: string): Promise<unknown> {
    const [action = "status", id, ...extra] = command.trim().split(/\s+/)
    if (
      extra.length ||
      !["status", "show", "reload", "disable", "receipts", "acknowledge"].includes(action) ||
      (["show", "disable", "acknowledge"].includes(action) ? !id : !!id)
    )
      throw new Error("Usage: /hooks status|show ID|reload|disable ID|receipts|acknowledge KEY")
    if (action === "reload" || action === "disable") this.#commands.assertIdle()
    return this.#inputOperation(async () => {
      if (action === "acknowledge" && id) this.#hooks.receipts.acknowledge(id)
      if (["receipts", "acknowledge"].includes(action))
        return {
          receipts: this.#hooks.receipts.list(),
          message: "Acknowledgment consumes uncertain execution; it never retries the operation.",
        }
      if (action === "disable" && id) await this.#hooks.disable(id)
      if (action === "reload") {
        await this.#hooks.reload(() =>
          this.lifecycleHook("config.before", { transition: { kind: "hooks-reload" } }),
        )
        await this.lifecycleHook("config.after", { transition: { kind: "hooks-reload" } })
      }
      const config = await resolveConfigForWorkspace(this.#config, this.#cwd, this.options.workspaceTrusted)
      const handlers = []
      for (const [name, handler] of Object.entries(config.hooks?.handlers ?? {})) {
        if (id && action === "show" && name !== id) continue
        let review: unknown
        try {
          const value = await reviewHook(config, name, this.#cwd)
          review = {
            ...value,
            trusted: hookTrusted(this.options.trustDataDirectory ?? dataDirectory(), value),
          }
        } catch (error) {
          review = { error: this.#mcp.sanitize(error instanceof Error ? error.message : "Review failed") }
        }
        handlers.push({
          id: name,
          enabled: handler.enabled,
          disabledInSession: this.#hooks.disabled(name),
          review,
        })
      }
      if (id && action === "show" && !handlers.length) throw new Error("Unknown hook handler")
      return {
        generation: this.#hooks.generation,
        handlers,
        message:
          "No handler executes during inspection. Review/trust with codesplash hooks; reload reactivates reviewed configured handlers.",
      }
    })
  }
  sandboxStatus(): string {
    return this.#sandbox.status?.() ?? "Execution backend status unavailable"
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const teamsClosed = this.#teams.close().catch((error) => {
      this.#push(
        this.#factory.event(
          "teams/cleanup",
          {},
          {
            kind: "warning",
            payload: {
              message: `Team pane cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          },
        ),
      )
    })
    const schedulerClosed = this.#scheduler.close()
    const automationClosed = schedulerClosed.then(() => this.#automation.close())
    const childrenClosed = this.#children.close()
    const commandsClosed = this.#commands.close()
    this.#inputRunner.stop()
    this.#admissionAbort?.abort(new Error("Session closed"))
    this.#ownedMaintenance.cancel()
    this.#sideQueries.cancel()
    this.#maintenanceAbort?.abort()
    this.#loop.interrupt()
    this.#extensionCommandAbort.abort()
    this.#extensions.suspend()
    await this.#hooks.suspend().catch(() => {})
    await this.#browser.close()
    await this.#language.close()
    await this.#mcp.close()
    await this.#admissionSettled?.catch(() => {})
    await this.#turnPromise?.catch(() => {})
    await this.#inputPromise?.catch(() => {})
    await this.#ownedMaintenance.close()
    await this.#sideQueries.close()
    await this.#inputRunner.settled()
    if (this.#hooksInitialized && !this.#suppressSessionEnd)
      await this.#loop.hook("session.end", AbortSignal.timeout(10000), { cwd: this.#cwd }).catch(() => {})
    await this.#hooks.close()
    await this.#extensions.close()
    await teamsClosed
    await schedulerClosed
    await automationClosed
    await childrenClosed
    await commandsClosed
    try {
      await this.#sandbox.close()
    } finally {
      this.#releaseWorktree?.()
      this.#releaseWorktree = undefined
      this.#ended = true
      this.#diagnostics.close()
      await this.#diagnostics.settled()
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
      await this.lifecycleHook("config.before", {
        transition: { kind: "model", from: this.#model.id, to: selection.model.id },
      })
      await this.#hooks.suspend()
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
      await this.lifecycleHook("config.after", { transition: { kind: "model", to: selection.model.id } })
    })
  }

  /**
   * Switches the first-party permission mode for subsequent turns. Refused mid-turn (like
   * setModel); "bypass" is refused unless the session was OPENED in bypass mode — entering
   * bypass mid-session requires the launch flag, while leaving it (and returning) is fine.
   * A valid change goes through the runtime, whose onModeChange emits the status event.
   */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.#commands.assertIdle()
    assertManagedMode(this.#config.resolution?.constraints, mode)
    this.#requireOpen()
    if (this.#turnReserved || this.#loop.isTurnActive) {
      throw new Error("Wait for the current turn before switching permission modes")
    }
    if (mode === "bypass" && !this.#bypassAllowed) {
      throw new Error("Bypass mode requires launching with --bypass-approvals")
    }
    await this.#inputOperation(async () => {
      await this.lifecycleHook("config.before", {
        transition: { kind: "permission-mode", from: this.#permissions.mode, to: mode },
      })
      await this.#hooks.suspend()
      this.#memory.invalidate()
      this.#memoryText = ""
      await this.#mcp.suspend()
      this.#loop.clearApprovalCache()
      this.#permissions.setMode(mode)
      await this.lifecycleHook("config.after", { transition: { kind: "permission-mode", to: mode } })
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
      this.#ownedMaintenance.busy
    )
      return
    if (
      ["memory_search", "memory_write", "history_read"].some((name) =>
        ["deny", "ask"].includes(this.#permissions.decide(name, undefined, name !== "memory_write").kind),
      )
    )
      return
    void this.#ownedMaintenance
      .run(
        "memory-learning",
        async (signal) => {
          if (this.#closed || this.#turnReserved || this.#loop.isTurnActive) return
          const abort = new AbortController()
          const cancel = () => abort.abort(signal.reason)
          signal.addEventListener("abort", cancel, { once: true })
          const timer = setTimeout(
            () => abort.abort(new Error("Automatic memory maintenance reached its 60-second limit")),
            60000,
          )
          try {
            const extracted = await this.#maintain("extract", abort.signal)
            abort.signal.throwIfAborted()
            this.#memoryNotice(extracted)
            if (/^[1-9][0-9]* memory candidates saved/.test(extracted)) {
              const snapshot = (await this.#memory.store(abort.signal))?.snapshot()
              if ((snapshot?.records.filter((r) => r.kind === "candidate").length ?? 0) > 1)
                this.#memoryNotice(await this.#maintain("consolidate", abort.signal))
            }
          } catch (error) {
            if (!signal.aborted)
              this.#memoryNotice(
                `Memory learning stopped: ${error instanceof Error ? error.message : String(error)}`,
              )
          } finally {
            clearTimeout(timer)
            signal.removeEventListener("abort", cancel)
          }
        },
        100,
      )
      .catch(() => {})
  }
  async #cancelLearning(): Promise<void> {
    await this.#ownedMaintenance.cancelAndSettle()
    await this.#sideQueries.cancelAndSettle()
  }

  #push(event: AgentEvent): void {
    this.#diagnostics?.event(event)
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
