import { AsyncQueue } from "../async-queue.ts"
import type { EngineSession } from "../engine.ts"
import type { AgentEvent } from "../events.ts"
import type { InputQueue } from "./input-queue.ts"

/** Keep event ownership and previously bound UI methods stable across prepared native runtimes. */
export class RoutedSession<T extends EngineSession> {
  readonly events = new AsyncQueue<AgentEvent>()
  readonly session: T
  readonly #listeners = new Set<() => void>()
  #unsubscribe?: () => void
  #pump: Promise<void>
  #closed = false
  #changing = false
  #transition?: Promise<void>
  #settle?: () => void
  readonly #bound = new WeakSet<object>()
  constructor(public active: T) {
    const queue = new Proxy({} as InputQueue, {
      get: (_, key) => {
        if (key === "subscribe")
          return (listener: () => void) => {
            this.#listeners.add(listener)
            return () => this.#listeners.delete(listener)
          }
        const current = this.active.inputQueue
        const value = Reflect.get(current as InputQueue, key)
        return typeof value === "function"
          ? (...args: unknown[]) => {
              if (
                this.#changing &&
                !["snapshot", "history", "references", "stash", "recall"].includes(String(key))
              )
                throw new Error("Working-directory transition is in progress")
              return Reflect.apply(
                Reflect.get(this.active.inputQueue as InputQueue, key),
                this.active.inputQueue,
                args,
              )
            }
          : value
      },
    })
    this.session = new Proxy(active, {
      set: (_, key, value) => {
        // Consumers may narrow optional methods with Object.assign(session, { method: session.method }).
        // Reinstalling our routing closure on the concrete runtime would recursively call itself.
        if (typeof value === "function" && this.#bound.has(value)) return true
        return Reflect.set(this.active, key, value)
      },
      get: (_, key) => {
        if (key === "events") return this.events
        if (key === "inputQueue") return queue
        if (key === "close") return () => this.close()
        const value = Reflect.get(this.active, key, this.active)
        if (typeof value !== "function") return value
        const bound = (...args: unknown[]) => {
          const inspect = ["directoryStatus", "sandboxStatus", "permissionRules"].includes(String(key))
          if (this.#closed && !inspect) return Promise.reject(new Error("Session is closed"))
          if (
            this.#changing &&
            !["directoryStatus", "sandboxStatus", "permissionRules"].includes(String(key))
          )
            return Promise.reject(new Error("Working-directory transition is in progress"))
          const method = Reflect.get(this.active, key)
          if (typeof method !== "function") throw new Error("Session method is unavailable")
          return Reflect.apply(method, this.active, args)
        }
        this.#bound.add(bound)
        return bound
      },
    })
    this.#pump = this.#attach(active)
  }
  #attach(session: T): Promise<void> {
    this.#unsubscribe = session.inputQueue?.subscribe(() => {
      for (const listener of this.#listeners) listener()
    })
    return (async () => {
      for await (const event of session.events) this.events.push(event)
    })()
  }
  begin() {
    if (this.#closed || this.#changing) throw new Error("Session cannot change directory now")
    this.#changing = true
    this.#transition = new Promise((resolve) => {
      this.#settle = resolve
    })
  }
  end() {
    this.#changing = false
    this.#settle?.()
    this.#transition = undefined
  }
  async replace(next: T) {
    const previous = this.active
    this.#unsubscribe?.()
    let failure: unknown
    try {
      await previous.close()
    } catch (error) {
      failure = error
    }
    await this.#pump
    this.active = next
    this.#pump = this.#attach(next)
    for (const listener of this.#listeners) listener()
    if (failure) throw failure
  }
  async close() {
    this.#closed = true
    await this.#transition
    try {
      await this.active.close()
    } finally {
      await this.#pump
      this.#unsubscribe?.()
      this.events.end()
    }
  }
}
