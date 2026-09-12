import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerChildProcess } from "../../../core/lifecycle.ts"
import type { ExecutionResult, SandboxProfile } from "./contracts.ts"
import { internalCommand } from "./entrypoint.ts"
import { childEnvironment } from "./env-policy.ts"
import { createMacReaper } from "./macos-reaper.ts"
import { runProcess } from "./process.ts"
import { physicalPath } from "./profile.ts"
import type { SupervisorInput } from "./supervisor.ts"
import { TerminalFrames, type TerminalSize, terminalBytes, terminalSize } from "./terminal-protocol.ts"

export type SandboxTerminal = {
  readonly finished: Promise<ExecutionResult>
  write(bytes: Uint8Array): Promise<void>
  resize(cols: number, rows: number): Promise<void>
  end(): Promise<void>
  close(): Promise<void>
}
export type TerminalOptions = TerminalSize & { timeoutMs: number }
export async function openSandboxTerminal(
  profile: SandboxProfile,
  argv: string[],
  options: TerminalOptions,
  signal: AbortSignal,
  output: (bytes: Uint8Array) => void,
  redactions: string[] = [],
): Promise<SandboxTerminal> {
  signal.throwIfAborted()
  terminalSize(options)
  if (profile.mode === "danger-full-access") throw new Error("Interactive tasks require an enforced sandbox")
  if (
    !argv.length ||
    argv.length > 256 ||
    argv.some((arg) => !arg || arg.includes("\0") || arg.length > 65536) ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 3600000
  )
    throw new Error("Invalid terminal command or timeout")
  const temp = physicalPath(await mkdtemp(join(tmpdir(), "codesplash-terminal-")))
  let reaper: Awaited<ReturnType<typeof createMacReaper>> | undefined, unregister: (() => void) | undefined
  const abort = new AbortController(),
    cancel = () => abort.abort(signal.reason)
  signal.addEventListener("abort", cancel, { once: true })
  if (signal.aborted) cancel()
  try {
    if (process.platform === "darwin") {
      reaper = await createMacReaper()
      unregister = registerChildProcess(reaper)
    }
    const pipe = new TransformStream<Uint8Array, Uint8Array>(
      undefined,
      { highWaterMark: 256 * 1024, size: (c) => c?.byteLength ?? 0 },
      { highWaterMark: 256 * 1024, size: (c) => c?.byteLength ?? 0 },
    )
    const writer = pipe.writable.getWriter(),
      parser = new TerminalFrames()
    const pending = new Map<
      number,
      { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
    >()
    let ready!: () => void,
      fail!: (error: Error) => void,
      started = false,
      closed = false,
      sequence = 0,
      result: ExecutionResult | undefined
    const initialized = new Promise<void>((resolve, reject) => {
      ready = resolve
      fail = reject
    })
    void initialized.catch(() => {})
    const receive = (value: unknown) => {
      if (!value || typeof value !== "object" || result) throw new Error("Invalid terminal response")
      const frame = value as {
        kind: string
        data?: string
        bytes?: number
        seq?: number
        result?: ExecutionResult
      }
      if (frame.kind === "ready" && !started) {
        started = true
        ready()
      } else if (frame.kind === "output" && started) output(terminalBytes(frame.data))
      else if (frame.kind === "dropped" && started && Number.isSafeInteger(frame.bytes) && frame.bytes! > 0)
        output(Buffer.from(`\n[terminal output dropped: ${frame.bytes} bytes]\n`))
      else if (frame.kind === "ack" && started && pending.has(frame.seq!)) {
        const item = pending.get(frame.seq!)!
        clearTimeout(item.timer)
        pending.delete(frame.seq!)
        item.resolve()
      } else if (
        frame.kind === "result" &&
        frame.result &&
        ["success", "command-failure", "sandbox-denial", "unavailable", "timeout", "interrupted"].includes(
          frame.result.kind,
        ) &&
        Number.isSafeInteger(frame.result.exitCode) &&
        typeof frame.result.stderr === "string"
      )
        result = frame.result
      else throw new Error("Unexpected terminal response")
    }
    const envelope: SupervisorInput = {
      profile: structuredClone(profile),
      argv: [...argv],
      temp,
      timeoutMs: options.timeoutMs,
      workloadEnv: childEnvironment(temp, profile.environment),
      cleanupTag: reaper?.tag,
      terminal: terminalSize(options),
      redactions,
    }
    const header = Buffer.from(`${JSON.stringify(envelope)}\n`)
    if (header.length > 1024 * 1024) throw new Error("Terminal envelope exceeds 1 MiB")
    const processResult = runProcess(internalCommand("pty-supervisor"), {
      cwd: profile.cwd,
      env: childEnvironment(temp),
      inputStream: pipe.readable,
      signal: abort.signal,
      timeoutMs: options.timeoutMs + 15000,
      structured: true,
      maxBytes: 4096,
      onStdout: (bytes) => parser.push(bytes, receive),
      cleanup: () => reaper?.kill(),
    })
    const finished = processResult
      .then((outer) => {
        parser.end()
        return (
          result ??
          ({
            kind: outer.kind === "interrupted" ? "interrupted" : "unavailable",
            exitCode: outer.exitCode || 126,
            stdout: "",
            stderr: "Terminal supervisor stopped without a confirmed result",
          } as ExecutionResult)
        )
      })
      .finally(async () => {
        closed = true
        fail(new Error("Terminal stopped before readiness"))
        for (const entry of pending.values()) {
          clearTimeout(entry.timer)
          entry.reject(new Error("Terminal closed"))
        }
        pending.clear()
        signal.removeEventListener("abort", cancel)
        await writer.abort().catch(() => {})
        reaper?.kill()
        unregister?.()
        await rm(temp, { recursive: true, force: true })
      })
    void finished.catch(() => {})
    const readiness = setTimeout(() => {
      fail(new Error("Terminal initialization timed out"))
      abort.abort()
    }, 10000)
    try {
      await writer.write(header)
      await initialized
    } catch (error) {
      abort.abort()
      await finished.catch(() => {})
      throw error
    } finally {
      clearTimeout(readiness)
    }
    const send = async (body: object) => {
      if (closed || abort.signal.aborted) throw new Error("Terminal is closed")
      if (pending.size >= 8) throw new Error("Terminal input queue is full")
      const seq = ++sequence,
        bytes = Buffer.from(`${JSON.stringify({ ...body, seq })}\n`)
      if (writer.desiredSize === null || writer.desiredSize < bytes.length) {
        sequence--
        throw new Error("Terminal input queue is full")
      }
      const ack = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(seq)
          reject(new Error("Terminal input acknowledgment timed out; delivery is uncertain"))
          abort.abort()
        }, 5000)
        pending.set(seq, { resolve, reject, timer })
      })
      void ack.catch(() => {})
      try {
        await writer.write(bytes)
        await ack
      } catch (error) {
        abort.abort()
        throw error
      }
    }
    return {
      finished,
      write: async (bytes) => {
        if (bytes.byteLength > 65536) throw new Error("Terminal input exceeds 64 KiB")
        await send({ kind: "stdin", data: Buffer.from(bytes).toString("base64") })
      },
      resize: async (cols, rows) => {
        terminalSize({ cols, rows })
        await send({ kind: "resize", cols, rows })
      },
      end: () => send({ kind: "eof" }),
      close: async () => {
        abort.abort(new Error("Terminal closed"))
        await finished.catch(() => {})
      },
    }
  } catch (error) {
    signal.removeEventListener("abort", cancel)
    abort.abort()
    reaper?.kill()
    unregister?.()
    await rm(temp, { recursive: true, force: true })
    throw error
  }
}
