import type { SessionStateAccess } from "../session/control.ts"
import { type OrchestrationConfig, validateOrchestration } from "./config.ts"
import { TaskOutput } from "./output.ts"

export type TaskStatus = "queued" | "running" | "completed" | "cancelled" | "failed" | "execution-uncertain"
export type TaskRecord = {
  id: string
  owner: string
  root: string
  parent?: string
  kind: string
  label: string
  depth: number
  status: TaskStatus
  created: string
  updated: string
  error?: string
}
type Journal = { version: 1; root: string; tasks: TaskRecord[] }
type Work = {
  abort: AbortController
  run: (context: TaskContext) => Promise<void>
  finish: (record: TaskRecord) => void
  finished: Promise<TaskRecord>
  output: TaskOutput
  record: TaskRecord
}
export type TaskContext = { id: string; signal: AbortSignal; output: TaskOutput }
export type TaskHandle = { id: string; finished: Promise<TaskRecord>; output: TaskOutput }
const statuses: TaskStatus[] = [
  "queued",
  "running",
  "completed",
  "cancelled",
  "failed",
  "execution-uncertain",
]
const terminal = (status: TaskStatus) => status !== "queued" && status !== "running"
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const owners = new WeakSet<SessionStateAccess>()
const durableOwners = new Set<string>()

/** One registry per owned root. Callback settlement, not cancellation, releases admission. */
export class TaskRegistry {
  readonly owner = crypto.randomUUID()
  readonly limits: OrchestrationConfig
  readonly #work = new Map<string, Work>()
  readonly #waiters = new Set<() => void>()
  #closed = false
  #pumping = false
  #repump = false
  constructor(
    readonly root: string,
    readonly state: SessionStateAccess,
    config: Partial<OrchestrationConfig> = {},
  ) {
    if (!root || root.length > 128) throw new Error("Invalid task root")
    if (owners.has(state) || (state.directory && durableOwners.has(state.directory)))
      throw new Error("Task root already has a live owner")
    this.limits = Object.freeze(validateOrchestration(config))
    this.#update((tasks) => {
      for (const task of tasks)
        if (!terminal(task.status)) {
          task.status = "execution-uncertain"
          task.updated = new Date().toISOString()
          task.error = "Previous owner stopped without a confirmed outcome; review before retrying"
        }
    })
    owners.add(state)
    if (state.directory) durableOwners.add(state.directory)
  }
  #journal(value: unknown): Journal {
    if (value === undefined) return { version: 1, root: this.root, tasks: [] }
    const j = value as Journal
    if (
      !j ||
      j.version !== 1 ||
      j.root !== this.root ||
      !Array.isArray(j.tasks) ||
      j.tasks.length > 128 ||
      j.tasks.some(
        (t) =>
          !t ||
          !idPattern.test(t.id) ||
          !idPattern.test(t.owner) ||
          t.root !== this.root ||
          (t.parent !== undefined && !idPattern.test(t.parent)) ||
          !Number.isSafeInteger(t.depth) ||
          t.depth < 0 ||
          t.depth > 8 ||
          typeof t.kind !== "string" ||
          t.kind.length > 64 ||
          typeof t.label !== "string" ||
          t.label.length > 512 ||
          !statuses.includes(t.status) ||
          typeof t.created !== "string" ||
          typeof t.updated !== "string" ||
          (t.error !== undefined && (typeof t.error !== "string" || t.error.length > 2048)),
      ) ||
      new Set(j.tasks.map((t) => t.id)).size !== j.tasks.length
    )
      throw new Error("Corrupt orchestration journal")
    return j
  }
  #update(change: (tasks: TaskRecord[]) => void) {
    this.state.assertOwned?.()
    const before = this.state.read()
    this.state.update(before.revision, "orchestration", (state) => {
      const journal = this.#journal(state.values.orchestration)
      change(journal.tasks)
      state.values.orchestration = this.#journal(journal)
    })
    for (const wake of [...this.#waiters]) wake()
  }
  list(): TaskRecord[] {
    this.state.assertOwned?.()
    return structuredClone(this.#journal(this.state.read().state.values.orchestration).tasks)
  }
  submit(
    spec: { kind: string; label: string; parent?: string; secrets?: readonly string[] },
    run: Work["run"],
  ): TaskHandle {
    if (this.#closed) throw new Error("Task owner is closed")
    const tasks = this.list(),
      parent = spec.parent ? tasks.find((t) => t.id === spec.parent) : undefined
    if (spec.parent && (!parent || parent.owner !== this.owner || parent.status !== "running"))
      throw new Error("Parent task is not live under this owner")
    const depth = parent ? parent.depth + 1 : 0
    if (depth > this.limits.maxDepth) throw new Error("Task depth limit exceeded")
    if (tasks.length >= this.limits.maxTasks)
      throw new Error("Retained task limit reached; forget terminal tasks")
    const running = tasks.filter((t) => t.status === "running").length
    if (spec.parent && running >= this.limits.maxRunning)
      throw new Error("Nested task capacity is exhausted; do not queue a dependency behind its parent")
    if (
      running >= this.limits.maxRunning &&
      tasks.filter((t) => t.status === "queued").length >= this.limits.maxQueued
    )
      throw new Error("Task admission queue is full")
    const output = new TaskOutput(this.limits.outputBytes, spec.secrets)
    const id = crypto.randomUUID(),
      now = new Date().toISOString()
    let finish!: Work["finish"]
    const finished = new Promise<TaskRecord>((resolve) => {
      finish = resolve
    })
    this.#update((entries) =>
      entries.push({
        id,
        owner: this.owner,
        root: this.root,
        parent: spec.parent,
        kind: spec.kind,
        label: spec.label,
        depth,
        status: "queued",
        created: now,
        updated: now,
      }),
    )
    const record = this.list().find((t) => t.id === id)!
    this.#work.set(id, { abort: new AbortController(), run, finish, finished, output, record })
    this.#pump()
    return { id, finished, output }
  }
  #status(id: string, status: TaskStatus, error?: string): TaskRecord {
    let result!: TaskRecord
    this.#update((tasks) => {
      const task = tasks.find((t) => t.id === id)
      if (!task || task.owner !== this.owner || terminal(task.status))
        throw new Error("Task ownership or transition invalid")
      task.status = status
      task.updated = new Date().toISOString()
      task.error = error
      result = structuredClone(task)
    })
    return result
  }
  #pump() {
    if (this.#closed) return
    if (this.#pumping) {
      this.#repump = true
      return
    }
    this.#pumping = true
    try {
      const tasks = this.list()
      let capacity = this.limits.maxRunning - tasks.filter((t) => t.status === "running").length
      for (const task of tasks) {
        if (capacity <= 0) break
        if (task.status !== "queued") continue
        const work = this.#work.get(task.id)
        if (!work) throw new Error("Queued task has no live owner")
        work.record = this.#status(task.id, "running")
        capacity--
        void this.#execute(task.id, work)
      }
    } finally {
      this.#pumping = false
      if (this.#repump) {
        this.#repump = false
        this.#pump()
      }
    }
  }
  async #execute(id: string, work: Work) {
    let status: TaskStatus = "completed",
      error: string | undefined
    try {
      work.abort.signal.throwIfAborted()
      await work.run({ id, signal: work.abort.signal, output: work.output })
    } catch {
      status = "failed"
      error = "Task execution failed; inspect sanitized task output"
    }
    if (work.abort.signal.aborted) status = "cancelled"
    work.output.close()
    try {
      work.finish(this.#status(id, status, error))
    } catch {
      // Lost storage authority cannot authorize subsequent work or claim a durable outcome.
      this.#closed = true
      for (const other of this.#work.values()) other.abort.abort()
      work.finish({ ...work.record, status: "execution-uncertain" })
      for (const [otherId, other] of this.#work)
        if (otherId !== id && other.record.status === "queued") {
          other.output.close()
          other.finish({ ...other.record, status: "execution-uncertain" })
          this.#work.delete(otherId)
        }
    }
    this.#work.delete(id)
    this.#pump()
  }
  interrupt(id: string) {
    const task = this.list().find((t) => t.id === id),
      work = this.#work.get(id)
    if (!task || task.owner !== this.owner || !work) throw new Error("Task is not live under this owner")
    work.abort.abort(new Error("Task interrupted"))
    if (task.status === "queued") {
      work.output.close()
      work.finish(this.#status(id, "cancelled"))
      this.#work.delete(id)
    }
  }
  forget(id: string) {
    this.#update((tasks) => {
      const index = tasks.findIndex((t) => t.id === id)
      if (index < 0 || !terminal(tasks[index]!.status) || tasks.some((t) => t.parent === id))
        throw new Error("Only terminal unreferenced tasks may be forgotten")
      tasks.splice(index, 1)
    })
  }
  wait(ids: readonly string[], all: boolean, timeoutMs: number): Promise<TaskRecord[]> {
    if (this.#waiters.size >= 32) throw new Error("Task wait limit reached")
    if (
      !ids.length ||
      ids.length > 128 ||
      new Set(ids).size !== ids.length ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 0 ||
      timeoutMs > 30000
    )
      throw new Error("Invalid task wait")
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        this.#waiters.delete(wake)
      }
      const wake = (expired = false) => {
        try {
          const tasks = this.list(),
            selected = ids.map((id) => {
              const task = tasks.find((t) => t.id === id)
              if (!task) throw new Error("Unknown task ID")
              return task
            })
          if (
            expired ||
            (all ? selected.every((t) => terminal(t.status)) : selected.some((t) => terminal(t.status)))
          ) {
            cleanup()
            resolve(selected)
          }
        } catch (error) {
          cleanup()
          reject(error)
        }
      }
      this.#waiters.add(wake)
      timer = setTimeout(() => wake(true), timeoutMs)
      wake()
    })
  }
  async close() {
    this.#closed = true
    const finished = [...this.#work.values()].map((w) => w.finished)
    for (const [id, work] of [...this.#work]) {
      work.abort.abort(new Error("Task owner closed"))
      if (work.record.status === "queued") {
        work.output.close()
        try {
          work.finish(this.#status(id, "cancelled"))
        } catch {
          work.finish({ ...work.record, status: "execution-uncertain" })
        }
        this.#work.delete(id)
      }
    }
    await Promise.all(finished)
    owners.delete(this.state)
    if (this.state.directory) durableOwners.delete(this.state.directory)
  }
}
