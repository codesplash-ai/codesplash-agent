export type TerminalHandoffOptions = {
  command: readonly string[]
  cwd?: string
  env?: Record<string, string | undefined>
  stdio?: "inherit" | "ignore"
  signal?: AbortSignal
}

export type TerminalHandoffResult = {
  exitCode: number
  signalCode: NodeJS.Signals | null
}

const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]

/**
 * Give a child process the real terminal, then restore terminal modes even when
 * the child exits from a signal or must be forcefully aborted.
 */
export async function runTerminalHandoff(options: TerminalHandoffOptions): Promise<TerminalHandoffResult> {
  if (options.command.length === 0) throw new Error("Terminal handoff requires a command")

  const terminalState = captureTerminalState()
  const stdio = options.stdio ?? "inherit"
  const child = Bun.spawn([...options.command], {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdin: stdio,
    stdout: stdio,
    stderr: stdio,
  })

  const forwarders = new Map<NodeJS.Signals, () => void>()
  for (const signal of FORWARDED_SIGNALS) {
    const forward = () => safelyKill(child, signal)
    forwarders.set(signal, forward)
    process.on(signal, forward)
  }

  const abort = () => safelyKill(child, "SIGKILL")
  options.signal?.addEventListener("abort", abort, { once: true })
  if (options.signal?.aborted) abort()

  try {
    const exitCode = await child.exited
    return { exitCode, signalCode: child.signalCode }
  } finally {
    for (const [signal, forward] of forwarders) process.off(signal, forward)
    options.signal?.removeEventListener("abort", abort)
    restoreTerminalState(terminalState)
  }
}

function safelyKill(child: Bun.Subprocess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch {
    // The child may have exited between the signal and this handler.
  }
}

function captureTerminalState(): string | undefined {
  if (!process.stdin.isTTY) return undefined
  const result = Bun.spawnSync(["stty", "-g"], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "ignore",
  })
  if (result.exitCode !== 0) return undefined
  const state = result.stdout.toString().trim()
  return state || undefined
}

function restoreTerminalState(state: string | undefined): void {
  if (state) {
    Bun.spawnSync(["stty", state], {
      stdin: "inherit",
      stdout: "ignore",
      stderr: "ignore",
    })
  }

  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l")
  }
}
