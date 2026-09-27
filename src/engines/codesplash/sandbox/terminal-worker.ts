import { constants } from "node:os"
import { installSignalHandlers, registerChildProcess } from "../../../core/lifecycle.ts"
import type { ExecutionResult } from "./contracts.ts"
import { runSupervisor, type SupervisorInput } from "./supervisor.ts"
import { terminalSandboxArgv } from "./terminal-policy.ts"
import { TerminalFrames, terminalBytes, terminalControl, terminalSize } from "./terminal-protocol.ts"

/** Only this trusted process may frame terminal output. Never forward raw child protocol bytes. */
export async function terminalSupervisorMain() {
  installSignalHandlers()
  const reader = Bun.stdin.stream().getReader()
  let header = Buffer.alloc(0),
    remainder = Buffer.alloc(0)
  for (;;) {
    const { value, done } = await reader.read()
    if (done) throw new Error("Missing terminal envelope")
    const at = value.indexOf(10),
      prefix = at < 0 ? value : value.subarray(0, at)
    if (header.length + prefix.length > 1024 * 1024) throw new Error("Terminal envelope exceeds 1 MiB")
    header = Buffer.concat([header, prefix])
    if (at >= 0) {
      remainder = Buffer.from(value.subarray(at + 1))
      break
    }
  }
  const input = JSON.parse(header.toString()) as SupervisorInput
  if (
    !input.terminal ||
    !Array.isArray(input.argv) ||
    !input.argv.length ||
    input.argv.length > 256 ||
    input.argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 3600000
  )
    throw new Error("Invalid terminal envelope")
  terminalSize(input.terminal)
  let dropped = 0,
    blocked = false
  const frame = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
  const output = (bytes: Uint8Array) => {
    for (let at = 0; at < bytes.length; at += 65536) {
      const part = bytes.subarray(at, at + 65536)
      if (blocked || process.stdout.writableLength > 1024 * 1024) {
        dropped += part.length
        continue
      }
      if (dropped) {
        frame({ kind: "dropped", bytes: dropped })
        dropped = 0
      }
      blocked = !frame({ kind: "output", data: Buffer.from(part).toString("base64") })
      if (blocked)
        process.stdout.once("drain", () => {
          blocked = false
        })
    }
  }
  const result = await runSupervisor(input, async (argv, options): Promise<ExecutionResult> => {
    let eof!: () => void
    const outputEnded = new Promise<void>((resolve) => {
      eof = resolve
    })
    const proc = Bun.spawn(terminalSandboxArgv(argv), {
      cwd: options.cwd,
      env: options.env,
      terminal: { ...input.terminal!, data: (_, bytes) => output(bytes), exit: () => eof() },
    })
    let interrupted = false,
      timedOut = false,
      failure: string | undefined,
      ended = false,
      killed = false
    const kill = () => {
      try {
        options.cleanup?.()
      } catch {
        failure = "Terminal process cleanup failed"
      }
      if (killed) return
      killed = true
      try {
        process.kill(-proc.pid, "SIGKILL")
      } catch {
        try {
          proc.kill("SIGKILL")
        } catch {}
      }
    }
    const unregister = registerChildProcess({ kill })
    const abort = () => {
      interrupted = true
      kill()
    }
    options.signal.addEventListener("abort", abort, { once: true })
    if (options.signal.aborted) abort()
    const timeout = setTimeout(() => {
      timedOut = true
      kill()
    }, input.timeoutMs)
    const parser = new TerminalFrames()
    let previous = 0
    const receive = (value: unknown) => {
      const control = terminalControl(value)
      if (control.seq !== previous + 1 || ended) throw new Error("Stale terminal control sequence")
      previous = control.seq
      if (control.kind === "resize") proc.terminal!.resize(control.cols, control.rows)
      else if (control.kind === "eof") proc.terminal!.write("\x04")
      else {
        const bytes = terminalBytes(control.data)
        const written = proc.terminal!.write(bytes)
        if (written !== bytes.length)
          throw new Error("Terminal input backpressure; input delivery incomplete")
      }
      frame({ kind: "ack", seq: control.seq })
    }
    const pump = (async () => {
      try {
        if (remainder.length) parser.push(remainder, receive)
        for (;;) {
          const { value, done } = await reader.read()
          if (done) {
            parser.end()
            if (!ended) {
              interrupted = true
              kill()
            }
            break
          }
          parser.push(value, receive)
        }
      } catch {
        if (!ended) {
          failure = "Terminal control failed"
          kill()
        }
      }
    })()
    frame({ kind: "ready" })
    try {
      await proc.exited
      ended = true
      kill()
      let drain: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          outputEnded,
          new Promise<void>((resolve) => {
            drain = setTimeout(resolve, 300)
          }),
        ])
      } finally {
        if (drain) clearTimeout(drain)
      }
      const exitCode = timedOut
        ? 124
        : interrupted
          ? 130
          : failure
            ? 126
            : (proc.exitCode ?? 128 + (constants.signals[proc.signalCode ?? "SIGTERM"] ?? 1))
      return {
        kind: timedOut
          ? "timeout"
          : interrupted
            ? "interrupted"
            : failure
              ? "unavailable"
              : exitCode === 0
                ? "success"
                : "command-failure",
        exitCode,
        stdout: "",
        stderr: failure ?? "",
      }
    } finally {
      ended = true
      clearTimeout(timeout)
      options.signal.removeEventListener("abort", abort)
      kill()
      proc.terminal!.close()
      await reader.cancel().catch(() => {})
      await pump
      unregister()
    }
  })
  if (dropped) frame({ kind: "dropped", bytes: dropped })
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(`${JSON.stringify({ kind: "result", result })}\n`, (error) =>
      error ? reject(error) : resolve(),
    ),
  )
  process.exitCode = result.exitCode
  await reader.cancel().catch(() => {})
}
