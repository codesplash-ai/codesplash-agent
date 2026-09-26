import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { registerChildProcess, registerCleanup } from "../core/lifecycle.ts"
import { redactSensitiveText } from "../core/redaction.ts"
import { atomic, bytes, digest } from "../core/session/files.ts"

export type TerminalIntegrations = {
  version: 1
  statusLine?: string[]
  voice?: { record: string[]; transcribe: string[]; diagnostic?: string[] }
}
export type TerminalReview = {
  config: TerminalIntegrations
  fingerprint: string
  trusted: boolean
  executables: string[]
}
export function reviewTerminalIntegrations(directory: string): TerminalReview {
  const source = bytes(join(directory, "terminal-integrations.json"), 65536)
  const config = JSON.parse(source.toString("utf8")) as TerminalIntegrations
  if (
    config.version !== 1 ||
    Object.keys(config).some((key) => !["version", "statusLine", "voice"].includes(key))
  )
    throw new Error("Invalid terminal integrations version/fields")
  if (
    config.voice &&
    Object.keys(config.voice).some((key) => !["record", "transcribe", "diagnostic"].includes(key))
  )
    throw new Error("Invalid voice configuration")
  const commands = [
    config.statusLine,
    config.voice?.record,
    config.voice?.transcribe,
    config.voice?.diagnostic,
  ].filter((value) => value !== undefined)
  if (config.voice && (!config.voice.record || !config.voice.transcribe))
    throw new Error("Voice needs record and transcribe commands")
  const executables: string[] = [],
    hashes: string[] = []
  for (const argv of commands) {
    if (
      !Array.isArray(argv) ||
      !argv.length ||
      argv.length > 32 ||
      argv.some(
        (part) =>
          typeof part !== "string" ||
          part.length > 4096 ||
          part.includes("\0") ||
          part.includes("\r") ||
          part.includes("\n"),
      )
    )
      throw new Error("Terminal commands must be bounded argv arrays")
    const candidate = Bun.which(argv[0]!)
    if (!candidate) throw new Error(`Terminal executable unavailable: ${argv[0]}`)
    const executable = realpathSync(candidate)
    executables.push(executable)
    // Fingerprint the resolved bytes, never expose executable or script contents.
    hashes.push(digest(bytes(executable, 256 * 1024 * 1024)))
    for (const argument of argv.slice(1)) {
      if (/\.(?:js|ts|mjs|cjs|sh|py|rb)$/.test(argument) && !isAbsolute(argument))
        throw new Error("Terminal script paths must be absolute for content review")
      if (isAbsolute(argument) && !argument.includes("{audio}")) {
        try {
          hashes.push(digest(bytes(argument, 256 * 1024 * 1024)))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
      }
    }
  }
  const fingerprint = digest(JSON.stringify({ source: source.toString(), executables, hashes }))
  let trusted = false
  try {
    trusted =
      JSON.parse(bytes(join(directory, "terminal-trust.json"), 4096).toString()).fingerprint === fingerprint
  } catch {}
  return { config, fingerprint, executables, trusted }
}
export function trustTerminalIntegrations(directory: string, reviewed: string): void {
  if (reviewTerminalIntegrations(directory).fingerprint !== reviewed)
    throw new Error("Terminal configuration changed; review again")
  atomic(join(directory, "terminal-trust.json"), JSON.stringify({ version: 1, fingerprint: reviewed }))
}
export function terminalText(value: string, limit = 512): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: remove terminal control sequences from external status/voice text.
  const escapeSequences = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g
  // biome-ignore lint/suspicious/noControlCharactersInRegex: external text cannot emit C0/C1 terminal controls.
  const controls = /[\x00-\x1f\x7f-\x9f]/g
  return redactSensitiveText(value).replace(escapeSequences, "").replace(controls, " ").slice(0, limit)
}
export function minimalTerminalEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "TMPDIR",
      "TMP",
      "TEMP",
      "LANG",
      "LC_ALL",
      "SYSTEMROOT",
      "WINDIR",
      "DISPLAY",
      "WAYLAND_DISPLAY",
      "XDG_RUNTIME_DIR",
      "DBUS_SESSION_BUS_ADDRESS",
    ].flatMap((key) => (env[key] ? [[key, env[key]]] : [])),
  )
}
export async function runTerminalCommand(
  argv: string[],
  options: {
    input?: string
    cwd: string
    signal?: AbortSignal
    timeoutMs?: number
    maxBytes?: number
    gracefulStop?: AbortSignal
    captureStderr?: boolean
    acceptNonzero?: boolean
  },
): Promise<string> {
  options.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: minimalTerminalEnvironment(),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    })
    let output = Buffer.alloc(0),
      failure: Error | undefined,
      ended = false
    const kill = (signal: NodeJS.Signals = "SIGKILL") => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {}
    }
    const abort = () => {
      failure = new Error("Terminal command cancelled")
      kill()
    }
    let stopTimer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      kill("SIGINT")
      stopTimer ??= setTimeout(() => kill(), 2000)
    }
    const untrack = registerChildProcess({ kill: () => kill() }),
      unregister = registerCleanup(() => kill())
    const timer = setTimeout(() => {
      failure = new Error("Terminal command timed out")
      kill()
    }, options.timeoutMs ?? 1000)
    const done = (error?: Error) => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      if (stopTimer) clearTimeout(stopTimer)
      kill()
      untrack()
      unregister()
      options.signal?.removeEventListener("abort", abort)
      options.gracefulStop?.removeEventListener("abort", stop)
      if (failure || error) reject(failure ?? error)
      else resolve(new TextDecoder("utf-8", { fatal: false }).decode(output))
    }
    const capture = (chunk: Buffer) => {
      if (output.length + chunk.length > (options.maxBytes ?? 4096)) {
        failure = new Error("Terminal command output limit exceeded")
        kill()
      } else output = Buffer.concat([output, chunk])
    }
    child.stdout.on("data", capture)
    // Consume stderr without retaining potentially sensitive child diagnostics.
    if (options.captureStderr) child.stderr.on("data", capture)
    else child.stderr.resume()
    child.stdin.on("error", () => {})
    child.stdin.end(options.input ?? "")
    child.once("error", () => done(new Error("Could not start terminal command")))
    child.once("close", (code) =>
      done(
        code === 0 || options.acceptNonzero || (options.gracefulStop?.aborted && code === 255)
          ? undefined
          : new Error(`Terminal command failed (${code ?? "signal"})`),
      ),
    )
    options.signal?.addEventListener("abort", abort, { once: true })
    options.gracefulStop?.addEventListener("abort", stop, { once: true })
    if (options.signal?.aborted) abort()
    else if (options.gracefulStop?.aborted) stop()
  })
}
