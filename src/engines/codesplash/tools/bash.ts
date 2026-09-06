/** Shell tool for the CodeSplash harness: runs commands through `bash -c` in the workspace. */
import { registerChildProcess } from "../../../core/index.ts"
import { spawnEnvWithoutStoredCredentials } from "../auth.ts"
import {
  type HarnessTool,
  type PermissionTargets,
  type ToolContext,
  ToolInputError,
  type ToolOutcome,
  type ToolPermission,
} from "../contracts.ts"
import { SecretSanitizer } from "../sandbox/env-policy.ts"
import { DEFAULT_TRUNCATE_MAX_BYTES, DEFAULT_TRUNCATE_MAX_LINES, truncateToolOutput } from "./truncate.ts"

export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 600_000
/** Grace between SIGTERM and SIGKILL on timeout or interrupt. */
export const KILL_GRACE_MS = 2_000

export const MAX_OUTPUT_LINES = DEFAULT_TRUNCATE_MAX_LINES
export const MAX_OUTPUT_BYTES = DEFAULT_TRUNCATE_MAX_BYTES
/** Stable prefix of the truncateToolOutput elision marker line. */
export const ELISION_MARKER = "[... output truncated:"

/* Collector retention far exceeds the final truncateToolOutput cap on both sides. */
const RETAIN_HEAD_BYTES = 256 * 1024
const RETAIN_TAIL_BYTES = 256 * 1024

const MAX_LABEL_LENGTH = 120

type BashInput = {
  command: string
  timeoutMs: number
}

function parseInput(input: unknown): BashInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolInputError("bash input must be an object with a `command` string")
  }
  const { command, timeout } = input as Record<string, unknown>
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new ToolInputError("bash requires `command` to be a non-empty string")
  }
  let timeoutMs = DEFAULT_TIMEOUT_MS
  if (timeout !== undefined) {
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
      throw new ToolInputError("bash `timeout` must be a positive number of milliseconds")
    }
    timeoutMs = Math.min(timeout, MAX_TIMEOUT_MS)
  }
  return { command, timeoutMs }
}

function argv0(command: string): string {
  return command.trim().split(/\s+/, 1)[0] ?? ""
}

function toLabel(command: string): string {
  const oneLine = command.replace(/\s+/g, " ").trim()
  return oneLine.length > MAX_LABEL_LENGTH ? `${oneLine.slice(0, MAX_LABEL_LENGTH - 1)}…` : oneLine
}

/**
 * Bounded accumulator for merged stdout+stderr; drops from the middle once retention is exceeded.
 * Retention far exceeds the final truncateToolOutput cap, so whenever the middle was dropped the
 * final head+tail cut always lands inside the elided region and carries the elision marker.
 */
class OutputCollector {
  #head: string[] = []
  #headBytes = 0
  #tail: string[] = []
  #tailBytes = 0

  push(text: string): void {
    if (text.length === 0) return
    const bytes = Buffer.byteLength(text, "utf8")
    if (this.#headBytes < RETAIN_HEAD_BYTES) {
      this.#head.push(text)
      this.#headBytes += bytes
      return
    }
    this.#tail.push(text)
    this.#tailBytes += bytes
    while (this.#tail.length > 1 && this.#tailBytes > RETAIN_TAIL_BYTES) {
      const dropped = this.#tail.shift() ?? ""
      this.#tailBytes -= Buffer.byteLength(dropped, "utf8")
    }
  }

  render(): string {
    return truncateToolOutput(this.#head.join("") + this.#tail.join(""), {
      maxLines: MAX_OUTPUT_LINES,
      maxBytes: MAX_OUTPUT_BYTES,
    })
  }
}

/* Orphaned children can inherit the pipes and never close them; drains stay cancelable. */
const DRAIN_GRACE_MS = 250

type Drain = { done: Promise<void>; cancel: () => void }

function drainStream(
  stream: ReadableStream<Uint8Array>,
  collector: OutputCollector,
  secrets: readonly string[] = [],
): Drain {
  const reader = stream.getReader()
  const decoder = new TextDecoder("utf-8")
  const sanitizer = new SecretSanitizer(secrets)
  const done = (async () => {
    try {
      while (true) {
        const { done: finished, value } = await reader.read()
        if (finished) break
        if (value !== undefined) collector.push(sanitizer.push(decoder.decode(value, { stream: true })))
      }
    } catch {
    } finally {
      collector.push(sanitizer.push(decoder.decode(), true))
      reader.releaseLock()
    }
  })()
  return {
    done,
    cancel: () => {
      reader.cancel().catch(() => {})
    },
  }
}

async function raceAgainstGrace(drains: Promise<unknown>, graceMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      drains.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), graceMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function signalExitCode(signal: string | null): number {
  if (signal === "SIGKILL") return 137
  if (signal === "SIGTERM") return 143
  return 1
}

export const bashTool: HarnessTool = {
  name: "bash",

  description:
    "Runs a shell command via `bash -c` in the workspace directory. stdout and stderr are merged; " +
    `output is truncated head+tail to ${MAX_OUTPUT_LINES} lines / ${MAX_OUTPUT_BYTES} bytes and the ` +
    `exit code is appended. Default timeout ${DEFAULT_TIMEOUT_MS}ms, maximum ${MAX_TIMEOUT_MS}ms.`,

  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The bash command to execute.",
      },
      timeout: {
        type: "number",
        description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
      },
      secrets: {
        type: "array",
        items: { type: "string" },
        maxItems: 16,
        description:
          "Named OS-keyring secrets to bind to this command's environment; always requires explicit approval",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },

  isReadOnly(): boolean {
    return false
  },

  permissionTargets(input: unknown): PermissionTargets {
    return { command: parseInput(input).command }
  },

  permission(input: unknown, context: ToolContext): ToolPermission {
    const { command } = parseInput(input)
    const { sandbox, approvalPolicy } = context.policy
    if (sandbox === "danger-full-access") return { kind: "none" }
    const approval: ToolPermission = {
      kind: "approval",
      title: "Run command?",
      detail: `${command}\n${context.cwd}`,
    }
    if (sandbox === "workspace-write" && approvalPolicy === "on-request") {
      return { ...approval, sessionKey: `bash:${argv0(command)}` }
    }
    return approval
  },

  async run(input: unknown, context: ToolContext): Promise<ToolOutcome> {
    const { command, timeoutMs } = parseInput(input)
    const label = toLabel(command)
    if (context.signal.aborted) {
      return { text: "Command was interrupted before it started.", isError: true, label }
    }

    const proc = Bun.spawn(["bash", "-c", command], {
      cwd: context.cwd,
      // API keys injected from the 0600 credential store must not leak into arbitrary spawned
      // commands (or their output, which is transcribed and recorded); shell-exported keys pass.
      env: spawnEnvWithoutStoredCredentials(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // Group leader: timeout/interrupt signals must reach the whole pipeline (bash does not
      // forward SIGTERM to non-interactive children), not just the shell itself.
      detached: true,
    })

    /** Signals the child's whole process group, falling back to the shell alone. */
    const signalProcessGroup = (signal: "SIGTERM" | "SIGKILL") => {
      try {
        process.kill(-proc.pid, signal)
      } catch {
        try {
          proc.kill(signal)
        } catch {}
      }
    }
    // A dying harness (crash, second Ctrl+C, process.exit) must not orphan the command.
    const unregisterChild = registerChildProcess({ kill: () => signalProcessGroup("SIGKILL") })

    const collector = new OutputCollector()
    let timedOut = false
    let interrupted = false
    let graceTimer: ReturnType<typeof setTimeout> | undefined

    const killWithGrace = () => {
      signalProcessGroup("SIGTERM")
      graceTimer = setTimeout(() => signalProcessGroup("SIGKILL"), KILL_GRACE_MS)
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      killWithGrace()
    }, timeoutMs)
    const onAbort = () => {
      interrupted = true
      killWithGrace()
    }
    context.signal.addEventListener("abort", onAbort, { once: true })

    const stdoutDrain = drainStream(proc.stdout, collector, context.secretValues)
    const stderrDrain = drainStream(proc.stderr, collector, context.secretValues)
    try {
      await proc.exited
      const drains = Promise.all([stdoutDrain.done, stderrDrain.done])
      const drained = await raceAgainstGrace(drains, DRAIN_GRACE_MS)
      if (!drained) {
        stdoutDrain.cancel()
        stderrDrain.cancel()
        await drains
      }
    } finally {
      clearTimeout(timeoutTimer)
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer)
        // The shell can exit while stubborn group members survive SIGTERM; make sure the
        // whole group is gone before the harness releases it.
        signalProcessGroup("SIGKILL")
      }
      context.signal.removeEventListener("abort", onAbort)
      unregisterChild()
    }

    const exitCode = proc.exitCode ?? signalExitCode(proc.signalCode)
    const body = collector.render()
    const footer: string[] = []
    if (timedOut) footer.push(`Command timed out after ${timeoutMs}ms and was killed.`)
    else if (interrupted) footer.push("Command was interrupted.")
    footer.push(`Exit code: ${exitCode}`)

    return {
      text: body.length > 0 ? `${body}\n${footer.join("\n")}` : footer.join("\n"),
      isError: timedOut || interrupted || exitCode !== 0,
      label,
    }
  },
}
