import type { ContextInspection, EngineDecision, EngineModel, EngineSession, UserInput } from "./engine.ts"
import type { AgentEvent } from "./events.ts"
import type { AppViewState } from "./reducer.ts"
import { initialAppViewState, reduceAgentEvent } from "./reducer.ts"
import type { InputAcknowledgment, InputIntent } from "./session/input-queue.ts"
import { emptyOutcomes, localRecap } from "./session/outcomes.ts"
import type { PresentationRequest } from "./session/presentation.ts"

export type SessionStateListener = (state: AppViewState) => void

export type SessionControllerOptions = {
  /** Synchronous per-event tap invoked before reduction (e.g. the session recorder). */
  onEvent?: (event: AgentEvent) => void
  /** Starting view state, e.g. a transcript replayed from the persisted event log. */
  initialState?: AppViewState
}

/** Owns the engine event stream and exposes only provider-independent view state to renderers. */
export class SessionController {
  readonly #listeners = new Set<SessionStateListener>()
  readonly #session: EngineSession
  readonly #onEvent: ((event: AgentEvent) => void) | undefined
  #state: AppViewState
  #consumePromise: Promise<void> | undefined
  #notificationTimer: ReturnType<typeof setTimeout> | undefined
  #closed = false
  #unsubscribeQueue: (() => void) | undefined

  constructor(session: EngineSession, options: SessionControllerOptions = {}) {
    this.#session = session
    this.#onEvent = options.onEvent
    this.#state = options.initialState ?? freshInitialState()
    if (session.inputQueue) {
      this.#state = { ...this.#state, inputQueue: session.inputQueue.snapshot() }
      this.#unsubscribeQueue = session.inputQueue.subscribe(() => {
        this.#state = { ...this.#state, inputQueue: session.inputQueue?.snapshot() }
        this.#flushNotify()
      })
    }
  }

  get state(): AppViewState {
    return this.#state
  }

  subscribe(listener: SessionStateListener): () => void {
    this.#listeners.add(listener)
    listener(this.#state)
    return () => this.#listeners.delete(listener)
  }

  start(): void {
    if (this.#consumePromise) return
    this.#consumePromise = this.#consume()
  }

  get inputQueue() {
    return this.#session.inputQueue
  }
  async send(input: UserInput): Promise<void> {
    await this.submit(input)
  }
  async submit(
    input: UserInput,
    intent: InputIntent = "follow-up",
    submissionId?: string,
  ): Promise<InputAcknowledgment | undefined> {
    if (this.#closed) throw new Error("Session is closed")
    if (!input.text.trim() && !input.images?.length && !input.files?.length) return
    if (this.#session.submit) return this.#session.submit(input, intent, submissionId)
    if (intent !== "follow-up") throw new Error("This engine does not support steering or interjection")
    if (this.#state.pendingRequest) throw new Error("Resolve the pending request before sending a message")
    if (this.#state.turnStatus === "running") throw new Error("Wait for the current turn or interrupt it")
    await this.#session.send(input)
  }

  async resolveRequest(requestId: string, decision: EngineDecision): Promise<void> {
    if (this.#closed) throw new Error("Session is closed")
    if (!this.#session.capabilities.approvals) throw new Error("This engine cannot answer approval requests")
    await this.#session.resolveRequest(requestId, decision)
  }

  async interrupt(): Promise<void> {
    if (this.#closed || this.#state.turnStatus !== "running") return
    if (!this.#session.capabilities.interrupt) throw new Error("This engine cannot interrupt a running turn")
    await this.#session.interrupt()
  }

  get canSwitchModels(): boolean {
    return typeof this.#session.setModel === "function" && typeof this.#session.listModels === "function"
  }

  async listModels(): Promise<EngineModel[]> {
    if (this.#closed) throw new Error("Session is closed")
    if (!this.#session.listModels) throw new Error("This engine does not list models")
    return this.#session.listModels()
  }

  async setModel(model: string): Promise<void> {
    if (this.#closed) throw new Error("Session is closed")
    if (!this.#session.setModel) throw new Error("This engine cannot switch models")
    if (this.#state.turnStatus === "running")
      throw new Error("Wait for the current turn before switching models")
    await this.#session.setModel(model)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#unsubscribeQueue?.()
    await this.#session.close()
    await this.#consumePromise
  }

  async tasks(request: import("./orchestration/contracts.ts").TaskRequest): Promise<unknown> {
    if (this.#closed || !this.#session.tasks) throw new Error("Tasks are unavailable for this engine")
    return this.#session.tasks(request)
  }
  async spawnAgent(
    input: import("../engines/codesplash/orchestration/children.ts").SpawnAgentInput,
  ): Promise<unknown> {
    if (this.#closed || !this.#session.spawnAgent)
      throw new Error("Child agents are unavailable for this engine")
    return this.#session.spawnAgent(input)
  }
  async teams(input: import("./orchestration/teams.ts").TeamRequest): Promise<unknown> {
    if (this.#closed || !this.#session.teams) throw new Error("Team controls unavailable")
    return this.#session.teams(input)
  }
  async schedules(input: import("./orchestration/scheduler.ts").ScheduleRequest): Promise<unknown> {
    if (this.#closed || !this.#session.schedules) throw new Error("Scheduler controls unavailable")
    return this.#session.schedules(input)
  }
  async goals(input: import("./orchestration/automation.ts").GoalRequest): Promise<unknown> {
    if (this.#closed || !this.#session.goals) throw new Error("Goal controls unavailable")
    return this.#session.goals(input)
  }
  async workflows(input: import("./orchestration/automation.ts").WorkflowRequest): Promise<unknown> {
    if (this.#closed || !this.#session.workflows) throw new Error("Workflow controls unavailable")
    return this.#session.workflows(input)
  }
  async worktrees(input: import("./orchestration/worktrees.ts").WorktreeRequest): Promise<unknown> {
    if (this.#closed || !this.#session.worktrees) throw new Error("Worktree controls unavailable")
    return this.#session.worktrees(input)
  }
  async peers(input: import("./orchestration/peers.ts").PeerRequest): Promise<unknown> {
    if (this.#closed || !this.#session.peers) throw new Error("Peer controls unavailable")
    return this.#session.peers(input)
  }
  async agentDefinitions(): Promise<unknown> {
    if (this.#closed || !this.#session.agentDefinitions)
      throw new Error("Agent definitions are unavailable for this engine")
    return this.#session.agentDefinitions()
  }
  monitorTask(id: string, cursor = 0) {
    if (this.#closed || !this.#session.monitorTask) throw new Error("Task monitoring is unavailable")
    return this.#session.monitorTask(id, cursor)
  }
  async runCommand(
    command: string,
    includeContext = false,
    snapshot?: import("../engines/codesplash/orchestration/shell-state.ts").ShellSelection,
  ): Promise<unknown> {
    if (this.#closed || !this.#session.runCommand) throw new Error("Native commands are unavailable")
    return this.#session.runCommand(command, includeContext, snapshot)
  }
  async mcpCommand(command: string): Promise<unknown> {
    if (this.#closed || !this.#session.mcpCommand)
      throw new Error("MCP management is unavailable for this engine")
    return this.#session.mcpCommand(command)
  }
  async pluginsCommand(command: string): Promise<unknown> {
    if (this.#closed || !this.#session.pluginsCommand) throw new Error("Plugin management is unavailable")
    return this.#session.pluginsCommand(command)
  }
  async extensionsCommand(command: string): Promise<unknown> {
    if (this.#closed || !this.#session.extensionsCommand)
      throw new Error("Extensions are unavailable for this engine")
    return this.#session.extensionsCommand(command)
  }
  setExtensionComposer(callback?: (text: string) => boolean): void {
    this.#session.setExtensionComposer?.(callback)
  }
  async hooksCommand(command: string): Promise<unknown> {
    if (this.#closed || !this.#session.hooksCommand)
      throw new Error("Hook management is unavailable for this engine")
    return this.#session.hooksCommand(command)
  }

  async contextResources(kind: "skill" | "command") {
    if (this.#closed || !this.#session.contextResources)
      throw new Error("Context resources are unavailable for this engine")
    return this.#session.contextResources(kind)
  }

  async completeFileMention(query: string) {
    if (this.#closed || !this.#session.completeFileMention)
      throw new Error("File completion is unavailable for this engine")
    return this.#session.completeFileMention(query)
  }

  async setPersonality(personality: string) {
    if (this.#closed || !this.#session.setPersonality)
      throw new Error("Personality is unavailable for this engine")
    return this.#session.setPersonality(personality)
  }

  async memoryCommand(command: string) {
    if (this.#closed || !this.#session.memoryCommand) throw new Error("Memory is unavailable for this engine")
    return this.#session.memoryCommand(command)
  }

  async createSkill(name: string, write = false) {
    if (this.#closed || !this.#session.createSkill)
      throw new Error("Skill creation is unavailable for this engine")
    return this.#session.createSkill(name, write)
  }

  async sessionPresentation(request: PresentationRequest): Promise<unknown> {
    if (this.#closed) throw new Error("Session is closed")
    const outcomes = this.#state.outcomes ?? emptyOutcomes()
    if (request.action === "recap" && !request.generate) return localRecap(outcomes, request.since)
    if (request.action === "outcomes")
      return {
        cursor: outcomes.cursor,
        dropped: outcomes.dropped,
        rows: outcomes.rows.filter((row) => row.lastSequence > (request.since ?? -1)),
      }
    if (!this.#session.sessionPresentation)
      throw new Error("Session presentation controls are unavailable for this engine")
    return this.#session.sessionPresentation(request)
  }

  async exportHistory(options: import("./session/portable.ts").ExportOptions) {
    if (this.#closed || !this.#session.exportHistory)
      throw new Error("Portable export is unavailable for this engine")
    return this.#session.exportHistory(options)
  }
  directoryStatus() {
    return this.#session.directoryStatus?.()
  }
  async changeDirectory(request: import("./session/working-directory.ts").DirectoryRequest) {
    if (this.#closed) throw new Error("Session is closed")
    if (!this.#session.changeDirectory)
      throw new Error(
        "This engine cannot change a live working directory; use /new and select the destination for a new session, or resume through its owning CLI",
      )
    return this.#session.changeDirectory(request)
  }
  async sessionRecovery(request: import("./session/recovery-contract.ts").RecoveryRequest) {
    if (this.#closed || !this.#session.sessionRecovery)
      throw new Error("Session recovery is unavailable for this engine")
    return this.#session.sessionRecovery(request)
  }

  async inspectContext(): Promise<ContextInspection> {
    if (this.#closed) throw new Error("Session is closed")
    if (!this.#session.inspectContext) throw new Error("This engine does not support context inspection")
    return this.#session.inspectContext()
  }

  async compact(instructions?: string): Promise<void> {
    if (this.#closed) throw new Error("Session is closed")
    if (this.#state.pendingRequest || this.#state.turnStatus === "running")
      throw new Error("Wait for the current turn before compacting")
    if (!this.#session.compact) throw new Error("This engine does not support context compaction")
    await this.#session.compact(instructions)
  }

  async #consume(): Promise<void> {
    try {
      for await (const event of this.#session.events) {
        this.#onEvent?.(event)
        this.#state = reduceAgentEvent(this.#state, event)
        if (event.kind === "message.delta" || event.kind === "reasoning.delta") this.#scheduleNotify()
        else this.#flushNotify()
      }
      this.#flushNotify()
    } catch (error) {
      this.#state = {
        ...this.#state,
        sessionStatus: "failed",
        error: {
          message: error instanceof Error ? error.message : String(error),
          recoverable: false,
        },
      }
      this.#flushNotify()
    }
  }

  #scheduleNotify(): void {
    if (this.#notificationTimer) return
    this.#notificationTimer = setTimeout(() => {
      this.#notificationTimer = undefined
      this.#notify()
    }, 50)
  }

  #flushNotify(): void {
    if (this.#notificationTimer) {
      clearTimeout(this.#notificationTimer)
      this.#notificationTimer = undefined
    }
    this.#notify()
  }

  #notify(): void {
    for (const listener of this.#listeners) listener(this.#state)
  }
}

function freshInitialState(): AppViewState {
  return {
    ...initialAppViewState,
    transcript: [],
    plan: [],
    usage: {},
    warnings: [],
  }
}
