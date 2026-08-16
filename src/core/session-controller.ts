import type { EngineDecision, EngineSession, UserInput } from "./engine.ts"
import type { AgentEvent } from "./events.ts"
import type { AppViewState } from "./reducer.ts"
import { initialAppViewState, reduceAgentEvent } from "./reducer.ts"

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

  constructor(session: EngineSession, options: SessionControllerOptions = {}) {
    this.#session = session
    this.#onEvent = options.onEvent
    this.#state = options.initialState ?? freshInitialState()
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

  async send(input: UserInput): Promise<void> {
    if (this.#closed) throw new Error("Session is closed")
    if (!input.text.trim() && !input.images?.length) return
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

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#session.close()
    await this.#consumePromise
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
