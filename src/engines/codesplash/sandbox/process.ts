import { constants } from "node:os"
import { registerChildProcess } from "../../../core/lifecycle.ts"
import { redactSensitiveText } from "../../../core/redaction.ts"
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
    timeoutMs?: number
    secrets?: string[]
    maxBytes?: number
    detached?: boolean
    /** Structured internal transports sanitize parsed values at their producer, never JSON syntax. */
    structured?: boolean
    cleanup?: () => void
  },
): Promise<ExecutionResult> {
  if (options.signal.aborted)
    return { kind: "interrupted", exitCode: 130, stdout: "", stderr: "Interrupted before execution" }
  const proc = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: options.detached !== false,
  })
  let timedOut = false,
    interrupted = false
  const kill = (signal: "SIGTERM" | "SIGKILL") => {
    if (signal === "SIGKILL") options.cleanup?.()
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
  const timeout = setTimeout(() => {
    timedOut = true
    stop()
  }, options.timeoutMs ?? 120_000)
  const max = options.maxBytes ?? 1024 * 1024
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = []
  async function drain(stream: ReadableStream<Uint8Array>) {
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
        retain(sanitizer.push(decoder.decode(value, { stream: true })))
      }
    } catch {
    } finally {
      reader.releaseLock()
    }
    retain(sanitizer.push(decoder.decode(), true))
    const result = overflow
      ? `${head.toString("utf8")}\n[output truncated]\n${tail.toString("utf8")}`
      : Buffer.concat([head, tail]).toString("utf8")
    return options.structured ? result : redactSensitiveText(result, options.env)
  }
  const stdout = drain(proc.stdout),
    stderr = drain(proc.stderr)
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
      kind: interrupted
        ? "interrupted"
        : timedOut
          ? "timeout"
          : exitCode === 0
            ? "success"
            : "command-failure",
      exitCode,
      stdout: out,
      stderr: err,
    }
  } finally {
    clearTimeout(timeout)
    if (grace) clearTimeout(grace)
    options.signal.removeEventListener("abort", abort)
    kill("SIGKILL")
    unregister()
  }
}
