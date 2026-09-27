import { constants } from "node:os"
import { registerChildProcess } from "../../../core/lifecycle.ts"
import { redactSensitiveText } from "../../../core/redaction.ts"
import { windowsProcessJob } from "../../../core/session/windows-native.ts"
import type { ExecutionResult } from "./contracts.ts"
import { SecretSanitizer } from "./env-policy.ts"

/** Bounded transport shared by supervisors and commands; sanitize before retaining output. */
export async function runProcess(
  argv: string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    signal: AbortSignal
    input?: string
    /** Owned long-lived transports stream input until close; never combine with input. */
    inputStream?: ReadableStream<Uint8Array>
    onStdout?: (chunk: Uint8Array) => void | Promise<void>
    timeoutMs?: number
    secrets?: string[]
    maxBytes?: number
    detached?: boolean
    /** Structured internal transports sanitize parsed values at their producer, never JSON syntax. */
    structured?: boolean
    cleanup?: () => void
  },
): Promise<ExecutionResult> {
  if (process.env.CODESPLASH_STARTUP_BRIDGE) {
    const role = argv.at(-1)?.replace(/^--internal-sandbox-/, "")
    if (role && ["supervisor", "stream-supervisor", "pty-supervisor"].includes(role))
      return (await import("../../../core/startup-bridge.ts")).runStartupTransport(role, options)
  }
  if (options.input !== undefined && options.inputStream)
    throw new Error("Process input and inputStream are mutually exclusive")
  if (options.signal.aborted)
    return { kind: "interrupted", exitCode: 130, stdout: "", stderr: "Interrupted before execution" }
  const proc = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: options.input === undefined && !options.inputStream ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: options.detached !== false,
  })
  let windowsJob: (() => void) | undefined
  if (process.platform === "win32") {
    try {
      windowsJob = windowsProcessJob(proc.pid)
    } catch (error) {
      proc.kill("SIGKILL")
      await proc.exited
      throw error
    }
  }
  let timedOut = false,
    interrupted = false,
    cleanupFailed = false
  const kill = (signal: "SIGTERM" | "SIGKILL") => {
    if (signal === "SIGKILL") {
      try {
        try {
          options.cleanup?.()
        } finally {
          windowsJob?.()
        }
      } catch {
        cleanupFailed = true
      }
    }
    try {
      if (options.detached !== false) process.kill(-proc.pid, signal)
      else proc.kill(signal)
    } catch {
      try {
        proc.kill(signal)
      } catch {}
    }
  }
  const unregister = registerChildProcess({ kill: () => kill("SIGKILL") })
  let grace: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    kill("SIGTERM")
    grace ??= setTimeout(() => kill("SIGKILL"), 500)
  }
  const abort = () => {
    interrupted = true
    stop()
  }
  options.signal.addEventListener("abort", abort, { once: true })
  if (options.signal.aborted) abort()
  const timeout =
    options.timeoutMs === 0
      ? undefined
      : setTimeout(() => {
          timedOut = true
          stop()
        }, options.timeoutMs ?? 120_000)
  const max = options.maxBytes ?? 1024 * 1024
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = []
  async function drain(stream: ReadableStream<Uint8Array>, output = false) {
    const decoder = new TextDecoder(),
      sanitizer = new SecretSanitizer(options.secrets ?? [])
    let head = Buffer.alloc(0),
      tail = Buffer.alloc(0),
      overflow = false
    const half = Math.max(1, Math.floor(max / 2))
    function retain(s: string) {
      let bytes = Buffer.from(s)
      if (head.length < half) {
        const n = Math.min(half - head.length, bytes.length)
        head = Buffer.concat([head, bytes.subarray(0, n)])
        bytes = bytes.subarray(n)
      }
      if (bytes.length) {
        overflow ||= tail.length + bytes.length > half
        tail = Buffer.concat([tail, bytes]).subarray(-half)
      }
    }
    const reader = stream.getReader()
    readers.push(reader)
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (output && options.onStdout) await options.onStdout(value)
        retain(sanitizer.push(decoder.decode(value, { stream: true })))
      }
    } catch {
      stop()
    } finally {
      reader.releaseLock()
    }
    retain(sanitizer.push(decoder.decode(), true))
    const result = overflow
      ? `${head.toString("utf8")}\n[output truncated]\n${tail.toString("utf8")}`
      : Buffer.concat([head, tail]).toString("utf8")
    return options.structured ? result : redactSensitiveText(result, options.env)
  }
  const stdout = drain(proc.stdout, true),
    stderr = drain(proc.stderr)
  const inputReader = options.inputStream?.getReader()
  const inputPump = (async () => {
    if (!inputReader || typeof proc.stdin === "number" || !proc.stdin) return
    try {
      while (true) {
        const { value, done } = await inputReader.read()
        if (done) break
        proc.stdin.write(value)
        await proc.stdin.flush()
      }
      await proc.stdin.end()
    } catch {
      stop()
    } finally {
      inputReader.releaseLock()
    }
  })()
  if (options.input !== undefined && typeof proc.stdin !== "number" && proc.stdin) {
    try {
      proc.stdin.write(options.input)
      await proc.stdin.end()
    } catch {}
  }
  try {
    await proc.exited
    // Kill surviving grandchildren before draining: inherited output pipes otherwise never close.
    kill("SIGKILL")
    // A detached descendant may retain a pipe. Bound the drain independently
    // of process exit so a completed/aborted tool cannot hang the session.
    const drainLimit = setTimeout(() => {
      for (const reader of readers) void reader.cancel().catch(() => {})
    }, 500)
    const [out, err] = await Promise.all([stdout, stderr]).finally(() => clearTimeout(drainLimit))
    const signalExit = proc.signalCode ? 128 + (constants.signals[proc.signalCode] ?? 1) : 1
    const exitCode = interrupted ? 130 : timedOut ? 124 : (proc.exitCode ?? signalExit)
    return {
      kind: cleanupFailed
        ? "unavailable"
        : interrupted
          ? "interrupted"
          : timedOut
            ? "timeout"
            : exitCode === 0
              ? "success"
              : "command-failure",
      exitCode: cleanupFailed ? 126 : exitCode,
      stdout: out,
      stderr: cleanupFailed ? `${err}\nProcess cleanup failed` : err,
    }
  } finally {
    if (timeout) clearTimeout(timeout)
    if (grace) clearTimeout(grace)
    options.signal.removeEventListener("abort", abort)
    kill("SIGKILL")
    if (inputReader) await inputReader.cancel().catch(() => {})
    await inputPump
    unregister()
  }
}
