import { randomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import { isPermissionMode } from "../core/config.ts"
import type { EngineDecision, EngineSession } from "../core/engine.ts"
import type { AgentEvent } from "../core/events.ts"
import { createAgentEvent } from "../core/events.ts"
import { initialAppViewState, reduceAgentEvent } from "../core/reducer.ts"
import { openEngineSession } from "../core/session/open.ts"
import { projectPromptHistory } from "../core/session/prompt-history.ts"
import { clearTransientState, usageSnapshotOf } from "../core/session/replay.ts"
import { SessionRepository } from "../core/session/repository.ts"
import { SessionController } from "../core/session-controller.ts"
import { SessionRecorder } from "../core/session-recorder.ts"
import {
  projectIdFor,
  readSessionEvents,
  type SessionHandle,
  SessionStore,
  transcriptPathFor,
} from "../core/sessions.ts"
import { CodesplashDriver } from "../engines/codesplash/engine.ts"
import type { HostExtension } from "../engines/codesplash/extensions/api.ts"
import { EventFeed } from "./event-feed.ts"
import { configuration } from "./review.ts"
import type { AgentSession, CreateAgentSessionOptions, PromptResult, SessionRequest } from "./types.ts"

export async function create(options: CreateAgentSessionOptions): Promise<AgentSession> {
  options.signal?.throwIfAborted()
  if (
    options.persistence &&
    (typeof options.persistence.root !== "string" ||
      !options.persistence.root.trim() ||
      options.persistence.root.length > 4096)
  )
    throw new Error("Persistence requires an explicit nonempty store root")
  let cwd = options.cwd
  if (options.persistence?.resume) {
    const meta = await new SessionRepository(options.persistence.root).resolve(options.persistence.resume)
    if (meta.engine !== "codesplash") throw new Error("SDK can resume only native CodeSplash sessions")
    if (cwd && (await realpath(cwd)) !== meta.projectPath)
      throw new Error("Resume cwd differs from recorded workspace; use changeDirectory after opening")
    cwd = meta.projectPath
  }
  const resolved = await configuration({ ...options, cwd })
  const { config, dataDir } = resolved
  cwd = resolved.cwd
  const extensions: HostExtension[] = [...(options.extensions ?? [])]
  if (options.tools?.length || options.providers?.length) {
    // Snapshot registration lists; callbacks themselves remain explicit application authority.
    const tools = [...(options.tools ?? [])],
      providers = [...(options.providers ?? [])]
    extensions.push({
      id: "sdk",
      factory(api) {
        for (const tool of tools) api.registerTool(tool)
        for (const provider of providers) api.registerProvider(provider)
      },
    })
  }
  let recorder: SessionRecorder | undefined,
    handle: SessionHandle | undefined,
    opened: EngineSession | undefined
  let state = clearTransientState({
    ...initialAppViewState,
    transcript: [],
    plan: [],
    usage: {},
    warnings: [],
  })
  let id: string = randomUUID(),
    firstSequence = 0
  const policy = { ...config.codex, permissionMode: config.permissions.mode }
  try {
    if (options.persistence) {
      if (!config.history.enabled) throw new Error("Persistence is disabled by configuration")
      const store = new SessionStore(options.persistence.root)
      if (options.persistence.resume) {
        const meta = await new SessionRepository(store.root).resolve(options.persistence.resume)
        handle = await store.open(meta.projectId, meta.localSessionId)
        id = meta.localSessionId
      } else {
        const now = new Date().toISOString()
        handle = await store.create({
          schemaVersion: 2,
          engine: "codesplash",
          localSessionId: id,
          projectId: projectIdFor(cwd),
          projectPath: cwd,
          createdAt: now,
          updatedAt: now,
          lastStatus: "starting",
          lastSequence: -1,
          sandbox: policy.sandbox,
          approvalPolicy: policy.approvalPolicy,
          permissionMode: policy.permissionMode,
        })
      }
      recorder = new SessionRecorder(handle)
      if (handle.meta.engine !== "codesplash" || handle.meta.projectPath !== cwd)
        throw new Error("Recorded workspace changed while opening; retry with the current session metadata")
      const { events } = await readSessionEvents(handle.directory)
      recorder.seedFromHistory(events)
      for (const event of events) state = reduceAgentEvent(state, event)
      state = clearTransientState(state)
      firstSequence = Math.max(handle.meta.lastSequence, recorder.lastSequence) + 1
      if (options.persistence.resume && !config.resolution?.provenance["permissions.mode"]?.includes("cli")) {
        const mode = state.permissionMode ?? handle.meta.permissionMode
        if (isPermissionMode(mode) && mode !== "bypass") policy.permissionMode = mode
      }
      if (
        options.persistence.resume &&
        events.some((event) => event.kind === "user.message" || event.kind === "turn.started")
      ) {
        const transcript = Bun.file(transcriptPathFor(handle))
        if (!(await transcript.exists()) || transcript.size === 0) {
          const warning = createAgentEvent(
            { engine: "codesplash", localSessionId: id, sequence: firstSequence++ },
            {
              kind: "warning",
              payload: {
                message: "Recorded conversation has no native transcript; model context starts fresh.",
              },
            },
          )
          recorder.record(warning)
          state = reduceAgentEvent(state, warning)
        }
      }
      recorder.recordPermissionMode(policy.permissionMode)
    }
    const session = await openEngineSession(
      new CodesplashDriver({ config, hostExtensions: extensions }),
      {
        cwd,
        localSessionId: id,
        model: options.model,
        policy,
        firstSequence,
        initialUsage: usageSnapshotOf(state),
        sessionState: handle?.state,
        nativeTranscriptPath: handle ? transcriptPathFor(handle) : undefined,
        promptHistory: options.persistence
          ? await projectPromptHistory(options.persistence.root, projectIdFor(cwd), "codesplash")
          : undefined,
        workspaceTrusted: options.workspaceTrusted ?? false,
        trustDataDirectory: dataDir,
        disableExtensions: options.disableExtensions,
        interactiveExtensions: options.interactive ?? false,
        resuming: !!options.persistence?.resume,
        flushSessionEvents: async () => {
          await recorder?.flush()
          if (recorder?.failure) throw recorder.failure
        },
      },
      recorder,
      options.signal,
    )
    opened = session
    const queue = session.inputQueue
    const snapshot = queue?.snapshot()
    if (
      snapshot?.paused &&
      snapshot.items.every((item) => ["completed", "failed", "cancelled"].includes(item.status))
    )
      queue?.resume(snapshot.revision)
    return own(session, options, recorder, state, handle?.directory)
  } catch (error) {
    await opened?.close()
    await recorder?.close("failed")
    throw error
  }
}

function own(
  session: ConstructorParameters<typeof SessionController>[0],
  options: CreateAgentSessionOptions,
  recorder: SessionRecorder | undefined,
  initialState: SessionController["state"],
  historyDirectory?: string,
): AgentSession {
  const listeners = new Set<(event: AgentEvent) => void>(),
    feeds = new Set<EventFeed>()
  const stateListeners = new Set<() => void>()
  let waitingInputs = 0
  const lifetime = new AbortController(),
    requests = new Map<string, AbortController>()
  let closing: Promise<void> | undefined
  const safe = (callback: () => void) => {
    try {
      const result: unknown = callback()
      if (result && typeof (result as PromiseLike<unknown>).then === "function")
        void Promise.resolve(result).catch(() => {})
    } catch {
      /* Application observers do not own the event pump. */
    }
  }
  const answer = async (request: SessionRequest) => {
    if (options.respond === "manual" || lifetime.signal.aborted) return
    const owner = new AbortController()
    requests.set(request.id, owner)
    const signal = AbortSignal.any([lifetime.signal, owner.signal, AbortSignal.timeout(30000)])
    const fallback: EngineDecision = { choice: request.requestKind === "approval" ? "decline" : "cancel" }
    let onAbort: () => void = () => {}
    try {
      const cancelled = new Promise<EngineDecision>((resolve) => {
        onAbort = () => resolve(fallback)
        signal.addEventListener("abort", onAbort, { once: true })
      })
      const decision = await Promise.race([
        options.respond
          ? Promise.resolve()
              .then(() =>
                typeof options.respond === "function"
                  ? options.respond(structuredClone(request), signal)
                  : fallback,
              )
              .catch(() => fallback)
          : Promise.resolve(fallback),
        cancelled,
      ])
      if (!lifetime.signal.aborted && !owner.signal.aborted)
        await session.resolveRequest(request.id, decision)
    } catch {
      // Invalid application decisions must not strand the foreground interaction.
      if (!lifetime.signal.aborted && !owner.signal.aborted) {
        try {
          await session.resolveRequest(request.id, fallback)
        } catch {
          /* Already settled. */
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort)
      requests.delete(request.id)
      owner.abort()
    }
  }
  const controller = new SessionController(session, {
    initialState,
    onEvent(event) {
      recorder?.record(event)
      if (event.kind === "request.opened") void answer(event.payload)
      if (event.kind === "request.resolved") requests.get(event.payload.id)?.abort()
      for (const listener of listeners) safe(() => listener(structuredClone(event)))
      for (const feed of feeds) feed.push(event)
    },
  })
  if (options.onEvent) listeners.add(options.onEvent)
  controller.setExtensionComposer(
    options.onComposer
      ? (text) => {
          try {
            return options.onComposer?.(text) === true
          } catch {
            return false
          }
        }
      : undefined,
  )
  const flush = async () => {
    await recorder?.flush()
    if (recorder?.failure) throw recorder.failure
  }
  const close = (): Promise<void> => {
    closing ??= (async () => {
      lifetime.abort(new Error("Session closed"))
      options.signal?.removeEventListener("abort", aborted)
      try {
        await controller.close()
      } finally {
        for (const feed of feeds) feed.finish()
        listeners.clear()
        for (const dispose of stateListeners) dispose()
        stateListeners.clear()
        await recorder?.close()
      }
      if (recorder?.failure) throw recorder.failure
    })()
    return closing
  }
  const aborted = () => {
    void close().catch(() => {})
  }
  options.signal?.addEventListener("abort", aborted, { once: true })
  controller.start()
  const waitForInput = (inputId: string, signal?: AbortSignal): Promise<PromptResult> =>
    new Promise((resolve, reject) => {
      if (waitingInputs >= 128) {
        reject(new Error("SDK input wait limit exceeded"))
        return
      }
      waitingInputs++
      let unsubscribe = () => {},
        settled = false
      const cleanup = () => {
        waitingInputs--
        unsubscribe()
        signal?.removeEventListener("abort", cancel)
        lifetime.signal.removeEventListener("abort", cancel)
      }
      const cancel = () => {
        if (settled) return
        settled = true
        cleanup()
        reject(signal?.reason ?? lifetime.signal.reason ?? new Error("Wait cancelled"))
      }
      const check = () => {
        if (settled) return
        if (signal?.aborted || lifetime.signal.aborted) {
          cancel()
          return
        }
        const item = session.inputQueue?.snapshot().items.find((item) => item.id === inputId)
        if (!item) {
          settled = true
          cleanup()
          reject(new Error("Unknown input ID"))
          return
        }
        if (["completed", "failed", "cancelled", "blocked", "execution-uncertain"].includes(item.status)) {
          settled = true
          cleanup()
          // Let the controller consume the already-enqueued final turn events before exposing state.
          setTimeout(() => resolve({ id: inputId, status: item.status }), 0)
        }
      }
      signal?.addEventListener("abort", cancel, { once: true })
      lifetime.signal.addEventListener("abort", cancel, { once: true })
      unsubscribe = controller.subscribe(check)
      if (settled) unsubscribe()
    })
  const api: AgentSession = {
    id: session.localSessionId,
    historyDirectory,
    directoryStatus: () => {
      if (lifetime.signal.aborted || !session.directoryStatus) throw new Error("Directory status unavailable")
      return session.directoryStatus()
    },
    sandboxStatus: () => {
      if (lifetime.signal.aborted || !session.sandboxStatus) throw new Error("Sandbox status unavailable")
      return session.sandboxStatus()
    },
    permissionRules: () => {
      if (lifetime.signal.aborted || !session.permissionRules) throw new Error("Permission rules unavailable")
      return session.permissionRules()
    },
    setPermissionMode: async (mode) => {
      if (lifetime.signal.aborted || !session.setPermissionMode)
        throw new Error("Permission mode unavailable")
      await session.setPermissionMode(mode)
    },
    editPermissionRule: async (command) => {
      if (lifetime.signal.aborted || !session.editPermissionRule)
        throw new Error("Permission editing unavailable")
      await session.editPermissionRule(command)
    },
    inputs: Object.fromEntries(
      ["pause", "resume", "edit", "move", "remove", "retry", "clearCompleted"].map((name) => [
        name,
        (...args: unknown[]) => {
          if (lifetime.signal.aborted) throw new Error("Session closed")
          const queue = session.inputQueue
          if (!queue) throw new Error("Input queue unavailable")
          return (queue[name as keyof typeof queue] as (...args: unknown[]) => unknown).apply(queue, args)
        },
      ]),
    ) as AgentSession["inputs"],
    get state() {
      return structuredClone(controller.state)
    },
    get usage() {
      return structuredClone(controller.state.usage)
    },
    get queue() {
      if (!session.inputQueue) throw new Error("Input queue unavailable")
      return session.inputQueue.snapshot()
    },
    subscribe(listener) {
      if (lifetime.signal.aborted) throw new Error("Session closed")
      if (listeners.size >= 128) throw new Error("SDK listener limit exceeded")
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    subscribeState(listener) {
      if (lifetime.signal.aborted) throw new Error("Session closed")
      if (stateListeners.size >= 128) throw new Error("SDK state listener limit exceeded")
      const unsubscribe = controller.subscribe((state) => safe(() => listener(structuredClone(state))))
      const dispose = () => {
        unsubscribe()
        stateListeners.delete(dispose)
      }
      stateListeners.add(dispose)
      return dispose
    },
    events() {
      if (lifetime.signal.aborted) throw new Error("Session closed")
      if (feeds.size >= 8) throw new Error("SDK event feed limit exceeded")
      const feed = new EventFeed(() => feeds.delete(feed))
      feeds.add(feed)
      return feed
    },
    async prompt(input, waitOptions) {
      waitOptions?.signal?.throwIfAborted()
      if (session.inputQueue?.snapshot().paused)
        throw new Error("Input queue is paused; review it and call inputs.resume with its revision")
      const ack = await controller.submit(typeof input === "string" ? { text: input } : input)
      if (!ack) throw new Error("Prompt is empty")
      return waitForInput(ack.id, waitOptions?.signal)
    },
    waitForInput,
    flush,
    close,
    interrupt: () => session.interrupt(),
    submit: controller.submit.bind(controller),
    resolveRequest: controller.resolveRequest.bind(controller),
    listModels: controller.listModels.bind(controller),
    setModel: controller.setModel.bind(controller),
    inspectContext: controller.inspectContext.bind(controller),
    compact: controller.compact.bind(controller),
    tasks: controller.tasks.bind(controller),
    teams: controller.teams.bind(controller),
    schedules: controller.schedules.bind(controller),
    goals: controller.goals.bind(controller),
    workflows: controller.workflows.bind(controller),
    worktrees: controller.worktrees.bind(controller),
    peers: controller.peers.bind(controller),
    spawnAgent: controller.spawnAgent.bind(controller),
    agentDefinitions: controller.agentDefinitions.bind(controller),
    monitorTask: controller.monitorTask.bind(controller),
    runCommand: controller.runCommand.bind(controller),
    mcpCommand: controller.mcpCommand.bind(controller),
    hooksCommand: controller.hooksCommand.bind(controller),
    extensionsCommand: controller.extensionsCommand.bind(controller),
    pluginsCommand: controller.pluginsCommand.bind(controller),
    contextResources: controller.contextResources.bind(controller),
    memoryCommand: controller.memoryCommand.bind(controller),
    sessionPresentation: controller.sessionPresentation.bind(controller),
    sessionRecovery: controller.sessionRecovery.bind(controller),
    changeDirectory: controller.changeDirectory.bind(controller),
    exportHistory: controller.exportHistory.bind(controller),
  }
  if (options.signal?.aborted) aborted()
  return api
}
