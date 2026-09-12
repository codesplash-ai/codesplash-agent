import { isAbsolute } from "node:path"
import { dataDirectory } from "../../../core/config.ts"
import type { OrchestrationConfig } from "../../../core/orchestration/config.ts"
import type { TaskRequest } from "../../../core/orchestration/contracts.ts"
import type { OutputPage } from "../../../core/orchestration/output.ts"
import { type TaskHandle, type TaskRecord, TaskRegistry } from "../../../core/orchestration/tasks.ts"
import type { SessionStateAccess } from "../../../core/session/control.ts"
import { safeSessionText } from "../../../core/session/repository.ts"
import type { HarnessTool, PermissionMode, ToolContext, ToolOutcome } from "../contracts.ts"
import { ToolInputError } from "../contracts.ts"
import type { ExecutionResult, SandboxRuntime } from "../sandbox/contracts.ts"
import { contains, physicalPath } from "../sandbox/profile.ts"
import type { SandboxTerminal } from "../sandbox/terminal.ts"
import { terminalSize } from "../sandbox/terminal-protocol.ts"
import { bashTool } from "../tools/bash.ts"
import { type ShellSelection, shellSnapshotArgv } from "./shell-state.ts"

type Command = {
  modelVisible: boolean
  readOnly: boolean
  handle: TaskHandle
  terminal?: SandboxTerminal
  mode: PermissionMode
  profile: string
  result?: ExecutionResult
}
type ExecInput = {
  snapshot?: ShellSelection
  command: string
  readOnly?: boolean
  background?: boolean
  yieldMs?: number
  timeoutMs?: number
  cols?: number
  rows?: number
}
function execInput(input: unknown): ExecInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ToolInputError("Expected command input")
  const value = input as ExecInput
  if (
    typeof value.command !== "string" ||
    !value.command.trim() ||
    Buffer.byteLength(value.command) > 65536 ||
    value.command.includes("\0")
  )
    throw new ToolInputError("Command must contain 1–65536 bytes without NUL")
  for (const key of Object.keys(value))
    if (
      !["command", "readOnly", "background", "yieldMs", "timeoutMs", "cols", "rows", "snapshot"].includes(key)
    )
      throw new ToolInputError(`Unknown exec_command field: ${key}`)
  for (const key of ["readOnly", "background"] as const)
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      throw new ToolInputError(`Invalid ${key}`)
  for (const [name, max, min] of [
    ["yieldMs", 30000, 0],
    ["timeoutMs", 3600000, 1],
  ] as const) {
    const n = value[name]
    if (n !== undefined && (!Number.isSafeInteger(n) || n < min || n > max))
      throw new ToolInputError(`Invalid ${name}`)
  }
  if (
    value.snapshot !== undefined &&
    (!value.snapshot ||
      typeof value.snapshot !== "object" ||
      Array.isArray(value.snapshot) ||
      Object.keys(value.snapshot).some((key) => !["path", "fingerprint"].includes(key)) ||
      typeof value.snapshot.path !== "string" ||
      !isAbsolute(value.snapshot.path) ||
      value.snapshot.path.includes("\0") ||
      Buffer.byteLength(value.snapshot.path) > 4096 ||
      typeof value.snapshot.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.snapshot.fingerprint))
  )
    throw new ToolInputError("Shell snapshot requires path and fingerprint")
  terminalSize({ cols: value.cols ?? 80, rows: value.rows ?? 24 })
  return value
}
const object = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ToolInputError("Expected task input object")
  return input as Record<string, unknown>
}
const idOf = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
  )
    throw new ToolInputError("Expected an owned task ID")
  return value
}

export class NativeCommands {
  onForget?: (id: string) => void
  onTaskUpdate?: (item: {
    id: string
    label: string
    output?: string
    status: "running" | "completed" | "failed"
  }) => void
  readonly #observed = new Set<string>()
  #notices: Pick<TaskRecord, "id" | "status" | "label">[] = []
  #omitted = 0
  takeNotices() {
    const result = { notices: this.#notices.splice(0, 8), omitted: this.#omitted }
    this.#omitted = 0
    return result
  }
  #observe(handle: TaskHandle) {
    if (this.#observed.has(handle.id) || this.#closed) return
    this.#observed.add(handle.id)
    const publish = (record: TaskRecord, settled: boolean) => {
      if (this.parentCommands || this.#closed) return
      try {
        const page = handle.output.read(0, 4096)
        this.onTaskUpdate?.({
          id: record.id,
          label: `[Task ${record.status}] ${record.label.slice(0, 160)}`,
          status: !settled ? "running" : record.status === "completed" ? "completed" : "failed",
          ...(settled
            ? { output: page.end > 4096 ? handle.output.read(page.end - 4096, 4096).text : page.text }
            : {}),
        })
      } catch {
        /* Presentation cannot change task ownership or completion. */
      }
    }
    const record = this.tasks.list().find((t) => t.id === handle.id)
    if (record) publish(record, false)
    void handle.finished.then((record) => {
      if (this.#closed) return
      publish(record, true)
      if (this.#commands.get(handle.id)?.modelVisible) {
        if (this.#notices.length >= 32) {
          this.#notices.shift()
          this.#omitted++
        }
        this.#notices.push({
          id: record.id,
          status: record.status,
          label: safeSessionText(record.label).slice(0, 80),
        })
      }
    })
  }
  #tasks?: TaskRegistry
  #closed = false
  readonly #commands = new Map<string, Command>()
  readonly #foreground = new Map<string, () => void>()
  #monitors = 0
  readonly #monitorStops = new Set<() => void>()
  constructor(
    readonly root: string,
    readonly state: SessionStateAccess,
    readonly sandbox: SandboxRuntime,
    readonly mode: () => PermissionMode,
    readonly limits?: OrchestrationConfig,
    readonly trustDataDir = dataDirectory(),
    readonly parentCommands?: NativeCommands,
    readonly parentTask?: string,
  ) {}
  get tasks(): TaskRegistry {
    if (this.#closed) throw new Error("Task owner is closed")
    if (this.parentCommands) return this.parentCommands.tasks
    this.#tasks ??= new TaskRegistry(this.root, this.state, this.limits)
    return this.#tasks
  }
  assertIdle() {
    if (
      (this.parentCommands
        ? this.tasks.list().filter((t) => this.#commands.has(t.id))
        : this.#tasks?.list()
      )?.some((t) => ["queued", "running"].includes(t.status))
    )
      throw new Error("Stop active tasks before changing session authority")
  }
  adopt(handle: TaskHandle, modelVisible = true, readOnly = true) {
    this.#commands.set(handle.id, {
      handle,
      modelVisible,
      readOnly,
      mode: this.mode(),
      profile: this.sandbox.profile.hash,
    })
    this.#observe(handle)
    this.parentCommands?.adopt(handle, modelVisible, readOnly)
  }
  #shareCommand(command: Command) {
    this.#commands.set(command.handle.id, command)
    this.#observe(command.handle)
    if (this.parentCommands) this.parentCommands.#shareCommand(command)
  }
  #owned(id: string): Command {
    if (this.#closed) throw new Error("Task owner is closed")
    idOf(id)
    const command = this.#commands.get(id)
    if (!command)
      throw new Error("Task output/process is unavailable under this owner; old processes are never resumed")
    return command
  }
  #terminal(id: string): SandboxTerminal {
    const command = this.#owned(id)
    if (command.result || !command.terminal) {
      const status = this.tasks.list().find((task) => task.id === id)?.status
      throw new Error(
        !command.terminal && ["queued", "running"].includes(status ?? "")
          ? "Terminal is still starting; wait for terminalReady before sending input"
          : "Task has no live terminal; inspect task output",
      )
    }
    if (this.mode() !== command.mode || this.sandbox.profile.hash !== command.profile)
      throw new Error("Terminal authority changed; stop this task and review a new command")
    return command.terminal
  }
  admission?: { parent: string }
  async execute(raw: unknown, context: ToolContext): Promise<ToolOutcome> {
    const admission = this.admission
    const input = execInput(raw)
    context.signal.throwIfAborted()
    if (!this.sandbox.openTerminal) throw new Error("Native terminal backend is unavailable")
    const argv = () => {
      if (!input.snapshot) return ["/bin/bash", "--noprofile", "--norc", "-c", input.command]
      const path = physicalPath(input.snapshot.path)
      if (
        ![...this.sandbox.profile.readRoots, ...this.sandbox.profile.writeRoots].some((root) =>
          contains(root, path),
        ) ||
        context.permissions?.isReadDenied(path, "read_file")
      )
        throw new Error("Shell snapshot has no read authority in this session")
      return shellSnapshotArgv(this.trustDataDir, input.snapshot, input.command)
    }
    argv() // Exact snapshot trust and read scope are checked before journaling/admission.
    const mode = this.mode(),
      profile = this.sandbox.profile.hash
    let command!: Command
    const handle = this.tasks.submit(
      {
        kind: "command",
        parent: admission?.parent ?? this.parentTask,
        label: safeSessionText(this.sandbox.sanitize?.(input.command) ?? input.command).slice(0, 512),
      },
      async (task) => {
        // Admission may queue. Validate current authority at actual execution, before any subprocess.
        if (this.mode() !== mode || this.sandbox.profile.hash !== profile)
          throw new Error("Command authority changed during admission")
        const terminal = await this.sandbox.openTerminal!(
          argv(),
          {
            cols: input.cols ?? 80,
            rows: input.rows ?? 24,
            timeoutMs: input.timeoutMs ?? 120000,
          },
          task.signal,
          (bytes) => task.output.append(Buffer.from(bytes).toString("utf8")),
          mode,
          input.readOnly,
        ).catch((error) => {
          task.output.append(
            this.sandbox.sanitize?.(
              `\n[Terminal startup failed] ${error instanceof Error ? error.message : "Unknown failure"}\n`,
            ) ?? "\n[Terminal startup failed]\n",
          )
          throw error
        })
        command.terminal = terminal
        const result = await terminal.finished
        command.result = {
          ...result,
          stdout: "",
          stderr: (this.sandbox.sanitize?.(result.stderr) ?? result.stderr).slice(0, 65536),
        }
        if (command.result.stderr)
          task.output.append(this.sandbox.sanitize?.(command.result.stderr) ?? command.result.stderr)
        if (command.result.kind !== "success") throw new Error("Command failed")
      },
    )
    command = {
      handle,
      mode,
      profile,
      modelVisible: context.modelContext !== false,
      readOnly: input.readOnly === true || mode === "plan" || this.sandbox.profile.mode === "read-only",
    }
    this.#shareCommand(command)
    context.holdMutationUntil?.(handle.finished)
    const cancel = () => {
      try {
        this.tasks.interrupt(handle.id)
      } catch {}
    }
    if (!input.background) context.signal.addEventListener("abort", cancel, { once: true })
    if (context.signal.aborted) cancel()
    try {
      if (!input.background && (input.yieldMs ?? 1000) > 0)
        await this.yieldTask(handle.id, handle.finished, input.yieldMs ?? 1000)
      return {
        label: "Command task",
        text: JSON.stringify(this.output(handle.id)),
        isError: command.result && command.result.kind !== "success",
      }
    } finally {
      context.signal.removeEventListener("abort", cancel)
      this.#foreground.delete(handle.id)
    }
  }
  async yieldTask(id: string, finished: Promise<unknown>, duration: number) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        finished,
        new Promise<void>((resolve) => {
          this.#foreground.set(id, resolve)
          timer = setTimeout(resolve, duration)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
      this.#foreground.delete(id)
    }
  }
  output(id: string, cursor = 0, limit = 65536) {
    const command = this.#owned(id)
    return {
      task: this.tasks.list().find((t) => t.id === id),
      output: command.handle.output.read(cursor, limit),
      result: command.result,
      terminalReady: !!command.terminal && !command.result,
    }
  }
  async modelControl(request: TaskRequest): Promise<unknown> {
    const ids = "id" in request ? [request.id] : "ids" in request ? request.ids : []
    if (ids.some((id) => !this.#owned(id).modelVisible))
      throw new Error("This task was excluded from model context")
    if (request.action === "list")
      return this.tasks.list().filter((t) => this.#commands.get(t.id)?.modelVisible)
    return this.control(request)
  }
  async control(request: TaskRequest): Promise<unknown> {
    switch (request.action) {
      case "list":
        return this.tasks.list()
      case "output":
        return this.output(request.id, request.cursor, request.limit)
      case "background": {
        if (!this.#foreground.size) throw new Error("No foreground task is waiting")
        const ids = [...this.#foreground.keys()]
        for (const wake of this.#foreground.values()) wake()
        this.#foreground.clear()
        return { backgrounded: ids }
      }
      case "kill":
        this.tasks.interrupt(idOf(request.id))
        return { interrupted: request.id }
      case "forget":
        this.tasks.forget(idOf(request.id))
        this.onForget?.(request.id)
        this.#commands.delete(request.id)
        this.#observed.delete(request.id)
        this.#notices = this.#notices.filter((n) => n.id !== request.id)
        return { forgotten: request.id }
      case "resize":
        terminalSize(request)
        await this.#terminal(request.id).resize(request.cols, request.rows)
        return { resized: request.id }
      case "stdin":
        if (typeof request.text !== "string" || Buffer.byteLength(request.text) > 65536)
          throw new Error("Terminal input exceeds 64 KiB")
        await this.#terminal(request.id).write(Buffer.from(request.text))
        return this.output(request.id)
      case "wait": {
        if (
          !Array.isArray(request.ids) ||
          !request.ids.length ||
          request.ids.length > 128 ||
          new Set(request.ids).size !== request.ids.length
        )
          throw new Error("Wait requires 1–128 unique task IDs")
        const timeoutMs = request.timeoutMs ?? 1000
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000)
          throw new Error("Task wait must be between 0 and 30000 ms")
        for (const id of request.ids) this.#owned(id)
        await this.tasks.wait(request.ids, request.all === true, timeoutMs)
        return request.ids.map((id) => this.output(id, 0, 1024))
      }
    }
  }
  monitor(id: string, cursor = 0): AsyncIterableIterator<OutputPage> {
    const output = this.#owned(id).handle.output
    if (this.#monitors >= 8) throw new Error("Task monitor limit reached")
    output.read(cursor)
    this.#monitors++
    const abort = new AbortController()
    let released = false
    const release = () => {
      if (!released) {
        released = true
        this.#monitors--
        this.#monitorStops.delete(stop)
      }
    }
    const stop = () => {
      abort.abort()
      release()
    }
    this.#monitorStops.add(stop)
    const iterator = (async function* () {
      try {
        for (;;) {
          abort.signal.throwIfAborted()
          const page = output.read(cursor)
          if (page.text || page.lost || page.closed) {
            cursor = page.cursor
            yield page
          }
          if (page.closed && cursor === page.end) return
          if (cursor === page.end) await output.waitForChange(cursor, abort.signal)
        }
      } catch (error) {
        if (!abort.signal.aborted) throw error
      } finally {
        release()
      }
    })()
    return {
      [Symbol.asyncIterator]() {
        return this
      },
      next: (value) => iterator.next(value),
      return: async () => {
        abort.abort()
        release()
        return iterator.return()
      },
      throw: async (error) => {
        abort.abort()
        release()
        return iterator.throw(error)
      },
    }
  }
  async close() {
    this.#closed = true
    this.#notices = []
    this.#omitted = 0
    for (const stop of [...this.#monitorStops]) stop()
    if (this.parentCommands) {
      for (const command of this.#commands.values()) {
        try {
          this.parentCommands.tasks.interrupt(command.handle.id)
        } catch {}
      }
      await Promise.all([...this.#commands.values()].map((command) => command.handle.finished))
    } else await this.#tasks?.close()
  }
  tools(): HarnessTool[] {
    const tool = (
      name: string,
      properties: Record<string, unknown>,
      required: string[],
      run: (input: Record<string, unknown>, context: ToolContext) => Promise<unknown>,
      readOnly: boolean | ((input: unknown) => boolean) = true,
    ): HarnessTool => ({
      name,
      description: `Operate on an owned task: ${name}. Output and waits are bounded.`,
      inputSchema: { type: "object", properties, required, additionalProperties: false },
      isReadOnly: (input) => (typeof readOnly === "function" ? readOnly(input) : readOnly),
      effects: "external",
      permission: () =>
        name !== "write_stdin"
          ? { kind: "none" }
          : {
              kind: "approval",
              title: "Send input to running command?",
              detail: "Input reaches the existing sandboxed terminal; its authority cannot expand.",
            },
      run: async (input, context) => ({
        text: JSON.stringify(await run(object(input), context)),
        label: name,
      }),
    })
    const id = { type: "string" }
    return [
      {
        name: "exec_command",
        description:
          "Run a command in an owned sandboxed PTY. Returns task ID and bounded output after yieldMs (default 1000). Use readOnly for enforced read-only concurrent execution. Use write_stdin for interactive input; task_output/task_wait/task_kill manage background tasks.",
        inputSchema: {
          type: "object",
          properties: {
            snapshot: {
              type: "object",
              properties: {
                path: { type: "string" },
                fingerprint: { type: "string", minLength: 64, maxLength: 64 },
              },
              required: ["path", "fingerprint"],
              additionalProperties: false,
            },
            command: { type: "string", maxLength: 65536 },
            readOnly: { type: "boolean" },
            background: { type: "boolean" },
            yieldMs: { type: "integer", minimum: 0, maximum: 30000 },
            timeoutMs: { type: "integer", minimum: 1, maximum: 3600000 },
            cols: { type: "integer", minimum: 1, maximum: 500 },
            rows: { type: "integer", minimum: 1, maximum: 500 },
          },
          required: ["command"],
          additionalProperties: false,
        },
        permissionFloor: {
          ...bashTool,
          permissionTargets: (input) => ({
            command: execInput(input).snapshot ? "eval reviewed_shell_snapshot" : execInput(input).command,
          }),
        },
        isReadOnly: (input) => execInput(input).readOnly === true,
        permissionTargets: (input) => ({ command: execInput(input).command }),
        permission: (input, context) => {
          const command = execInput(input)
          const permission = bashTool.permission({ command: command.command }, context)
          return permission.kind === "approval" && command.snapshot
            ? {
                ...permission,
                sessionKey: undefined,
                detail: `${permission.detail}\nShell snapshot: ${command.snapshot.path}\nFingerprint: ${command.snapshot.fingerprint}`,
              }
            : permission
        },
        run: (input, context) => this.execute(input, context),
      },
      tool(
        "task_output",
        {
          id,
          cursor: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 4, maximum: 65536 },
        },
        ["id"],
        async (input) =>
          this.modelControl({
            action: "output",
            id: idOf(input.id),
            cursor: input.cursor as number | undefined,
            limit: input.limit as number | undefined,
          }),
      ),
      tool(
        "task_wait",
        {
          ids: { type: "array", items: id, minItems: 1, maxItems: 128 },
          all: { type: "boolean" },
          timeoutMs: { type: "integer", minimum: 0, maximum: 30000 },
        },
        ["ids"],
        async (input) =>
          this.modelControl({
            action: "wait",
            ids: input.ids as string[],
            all: input.all as boolean | undefined,
            timeoutMs: input.timeoutMs as number | undefined,
          }),
      ),
      tool("task_kill", { id }, ["id"], async (input) =>
        this.modelControl({ action: "kill", id: idOf(input.id) }),
      ),
      tool(
        "write_stdin",
        { id, text: { type: "string", maxLength: 65536 } },
        ["id", "text"],
        async (input, context) => {
          const request = { action: "stdin" as const, id: idOf(input.id), text: input.text as string }
          return context.modelContext === false ? this.control(request) : this.modelControl(request)
        },
        (input) => this.#owned(idOf(object(input).id)).readOnly,
      ),
      tool(
        "resize_terminal",
        {
          id,
          cols: { type: "integer", minimum: 1, maximum: 500 },
          rows: { type: "integer", minimum: 1, maximum: 500 },
        },
        ["id", "cols", "rows"],
        async (input) =>
          this.modelControl({
            action: "resize",
            id: idOf(input.id),
            cols: input.cols as number,
            rows: input.rows as number,
          }),
      ),
      tool(
        "task_monitor",
        { id, cursor: { type: "integer", minimum: 0 } },
        ["id"],
        async (input, context) => {
          if (!this.#owned(idOf(input.id)).modelVisible)
            throw new Error("This task was excluded from model context")
          const stream = this.monitor(idOf(input.id), input.cursor as number | undefined)
          const abort = () => {
            void stream.return?.()
          }
          const timer = setTimeout(abort, 1000)
          context.signal.addEventListener("abort", abort, { once: true })
          let last: OutputPage | undefined
          try {
            for await (const page of stream) {
              last = page
              context.progress?.(page.text)
            }
            return last ?? this.output(idOf(input.id))
          } finally {
            clearTimeout(timer)
            context.signal.removeEventListener("abort", abort)
            await stream.return?.()
          }
        },
      ),
    ]
  }
}
