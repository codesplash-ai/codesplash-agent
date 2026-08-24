#!/usr/bin/env bun

import { statSync } from "node:fs"
import type { AppOptions } from "./core/app-options.ts"
import type { ConfigSandboxMode } from "./core/config.ts"
import type { EngineDriver } from "./core/engine.ts"
import type { SessionRecorder } from "./core/session-recorder.ts"
import type { SessionStore } from "./core/sessions.ts"
import type { ProviderId } from "./engines/codesplash/contracts.ts"
import type { HeadlessOutputFormat, HeadlessSink } from "./engines/codesplash/runner.ts"

function printHelp() {
  process.stdout.write(`CodeSplash Agent

Usage:
  codesplash [path] [--no-history] [--sandbox <mode>] [--full-access]
  codesplash login <anthropic|openai> [--api-key <key>]
  codesplash logout <anthropic|openai>
  codesplash run [path] [-p|--prompt <text>] [run options]
  codesplash --doctor
  codesplash --version
  codesplash --fixture
  codesplash --codex-smoke
  codesplash --codex-live-smoke
  codesplash --claude-handoff-smoke
  codesplash --help

Commands:
  login          Store an API key for the native CodeSplash engine. Without --api-key the key is
                 read from stdin — hidden when the terminal is interactive, a plain line otherwise
  logout         Remove a stored API key
  run            Run one headless CodeSplash turn and exit. The prompt comes from -p/--prompt,
                 else the remaining positional text, else piped stdin

Options:
  path           Project directory (defaults to the current directory)
  --doctor       Print non-interactive diagnostics (runtime, engines, auth, paths) and exit
  --version      Print the application version and exit
  --no-history   Do not write session metadata or event history for this run
  --sandbox <mode>
                 Override the configured sandbox: read-only or workspace-write
  --full-access  Run without a sandbox after an explicit confirmation (interactive sessions only)
  --fixture      Render the synthetic OpenTUI development fixture
  --codex-smoke  Check Codex app-server startup, protocol, and account state without running a model
  --codex-live-smoke
                 Use model quota to exercise approval, interrupt, resume, and a second turn
  --claude-handoff-smoke
                 Hand the real terminal to Claude Code for a quota-free version check

Run options:
  -p, --prompt <text>        Prompt text for the turn
  --model <id[:effort]>      Model id, optionally with :low, :medium, or :high reasoning effort
  --output-format <format>   text (default), json, or stream-json
  --auto                     Accept approval requests instead of declining them
  --max-turns <n>            Upper bound on turns for the run (default 40)
  --sandbox <mode>           read-only or workspace-write
  --no-history               Do not write session files for this run
`)
}

/** A caller mistake (bad flags, missing prompt): printed to stderr, exit code 2. */
export class UsageError extends Error {
  override readonly name = "UsageError"
}

export function parseAppArguments(args: string[]): { path?: string; options: AppOptions } {
  const options: AppOptions = { noHistory: false, fullAccess: false }
  let path: string | undefined

  for (let index = 0; index < args.length; index++) {
    const argument = args[index] as string
    if (argument === "--no-history") {
      options.noHistory = true
    } else if (argument === "--full-access") {
      options.fullAccess = true
    } else if (argument === "--sandbox" || argument.startsWith("--sandbox=")) {
      const value = argument.includes("=") ? argument.slice("--sandbox=".length) : args[++index]
      if (value === "read-only" || value === "workspace-write") {
        options.sandboxOverride = value
      } else if (value === "danger-full-access") {
        throw new Error("Use --full-access to run without a sandbox; it requires confirmation")
      } else {
        throw new Error(`--sandbox expects read-only or workspace-write, got ${value ?? "nothing"}`)
      }
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option ${argument}`)
    } else if (path === undefined) {
      path = argument
    } else {
      throw new Error("Expected at most one project path")
    }
  }

  return { path, options }
}

/* ------------------------------- login / logout subcommands ------------------------------- */

export type LoginCommand = { provider: ProviderId; apiKey?: string }

/**
 * Provider arguments are never echoed back in errors: a user who pastes the key where the
 * provider belongs must not see it leak into stderr or logs.
 */
function parseProviderArgument(command: string, value: string | undefined): ProviderId {
  if (value === "anthropic" || value === "openai") return value
  if (value === undefined) {
    throw new UsageError(`${command} expects a provider: codesplash ${command} <anthropic|openai>`)
  }
  throw new UsageError(`Unknown provider for ${command}; expected anthropic or openai`)
}

export function parseLoginArguments(args: string[]): LoginCommand {
  let provider: ProviderId | undefined
  let apiKey: string | undefined

  for (let index = 0; index < args.length; index++) {
    const argument = args[index] as string
    if (argument === "--api-key" || argument.startsWith("--api-key=")) {
      const value = argument.includes("=") ? argument.slice("--api-key=".length) : args[++index]
      if (value === undefined) throw new UsageError("--api-key expects a value")
      apiKey = value
    } else if (argument.startsWith("-")) {
      throw new UsageError(`Unknown option ${argument} for login`)
    } else if (provider === undefined) {
      provider = parseProviderArgument("login", argument)
    } else {
      throw new UsageError("login expects exactly one provider")
    }
  }

  return { provider: parseProviderArgument("login", provider), apiKey }
}

export function parseLogoutArguments(args: string[]): { provider: ProviderId } {
  let provider: ProviderId | undefined

  for (const argument of args) {
    if (argument.startsWith("-")) {
      throw new UsageError(`Unknown option ${argument} for logout`)
    }
    if (provider !== undefined) throw new UsageError("logout expects exactly one provider")
    provider = parseProviderArgument("logout", argument)
  }

  return { provider: parseProviderArgument("logout", provider) }
}

/** Test seams for the credential commands; every field defaults to the real process surface. */
export type CredentialCommandIo = {
  env?: NodeJS.ProcessEnv
  stdout?: HeadlessSink
  stderr?: HeadlessSink
  /** Overrides interactive detection for the stdin key read. */
  stdinIsTty?: boolean
  /** Replaces the non-interactive stdin read (piped key or piped prompt). */
  readStdinText?: () => Promise<string>
  /** Replaces the hidden interactive key read entirely. */
  readSecret?: (prompt: string) => Promise<string>
}

export async function runLoginCommand(args: string[], io: CredentialCommandIo = {}): Promise<number> {
  const { provider, apiKey } = parseLoginArguments(args)
  const env = io.env ?? process.env
  const stdout = io.stdout ?? process.stdout
  const key = apiKey ?? (await readApiKeyFromStdin(provider, io))
  if (key.trim() === "") throw new UsageError("API key must be a non-empty string")

  const { credentialsFilePath, setApiKey } = await import("./engines/codesplash/auth.ts")
  setApiKey(provider, key, env)
  stdout.write(`Saved ${provider} API key to ${credentialsFilePath(env)}\n`)
  return 0
}

export async function runLogoutCommand(args: string[], io: CredentialCommandIo = {}): Promise<number> {
  const { provider } = parseLogoutArguments(args)
  const { deleteApiKey } = await import("./engines/codesplash/auth.ts")
  const removed = deleteApiKey(provider, io.env ?? process.env)
  const stdout = io.stdout ?? process.stdout
  stdout.write(removed ? `Removed stored ${provider} API key\n` : `No stored ${provider} API key\n`)
  return 0
}

/** Interactive terminals get a hidden (no-echo) read; piped stdin falls back to a plain line. */
async function readApiKeyFromStdin(provider: ProviderId, io: CredentialCommandIo): Promise<string> {
  const prompt = `Enter ${provider} API key (input is hidden): `
  if (io.readSecret) return io.readSecret(prompt)
  const isTty = io.stdinIsTty ?? process.stdin.isTTY === true
  if (isTty) return readSecretFromTty(prompt, io.stderr ?? process.stderr)
  const text = await (io.readStdinText ?? readAllOfStdin)()
  return text.split(/\r?\n/, 1)[0] ?? ""
}

function readAllOfStdin(): Promise<string> {
  return Bun.stdin.text()
}

/** Raw-mode line read that never echoes: Enter/Ctrl-D submit, Backspace edits, Ctrl-C cancels. */
function readSecretFromTty(prompt: string, stderr: HeadlessSink): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    stderr.write(prompt)
    stdin.setRawMode?.(true)
    stdin.resume()
    const bytes: number[] = []

    const finish = (error: Error | undefined, value: string): void => {
      stdin.removeListener("data", onData)
      stdin.setRawMode?.(false)
      stdin.pause()
      stderr.write("\n")
      if (error) reject(error)
      else resolve(value)
    }

    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 0x03) {
          finish(new Error("login cancelled"), "")
          return
        }
        if (byte === 0x0d || byte === 0x0a || byte === 0x04) {
          finish(undefined, Buffer.from(bytes).toString("utf8"))
          return
        }
        if (byte === 0x7f || byte === 0x08) {
          bytes.pop()
          continue
        }
        bytes.push(byte)
      }
    }

    stdin.on("data", onData)
  })
}

/* ------------------------------------- run subcommand ------------------------------------- */

export type RunCommand = {
  path?: string
  /** Prompt from --prompt or positional text; undefined defers to piped stdin. */
  prompt?: string
  model?: string
  outputFormat: HeadlessOutputFormat
  auto: boolean
  maxTurns?: number
  sandboxOverride?: ConfigSandboxMode
  noHistory: boolean
}

function defaultIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Parses `codesplash run` arguments. Without --prompt the positionals form the prompt, except
 * that a first positional naming an existing directory is the project path (`run . "do x"`);
 * `isDirectory` is injectable so tests stay deterministic.
 */
export function parseRunArguments(
  args: string[],
  isDirectory: (path: string) => boolean = defaultIsDirectory,
): RunCommand {
  let promptFlag: string | undefined
  let model: string | undefined
  let outputFormat: HeadlessOutputFormat = "text"
  let auto = false
  let maxTurns: number | undefined
  let sandboxOverride: ConfigSandboxMode | undefined
  let noHistory = false
  const positionals: string[] = []

  for (let index = 0; index < args.length; index++) {
    const argument = args[index] as string
    if (argument === "-p" || argument === "--prompt" || argument.startsWith("--prompt=")) {
      const value = argument.startsWith("--prompt=") ? argument.slice("--prompt=".length) : args[++index]
      if (value === undefined) throw new UsageError("--prompt expects the prompt text")
      promptFlag = value
    } else if (argument === "--model" || argument.startsWith("--model=")) {
      const value = argument.includes("=") ? argument.slice("--model=".length) : args[++index]
      if (value === undefined) {
        throw new UsageError("--model expects a model id, optionally with :low, :medium, or :high")
      }
      model = value
    } else if (argument === "--output-format" || argument.startsWith("--output-format=")) {
      const value = argument.includes("=") ? argument.slice("--output-format=".length) : args[++index]
      if (value !== "text" && value !== "json" && value !== "stream-json") {
        throw new UsageError(`--output-format expects text, json, or stream-json, got ${value ?? "nothing"}`)
      }
      outputFormat = value
    } else if (argument === "--auto") {
      auto = true
    } else if (argument === "--max-turns" || argument.startsWith("--max-turns=")) {
      const value = argument.includes("=") ? argument.slice("--max-turns=".length) : args[++index]
      const parsed = Number(value)
      if (value === undefined || !Number.isInteger(parsed) || parsed < 1) {
        throw new UsageError(`--max-turns expects a positive integer, got ${value ?? "nothing"}`)
      }
      maxTurns = parsed
    } else if (argument === "--sandbox" || argument.startsWith("--sandbox=")) {
      const value = argument.includes("=") ? argument.slice("--sandbox=".length) : args[++index]
      if (value === "read-only" || value === "workspace-write") {
        sandboxOverride = value
      } else if (value === "danger-full-access") {
        throw new UsageError("Full access is for interactive sessions only")
      } else {
        throw new UsageError(`--sandbox expects read-only or workspace-write, got ${value ?? "nothing"}`)
      }
    } else if (argument === "--no-history") {
      noHistory = true
    } else if (argument === "--full-access") {
      throw new UsageError("--full-access is for interactive sessions only; run mode cannot confirm it")
    } else if (argument.startsWith("-")) {
      throw new UsageError(`Unknown option ${argument} for run`)
    } else {
      positionals.push(argument)
    }
  }

  let path: string | undefined
  let prompt = promptFlag
  if (promptFlag !== undefined) {
    if (positionals.length > 1) throw new UsageError("Expected at most one project path with --prompt")
    path = positionals[0]
  } else if (positionals.length > 0) {
    if (isDirectory(positionals[0] as string)) {
      path = positionals[0]
      if (positionals.length > 1) prompt = positionals.slice(1).join(" ")
    } else {
      prompt = positionals.join(" ")
    }
  }

  return { path, prompt, model, outputFormat, auto, maxTurns, sandboxOverride, noHistory }
}

/** Test seams for the run command; every field defaults to the real process surface. */
export type RunCommandOverrides = {
  /** Scripted engine for tests; defaults to the real CodesplashDriver inside the runner. */
  driver?: EngineDriver
  stdout?: HeadlessSink
  stderr?: HeadlessSink
  env?: NodeJS.ProcessEnv
  isDirectory?: (path: string) => boolean
  stdinIsTty?: boolean
  readStdinText?: () => Promise<string>
  /** Session store for the recorder; tests point it at a temp root. */
  store?: SessionStore
}

export async function runRunCommand(args: string[], overrides: RunCommandOverrides = {}): Promise<number> {
  const command = parseRunArguments(args, overrides.isDirectory)
  const env = overrides.env ?? process.env

  let prompt = command.prompt
  if (prompt === undefined) {
    const isTty = overrides.stdinIsTty ?? process.stdin.isTTY === true
    if (!isTty) prompt = (await (overrides.readStdinText ?? readAllOfStdin)()).trim()
  }
  if (prompt === undefined || prompt.trim() === "") {
    throw new UsageError("run needs a prompt: pass -p/--prompt, positional text, or pipe it on stdin")
  }

  if (command.model !== undefined) {
    const { parseModelSelector } = await import("./engines/codesplash/catalog.ts")
    try {
      parseModelSelector(command.model)
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error))
    }
  }

  const { applyStoredCredentials } = await import("./engines/codesplash/auth.ts")
  applyStoredCredentials(env)

  const { inspectProject } = await import("./core/preflight.ts")
  const project = await inspectProject(command.path ?? process.cwd())

  const { configDirectory, configFilePath, loadConfig } = await import("./core/config.ts")
  const config = await loadConfig(configFilePath(configDirectory(env)))
  const { effectiveHistoryEnabled, effectiveSessionPolicy } = await import("./core/app-options.ts")
  const appOptions: AppOptions = {
    noHistory: command.noHistory,
    fullAccess: false,
    sandboxOverride: command.sandboxOverride,
  }
  const policy = effectiveSessionPolicy(config, appOptions)
  const localSessionId = crypto.randomUUID()

  let recorder: SessionRecorder | undefined
  if (effectiveHistoryEnabled(config, appOptions)) {
    const { projectIdFor, SessionStore } = await import("./core/sessions.ts")
    const { SessionRecorder } = await import("./core/session-recorder.ts")
    const store = overrides.store ?? new SessionStore()
    const now = new Date().toISOString()
    const handle = await store.create({
      schemaVersion: 1,
      engine: "codesplash",
      localSessionId,
      projectPath: project.cwd,
      projectId: projectIdFor(project.cwd),
      createdAt: now,
      updatedAt: now,
      lastStatus: "starting",
      lastSequence: -1,
      sandbox: policy.sandbox,
      approvalPolicy: policy.approvalPolicy,
    })
    recorder = new SessionRecorder(handle)
  }

  const { runHeadless } = await import("./engines/codesplash/runner.ts")
  const exitCode = await runHeadless({
    prompt,
    cwd: project.cwd,
    model: command.model,
    policy,
    autoApprove: command.auto,
    maxTurns: command.maxTurns,
    outputFormat: command.outputFormat,
    recorder,
    driver: overrides.driver,
    localSessionId,
    stdout: overrides.stdout,
    stderr: overrides.stderr,
  })
  await recorder?.close(exitCode === 1 ? "failed" : "closed")
  return exitCode
}

/* ------------------------------------------ main ------------------------------------------ */

async function main(): Promise<void> {
  const { installSignalHandlers } = await import("./core/lifecycle.ts")
  installSignalHandlers()

  const args = process.argv.slice(2)

  if (args.includes("--help") || args.includes("-h")) {
    printHelp()
    return
  }

  if (args.includes("--version") || args.includes("-v")) {
    const { APP_VERSION } = await import("./version.ts")
    process.stdout.write(`${APP_VERSION}\n`)
    return
  }

  if (args[0] === "login") {
    process.exitCode = await runLoginCommand(args.slice(1))
    return
  }

  if (args[0] === "logout") {
    process.exitCode = await runLogoutCommand(args.slice(1))
    return
  }

  if (args[0] === "run") {
    process.exitCode = await runRunCommand(args.slice(1))
    return
  }

  if (args.includes("--doctor")) {
    const { runDoctor } = await import("./doctor.ts")
    await runDoctor()
    return
  }

  if (args.includes("--codex-smoke")) {
    const { runCodexSmoke } = await import("./engines/codex/smoke.ts")
    await runCodexSmoke()
    return
  }

  if (args.includes("--codex-live-smoke")) {
    const { runCodexLiveSmoke } = await import("./engines/codex/live-smoke.ts")
    await runCodexLiveSmoke()
    return
  }

  if (args.includes("--claude-handoff-smoke")) {
    const { ClaudeDriver } = await import("./engines/claude/index.ts")
    const result = await new ClaudeDriver().handoff(process.cwd(), ["--version"])
    if (result.exitCode !== 0) throw new Error(`Claude handoff exited with status ${result.exitCode}`)
    process.stdout.write("Claude real-terminal handoff smoke passed\n")
    return
  }

  if (args.includes("--fixture")) {
    const { runFixture } = await import("./tui/run-fixture.tsx")
    await runFixture()
    return
  }

  const { path, options } = parseAppArguments(args)

  // Stored native-engine credentials feed the interactive session too (env vars still win).
  const { applyStoredCredentials } = await import("./engines/codesplash/auth.ts")
  applyStoredCredentials()

  const { inspectProject } = await import("./core/preflight.ts")
  const project = await inspectProject(path ?? process.cwd())
  const { runWelcome } = await import("./tui/run-welcome.tsx")
  await runWelcome(project, options)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`codesplash: ${message}\n`)
    process.exitCode = error instanceof UsageError ? 2 : 1
  }
}
