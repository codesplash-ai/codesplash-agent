import { createCliRenderer, type KittyKeyboardOptions, type ThemeMode } from "@opentui/core"
import { createRoot } from "@opentui/react"
import type {
  AppViewState,
  ProjectPreflight,
  SessionMeta,
  SessionPolicy,
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
} from "../core/index.ts"
import { CodexDriver } from "../engines/codex/index.ts"
import { brandThemes } from "./brand.ts"
import { type CodexSessionAction, CodexSessionApp } from "./codex-session.tsx"
import { renderFullAccessConfirmation } from "./full-access-confirmation.tsx"

export type CodexSessionRunOptions = {
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
  let initialState = freshState()
  let firstSequence = 0

  if (historyEnabled) {
    const store = options.store ?? new SessionStore()
    if (options.resume) {
      const handle = await store.open(projectId, localSessionId)
      const { events } = await readSessionEvents(handle.directory)
      recorder = new SessionRecorder(handle)
      historyLocation = handle.directory
      recorder.seedFromHistory(events)
      for (const event of events) initialState = reduceAgentEvent(initialState, event)
      initialState = clearTransientState(initialState)
      firstSequence = Math.max(handle.meta.lastSequence, recorder.lastSequence) + 1
    } else {
      const now = new Date().toISOString()
      const handle = await store.create({
        schemaVersion: 1,
        engine: "codex",
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
      historyLocation = handle.directory
    }
  }

  try {
    while (true) {
      const driver = new CodexDriver()
      const open = (withNativeSessionId: string | undefined) =>
        driver.openSession({
          cwd: project.cwd,
          localSessionId,
          nativeSessionId: withNativeSessionId,
          policy,
          firstSequence,
          knownTurnIds: recorder?.knownTurnIds ?? [],
        })

      let session: Awaited<ReturnType<typeof open>>
      try {
        session = await open(nativeSessionId)
      } catch (error) {
        if (!nativeSessionId) throw error
        // The provider thread is gone (expired, deleted, or incompatible). Keep the
        // replayed transcript, surface the loss, and continue on a fresh thread.
        const warning = createAgentEvent(
          { engine: "codex", localSessionId, sequence: firstSequence },
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
        const action = await renderCodexSession(controller, project, themePreference, policy, historyLocation)
        if (action !== "reconnect") return action
      } finally {
        unregisterCleanup()
        await controller.close()
        await recorder?.flush()
      }

      // Reconnect: keep the transcript and continue the event log monotonically.
      initialState = clearTransientState(controller.state)
      firstSequence = Math.max(firstSequence, controller.state.lastSequence + 1)
    }
  } finally {
    await recorder?.close("closed")
  }
}

function freshState(): AppViewState {
  return { ...initialAppViewState, transcript: [], plan: [], usage: {}, warnings: [] }
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
        onAction={finish}
      />,
    )
  })
}
