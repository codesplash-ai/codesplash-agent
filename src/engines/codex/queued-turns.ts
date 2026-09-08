import type { UserInput } from "../../core/engine.ts"
import type { InputIntent, InputItem, InputQueue } from "../../core/session/input-queue.ts"
import {
  ExecutionUncertainError,
  type InputCompletion,
  QueueRunner,
} from "../../core/session/queue-runner.ts"
import { JsonRpcRemoteError } from "./json-rpc.ts"

type Active = {
  id?: string
  inputId: string
  owned: boolean
  startDone: boolean
  terminal?: InputCompletion | Error
  steering: number
  steers: string[]
  done: Promise<InputCompletion | Error>
  resolve(result: InputCompletion | Error): void
}

/** Owns the interval from synchronous turn reservation through RPC and terminal settlement. */
export class CodexQueuedTurns {
  readonly runner: QueueRunner
  #active?: Active
  #starting?: Promise<void>
  #steering?: Promise<void>
  #closed = false
  #failure?: Error
  constructor(
    readonly queue: InputQueue,
    readonly backend: {
      busy?(): boolean
      start(input: UserInput, id: string): Promise<string>
      steer(input: UserInput, id: string, expectedTurnId: string): Promise<string>
      interrupt(turnId: string): Promise<void>
      error(error: Error): void
    },
  ) {
    this.runner = new QueueRunner(
      queue,
      {
        busy: () => this.busy || backend.busy?.() === true,
        run: async (input, item) => {
          const active = this.#reserve(item, false)
          await this.#start(active, input)
          const result = await active.done
          if (result instanceof Error) throw result
          return result
        },
        interrupt: () => this.interrupt(false),
        steeringPending: () => this.#pumpSteering(),
      },
      (error) => {
        this.#failure = error
        backend.error(error)
      },
    )
  }
  get busy(): boolean {
    return !!this.#active
  }
  submit(input: UserInput, intent: InputIntent = "follow-up", id?: string) {
    this.#requireOpen()
    return this.queue.submit(input, intent, id)
  }
  async send(input: UserInput): Promise<void> {
    this.#requireOpen()
    if (this.busy || this.backend.busy?.())
      throw new Error("A Codex turn or recovery operation is already running")
    const ack = this.queue.submit(input)
    let admitted: UserInput
    try {
      admitted = this.queue.admit(ack.id, true)
      this.queue.running(ack.id)
    } catch (error) {
      this.queue.finish(ack.id, "blocked", error instanceof Error ? error.message : String(error))
      this.queue.pause()
      throw error
    }
    const item = this.queue.snapshot().items.find((item) => item.id === ack.id) as InputItem
    const active = this.#reserve(item, true)
    await this.#start(active, admitted)
  }
  started(id: string): void {
    if (this.#active && !this.#active.id) this.#active.id = id
    this.runner.wake()
  }
  completed(id: string, status: InputCompletion): void {
    const active = this.#active
    if (!active || (active.id && active.id !== id)) return
    active.id = id
    active.terminal = status
    this.#settle(active)
  }
  disconnected(): void {
    this.#failure = new ExecutionUncertainError(
      "Codex connection closed; inspect provider history before retrying",
    )
    this.runner.stop()
    const active = this.#active
    if (active) {
      active.terminal = this.#failure
      this.#settle(active)
    }
  }
  async interrupt(pause = true): Promise<void> {
    if (pause) this.queue.pause()
    const active = this.#active
    if (!active) return
    await this.#starting?.catch(() => {})
    if (!active.terminal && active.id) {
      try {
        await this.backend.interrupt(active.id)
      } catch (error) {
        this.disconnected()
        throw error
      }
    }
    // A successful interrupt RPC is not a terminal notification. Bound the wait without replay.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        active.done,
        new Promise<Error>((resolve) => {
          timer = setTimeout(() => {
            this.disconnected()
            resolve(
              new ExecutionUncertainError(
                "Codex did not confirm interruption; reconnect and inspect history",
              ),
            )
          }, 30_000)
        }),
      ])
      if (result instanceof Error) throw result
    } finally {
      clearTimeout(timer)
    }
  }
  async close(): Promise<void> {
    this.#closed = true
    this.disconnected()
    await this.#starting?.catch(() => {})
    await this.#steering
    await this.runner.settled()
  }
  #requireOpen(): void {
    if (this.#closed || this.#failure || this.runner.failure)
      throw this.#failure ?? this.runner.failure ?? new Error("Codex session is closed")
  }
  #reserve(item: InputItem, owned: boolean): Active {
    this.#requireOpen()
    if (this.#active || this.backend.busy?.())
      throw new Error("A Codex turn or recovery operation is already running")
    let resolve!: Active["resolve"]
    const done = new Promise<InputCompletion | Error>((accept) => {
      resolve = accept
    })
    const active: Active = {
      inputId: item.id,
      owned,
      done,
      resolve,
      startDone: false,
      steering: 0,
      steers: [],
    }
    this.#active = active
    return active
  }
  #start(active: Active, input: UserInput): Promise<void> {
    this.#starting = (async () => {
      try {
        const id = await this.backend.start(input, active.inputId)
        if (active.id && active.id !== id)
          throw new ExecutionUncertainError("Codex returned a mismatched turn id")
        active.id = id
      } catch (error) {
        const failure =
          error instanceof JsonRpcRemoteError
            ? error
            : new ExecutionUncertainError(
                "Codex turn admission was not confirmed; inspect provider history before retrying",
              )
        active.terminal = failure
        throw failure
      } finally {
        active.startDone = true
        this.#settle(active)
        this.runner.wake()
      }
    })()
    return this.#starting
  }
  #settle(active: Active): void {
    if (!active.startDone || !active.terminal || active.steering > 0 || this.#active !== active) return
    const result = active.terminal
    try {
      for (const id of [...active.steers, ...(active.owned ? [active.inputId] : [])])
        this.queue.finish(
          id,
          result instanceof ExecutionUncertainError
            ? "execution-uncertain"
            : result instanceof Error
              ? "failed"
              : result,
          result instanceof Error ? result.message : undefined,
        )
      if (result instanceof Error || result === "failed") this.queue.pause()
    } catch (error) {
      this.#failure = error instanceof Error ? error : new Error(String(error))
      this.runner.stop()
      this.backend.error(this.#failure)
    } finally {
      this.#active = undefined
      active.resolve(this.#failure ?? result)
      this.runner.wake()
    }
  }
  #pumpSteering(): void {
    if (this.#steering || this.#closed || this.#failure) return
    const active = this.#active
    if (!active?.startDone || active.terminal || !active.id) return
    const item = this.queue.next("steering")
    if (!item) return
    active.steering++
    this.#steering = (async () => {
      let dispatched = false
      try {
        const input = this.queue.admit(item.id, false, "within-turn")
        this.queue.running(item.id)
        dispatched = true
        const id = await this.backend.steer(input, item.id, active.id as string)
        if (id !== active.id)
          throw new ExecutionUncertainError("Codex returned a mismatched steering turn id")
        active.steers.push(item.id)
      } catch (error) {
        const uncertain = dispatched && !(error instanceof JsonRpcRemoteError)
        this.queue.finish(
          item.id,
          uncertain ? "execution-uncertain" : "blocked",
          uncertain
            ? "Steering admission was not confirmed; inspect provider history"
            : `Steering was rejected; edit or remove the input: ${error instanceof Error ? error.message : String(error)}`,
        )
        this.queue.pause()
        if (uncertain) this.disconnected()
      }
    })()
      .catch((error) => {
        this.#failure = error
        this.runner.stop()
        this.backend.error(error)
      })
      .finally(() => {
        active.steering--
        this.#steering = undefined
        this.#settle(active)
        this.runner.wake()
      })
  }
}
