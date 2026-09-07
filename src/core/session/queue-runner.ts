import type { UserInput } from "../engine.ts"
import type { InputItem, InputQueue } from "./input-queue.ts"

export class ExecutionUncertainError extends Error {}
export type InputCompletion = "completed" | "cancelled" | "failed"
export type QueueBackend = {
  busy(): boolean
  run(input: UserInput, item: InputItem): Promise<InputCompletion>
  interrupt(): Promise<void>
  steeringPending?(): void
}

/** Serial foreground dispatcher. Engines remain responsible for their actual safe boundaries. */
export class QueueRunner {
  #closed = false
  #failure: Error | undefined
  #pump: Promise<void> | undefined
  #interrupting: Promise<void> | undefined
  #scheduled = false
  #interjected: string | undefined
  readonly #unsubscribe: () => void
  constructor(
    readonly queue: InputQueue,
    readonly backend: QueueBackend,
    readonly onError?: (error: Error) => void,
  ) {
    this.#unsubscribe = queue.subscribe(() => this.wake())
  }
  get failure(): Error | undefined {
    return this.#failure
  }
  halt(error: unknown): void {
    this.#fail(error)
  }
  #fail = (error: unknown): void => {
    this.#failure = error instanceof Error ? error : new Error(String(error))
    this.#closed = true
    this.#unsubscribe()
    try {
      this.onError?.(this.#failure)
    } catch {
      /* Consumer diagnostics cannot compromise cleanup. */
    }
  }
  wake(): void {
    if (this.#closed || this.#scheduled) return
    this.#scheduled = true
    queueMicrotask(() => {
      try {
        this.#scheduled = false
        if (this.#closed || this.queue.snapshot().paused) return
        const interject = this.queue.next("interject")
        if (this.backend.busy()) {
          if (interject && !this.#interrupting && this.#interjected !== interject.id) {
            this.#interjected = interject.id
            this.#interrupting = this.backend
              .interrupt()
              .catch((error) => {
                this.queue.finish(
                  interject.id,
                  "blocked",
                  `Current work did not settle: ${error instanceof Error ? error.message : String(error)}`,
                )
                this.queue.pause()
              })
              .catch(this.#fail)
              .finally(() => {
                this.#interrupting = undefined
                this.#interjected = undefined
                this.wake()
              })
          } else if (!interject) this.backend.steeringPending?.()
          return
        }
        if (!this.#pump && !this.#interrupting)
          this.#pump = this.#dispatch()
            .catch(this.#fail)
            .finally(() => {
              this.#pump = undefined
              if (!this.#closed && this.queue.next() && !this.backend.busy()) this.wake()
            })
      } catch (error) {
        this.#fail(error)
      }
    })
  }
  stop(): void {
    if (this.#closed) return
    this.#closed = true
    this.#unsubscribe()
    try {
      this.queue.pause()
    } catch (error) {
      this.#fail(error)
    }
  }
  async settled(): Promise<void> {
    await this.#interrupting
    await this.#pump
  }
  async #dispatch(): Promise<void> {
    while (!this.#closed && !this.#interrupting && !this.backend.busy()) {
      const item = this.queue.next("interject") ?? this.queue.next()
      if (!item) return
      let admitted = false
      try {
        const input = this.queue.admit(item.id)
        this.queue.running(item.id)
        admitted = true
        const status = await this.backend.run(input, item)
        this.queue.finish(item.id, status)
        if (status === "failed") this.queue.pause()
      } catch (error) {
        const uncertain =
          error instanceof ExecutionUncertainError ||
          this.queue.snapshot().items.find((entry) => entry.id === item.id)?.status === "execution-uncertain"
        this.queue.finish(
          item.id,
          uncertain ? "execution-uncertain" : admitted ? "failed" : "blocked",
          error instanceof Error ? error.message : String(error),
        )
        this.queue.pause()
      }
    }
  }
}
