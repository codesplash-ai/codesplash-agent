import { createCliRenderer, type KittyKeyboardOptions, type ThemeMode } from "@opentui/core"
import { createRoot } from "@opentui/react"
import type {
  AgentConfig,
  AppViewState,
  EngineDriver,
  OpenSessionOptions,
  ProjectPreflight,
  SessionHandle,
  SessionMeta,
  SessionPolicy,
  SessionUsageSnapshot,
  ThemePreference,
} from "../core/index.ts"
import {
  createAgentEvent,
  defaultSessionPolicy,
  initialAppViewState,
  projectIdFor,
  readSessionEvents,
  reduceAgentEvent,
  registerCleanup,
  SessionController,
  SessionRecorder,
  SessionStore,
  transcriptPathFor,
} from "../core/index.ts"
import { CodesplashDriver } from "../engines/codesplash/index.ts"
import { CodexDriver } from "../engines/codex/index.ts"
import { brandThemes } from "./brand.ts"
import { type CodexSessionAction, CodexSessionApp } from "./codex-session.tsx"
import { renderFullAccessConfirmation } from "./full-access-confirmation.tsx"

/** Engines that run inside the harness session screen (Claude hands off to its own CLI). */
export type HarnessEngineId = "codex" | "codesplash"

/**
 * The loaded harness config (with any `-c` overrides applied) must reach the codesplash driver:
 * without it the engine reloads config from disk and silently drops the per-invocation overrides.
 */
export function createEngineDriver(engine: HarnessEngineId, config?: AgentConfig): EngineDriver {
  if (engine === "codesplash") return new CodesplashDriver(config ? { config } : {})
  return new CodexDriver()
}

/**
 * Where the codesplash engine persists provider-native history: transcript.jsonl next to the
 * session's events.jsonl. Delegates to the session store's own layout helper so the TUI never
 * assumes the directory shape itself.
 */
export function sessionTranscriptPath(sessionDirectory: string): string {
  return transcriptPathFor({ directory: sessionDirectory })
}

export type CodexSessionRunOptions = {
  /** Engine to run through the shared controller/recorder/session-screen flow. */
  engine?: HarnessEngineId
  /** Loaded harness config (with `-c` overrides applied); handed to the engine driver. */
  config?: AgentConfig
  policy?: SessionPolicy
  /** When false (`--no-history` or config opt-out), nothing is written to disk. */
  historyEnabled?: boolean
  /** Resume this persisted session instead of starting a new one. */
  resume?: SessionMeta
  /** Session store override for tests. */
  store?: SessionStore
}

/** How the session screen ended: "new" and "resume-picker" ask the caller to reopen. */
export type CodexRunOutcome = "home" | "quit" | "new" | "resume-picker"

/** Preserve modifiers on Enter so the composer can distinguish Shift+Enter from Enter. */
export const codexKeyboardOptions = {
  disambiguate: true,
  alternateKeys: true,
  allKeysAsEscapes: true,
} satisfies KittyKeyboardOptions

export async function runCodexSession(
  project: ProjectPreflight,
  themePreference: ThemePreference,
  options: CodexSessionRunOptions = {},
): Promise<CodexRunOutcome> {
  const engine = options.engine ?? "codex"
  const policy = options.policy ?? defaultSessionPolicy
  const historyEnabled = options.historyEnabled ?? true

  // Full access is never sticky: every session open re-confirms, resume included.
  if (policy.sandbox === "danger-full-access") {
    const confirmed = await renderFullAccessConfirmation(themePreference)
    if (!confirmed) return "home"
  }

  const localSessionId = options.resume?.localSessionId ?? crypto.randomUUID()
  const projectId = projectIdFor(project.cwd)
  let nativeSessionId = options.resume?.nativeSessionId

  let recorder: SessionRecorder | undefined
  let historyLocation: string | undefined
  let nativeTranscriptPath: string | undefined
  let initialState = freshState()
  let firstSequence = 0

  if (historyEnabled) {
    const store = options.store ?? new SessionStore()
    let handle: SessionHandle
    if (options.resume) {
      handle = await store.open(projectId, localSessionId)
      const { events } = await readSessionEvents(handle.directory)
      recorder = new SessionRecorder(handle)
      recorder.seedFromHistory(events)
      for (const event of events) initialState = reduceAgentEvent(initialState, event)
      initialState = clearTransientState(initialState)
      firstSequence = Math.max(handle.meta.lastSequence, recorder.lastSequence) + 1

      // A codesplash session whose transcript never made it to disk (recorded before transcripts
      // existed, or every append failed) replays the visible conversation while the model starts
      // fresh — surface the context loss instead of silently pretending the model remembers.
      const hadConversation = events.some(
        (event) => event.kind === "user.message" || event.kind === "turn.started",
      )
      if (engine === "codesplash" && hadConversation) {
        const transcriptFile = Bun.file(sessionTranscriptPath(handle.directory))
        if (!(await transcriptFile.exists()) || transcriptFile.size === 0) {
          const warning = createAgentEvent(
            { engine, localSessionId, sequence: firstSequence },
            {
              kind: "warning",
              payload: {
                message:
                  "Resumed without a saved model transcript — the visible transcript is kept, but the model no longer remembers this conversation.",
              },
            },
          )
          recorder.record(warning)
          initialState = reduceAgentEvent(initialState, warning)
          firstSequence += 1
        }
      }
    } else {
      const now = new Date().toISOString()
      handle = await store.create({
        schemaVersion: 1,
        engine,
        localSessionId,
        projectPath: project.cwd,
        projectId,
        createdAt: now,
        updatedAt: now,
        lastStatus: "starting",
        lastSequence: -1,
        sandbox: policy.sandbox,
        approvalPolicy: policy.approvalPolicy,
      })
      recorder = new SessionRecorder(handle)
    }
    historyLocation = handle.directory
    // The codesplash engine owns a provider-native transcript beside the event log: passing the
    // path makes it reseed the model's history on open (resume and Ctrl+R reconnect alike) and
    // append each finished turn.
    if (engine === "codesplash") nativeTranscriptPath = sessionTranscriptPath(handle.directory)
  }

  // CodeSplash resumes from its local transcript file, not a remote provider thread: thread
  // reconciliation (nativeSessionId, knownTurnIds, the fresh-thread fallback) is skipped
  // entirely and the engine reseeds from nativeTranscriptPath instead.
  const usesProviderThread = engine !== "codesplash"

  try {
    while (true) {
      const driver = createEngineDriver(engine, options.config)
      const open = (withNativeSessionId: string | undefined) => {
        const openOptions: OpenSessionOptions = {
          cwd: project.cwd,
          localSessionId,
          nativeSessionId: usesProviderThread ? withNativeSessionId : undefined,
          policy,
          firstSequence,
          knownTurnIds: usesProviderThread ? (recorder?.knownTurnIds ?? []) : [],
          nativeTranscriptPath,
          // Resume/reconnect: the engine continues the replayed cumulative usage so the /usage
          // overlay and recorded events never drop back toward zero after the next turn.
          initialUsage: engine === "codesplash" ? usageSnapshotOf(initialState) : undefined,
        }
        return driver.openSession(openOptions)
      }

      let session: Awaited<ReturnType<typeof open>>
      try {
        session = await open(nativeSessionId)
      } catch (error) {
        if (!usesProviderThread || !nativeSessionId) throw error
        // The provider thread is gone (expired, deleted, or incompatible). Keep the
        // replayed transcript, surface the loss, and continue on a fresh thread.
        const warning = createAgentEvent(
          { engine, localSessionId, sequence: firstSequence },
          {
            kind: "warning",
            payload: {
              message: `Could not resume the provider thread; starting a new one. ${describeError(error)}`,
            },
          },
        )
        recorder?.record(warning)
        initialState = reduceAgentEvent(initialState, warning)
        firstSequence += 1
        nativeSessionId = undefined
        session = await open(undefined)
      }

      if (session.nativeSessionId && session.nativeSessionId !== nativeSessionId) {
        nativeSessionId = session.nativeSessionId
        recorder?.recordNativeSessionId(session.nativeSessionId)
      }

      const controller = new SessionController(session, {
        initialState,
        onEvent: recorder?.record,
      })
      // An external SIGINT/SIGTERM closes the live session and flushes history; the
      // interrupted status keeps the session resumable from the picker.
      const unregisterCleanup = registerCleanup(async () => {
        await controller.close()
        await recorder?.close()
      })

      try {
        const action = await renderCodexSession(
          controller,
          project,
          themePreference,
          policy,
          historyLocation,
          engine,
        )
        if (action !== "reconnect") return action
      } finally {
        unregisterCleanup()
        await controller.close()
        await recorder?.flush()
      }

      // Reconnect: keep the transcript and continue the event log monotonically.
      initialState = clearTransientState(controller.state)
      firstSequence = Math.max(firstSequence, controller.state.lastSequence + 1)

      // A CodeSplash session without a transcript on disk (history off) has nothing to reseed
      // the model from, so a reopened session replays the TUI transcript while the model starts
      // fresh. The session screen suppresses the reconnect affordance in that case; surface the
      // context loss if the action arrives anyway. With a transcript the engine reseeds the
      // model's history itself and no warning is needed.
      if (engine === "codesplash" && nativeTranscriptPath === undefined) {
        const warning = createAgentEvent(
          { engine, localSessionId, sequence: firstSequence },
          {
            kind: "warning",
            payload: {
              message:
                "Reconnected on a fresh model thread — the transcript is kept, but the model no longer remembers this conversation.",
            },
          },
        )
        recorder?.record(warning)
        initialState = reduceAgentEvent(initialState, warning)
        firstSequence += 1
      }
    }
  } finally {
    await recorder?.close("closed")
  }
}

function freshState(): AppViewState {
  return { ...initialAppViewState, transcript: [], plan: [], usage: {}, warnings: [] }
}

/** Cumulative usage from replayed state, or undefined when the session recorded none. */
export function usageSnapshotOf(state: AppViewState): SessionUsageSnapshot | undefined {
  const { inputTokens, cachedInputTokens, outputTokens, estimatedCostUsd, hasUnpricedUsage } = state.usage
  const snapshot: SessionUsageSnapshot = {}
  if (inputTokens !== undefined) snapshot.inputTokens = inputTokens
  if (cachedInputTokens !== undefined) snapshot.cachedInputTokens = cachedInputTokens
  if (outputTokens !== undefined) snapshot.outputTokens = outputTokens
  if (estimatedCostUsd !== undefined) snapshot.estimatedCostUsd = estimatedCostUsd
  if (hasUnpricedUsage !== undefined) snapshot.hasUnpricedUsage = hasUnpricedUsage
  return Object.keys(snapshot).length > 0 ? snapshot : undefined
}

/** Replayed state describes a past run; pending requests and turn state do not carry over. */
function clearTransientState(state: AppViewState): AppViewState {
  return {
    ...state,
    sessionStatus: "starting",
    turnStatus: "idle",
    pendingRequest: undefined,
    error: undefined,
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function renderCodexSession(
  controller: SessionController,
  project: ProjectPreflight,
  themePreference: ThemePreference,
  policy: SessionPolicy,
  historyLocation: string | undefined,
  engine: HarnessEngineId,
): Promise<CodexSessionAction> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 60,
    useKittyKeyboard: codexKeyboardOptions,
  })
  const detectedTheme: ThemeMode = (await renderer.waitForThemeMode(300)) ?? "dark"
  const theme = themePreference === "system" ? detectedTheme : themePreference
  const unregisterRenderer = registerCleanup(() => renderer.destroy())

  return new Promise((resolve) => {
    let settled = false
    const finish = (action: CodexSessionAction) => {
      if (settled) return
      settled = true
      unregisterRenderer()
      renderer.destroy()
      resolve(action)
    }

    createRoot(renderer).render(
      <CodexSessionApp
        controller={controller}
        palette={brandThemes[theme]}
        project={project}
        policy={policy}
        historyLocation={historyLocation}
        engine={engine}
        onAction={finish}
      />,
    )
  })
}
