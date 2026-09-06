#!/usr/bin/env bun

import { statSync } from "node:fs"
import { UsageError } from "./commands/usage-error.ts"
import type { AppOptions } from "./core/app-options.ts"
import {
  type AgentConfig,
  applyConfigOverrides,
  type ConfigPermissionMode,
  type ConfigSandboxMode,
  isConfigPermissionMode,
  isValidPermissionRule,
  type PermissionMode,
} from "./core/config.ts"
import type { EngineDriver, SessionPolicy, SessionUsageSnapshot } from "./core/engine.ts"
import type { AgentEvent } from "./core/events.ts"
import type { SessionRecorder } from "./core/session-recorder.ts"
import type { SessionMeta, SessionStore } from "./core/sessions.ts"
import type { ProviderId, ReasoningEffort } from "./engines/codesplash/contracts.ts"
import type { HeadlessOutputFormat, HeadlessSink } from "./engines/codesplash/runner.ts"

function printHelp() {
  process.stdout.write(`CodeSplash Agent

Usage:
  codesplash [path] [--no-history] [--sandbox <mode>] [--full-access] [--permission-mode <mode>]
             [--allow <rule>] [--ask <rule>] [--deny <rule>] [--bypass-approvals] [-c <key=value>]
  codesplash login <anthropic|openai> [--api-key <key>]
  codesplash logout <anthropic|openai>
  codesplash run [path] [-p|--prompt <text>] [run options]
  codesplash review [path] [review options]
  codesplash stats [--days <n>] [--json]
  codesplash completions <bash|zsh|fish|powershell>
  codesplash sandbox [--read-only] [--read-root PATH] [--write-root PATH]
                     [--allow-host HOST:PORT] [--no-history] -- CMD [ARGS...]
  codesplash secrets set NAME | list | delete NAME
  codesplash debug prompt [path] [--model <id[:effort]>] [--sandbox <mode>] [-c <key=value>]
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
  review         Collect a git diff and run one read-only CodeSplash review turn over it
  stats          Aggregate recorded session usage (tokens, estimated cost) per engine and model
  completions    Print a shell completion script for bash, zsh, fish, or powershell
  debug          Inspect harness internals; "debug prompt" prints the model-visible surface
                 (model, system prompt, tool specs) as JSON without opening a session

Options:
  path           Project directory (defaults to the current directory)
  --doctor       Print non-interactive diagnostics (runtime, engines, auth, paths) and exit
  --version      Print the application version and exit
  --no-history   Do not write session metadata or event history for this run
  --sandbox <mode>
                 Override the configured sandbox: read-only or workspace-write
  --full-access  Run without a sandbox after an explicit confirmation (interactive sessions only)
  --permission-mode <mode>
                 Start in a permission mode: plan, default, or accept-edits
  --allow <rule>, --ask <rule>, --deny <rule>
                 Repeatable CLI-tier permission rules, e.g. --allow "bash(git status *)"
  --bypass-approvals
                 Skip approvals for this session after a typed confirmation (interactive only;
                 the dangerous-command floor and write-path self-protection still apply)
  -c, --config <key=value>
                 Override one config value for this invocation, e.g. -c codex.sandbox=read-only
                 (repeatable; dotted TOML path; never written back to config.toml)
  --fixture      Render the synthetic OpenTUI development fixture
  --codex-smoke  Check Codex app-server startup, protocol, and account state without running a model
  --codex-live-smoke
                 Use model quota to exercise approval, interrupt, resume, and a second turn
  --claude-handoff-smoke
                 Hand the real terminal to Claude Code for a quota-free version check

Run options:
  -p, --prompt <text>        Prompt text for the turn
  --model <id[:effort]>      Model id, optionally with :low, :medium, or :high reasoning effort
  --effort <level>           Reasoning effort (low, medium, or high) for the chosen model
  --output-format <format>   text (default), json, or stream-json
  --auto                     Accept approval requests instead of declining them
  --max-turns <n>            Upper bound on turns for the run (default 40)
  --sandbox <mode>           read-only or workspace-write
  --no-history               Do not write session files for this run
  --resume <id>              Append this turn to the recorded codesplash session with that id
  --continue                 Append to the project's most recently updated codesplash session
  --permission-mode <mode>   plan, default, or accept-edits for this run (no bypass headless)
  --allow/--ask/--deny <rule>
                             Repeatable CLI-tier permission rules for this run
  --trust                    Persist trust for this folder (loads project rules and
                             .codesplash/permissions.toml from now on)
  -c, --config <key=value>   Override one config value for this run (repeatable)

Review options:
  --uncommitted              Review uncommitted changes, staged and untracked included (default)
  --base <ref>               Review changes since <ref> (git diff <ref>...HEAD)
  --commit <sha>             Review one commit (git show --patch <sha>)
  --model <id[:effort]>      Model id, optionally with :low, :medium, or :high reasoning effort
  --output-format <format>   text (default) or json
  --auto                     Accept approval requests instead of declining them
  --permission-mode <mode>   plan, default, or accept-edits for the review turn (without the
                             flag reviews run in "default"; config [permissions].mode is ignored)
  --allow/--ask/--deny <rule>
                             Repeatable CLI-tier permission rules for the review turn
  --trust                    Persist trust for this folder (same flag as run)
  -c, --config <key=value>   Override one config value for this run (repeatable)
`)
}

/**
 * A caller mistake (bad flags, missing prompt): printed to stderr, exit code 2. The class lives
 * in commands/usage-error.ts so command modules can throw it without importing cli.ts; this
 * re-export keeps every existing `import { UsageError } from "../src/cli.ts"` working and makes
 * `instanceof` agree across the CLI and the command modules.
 */
export { UsageError }

/**
 * Validates one `--allow/--ask/--deny` rule with the same grammar config.toml enforces, so a
 * typo is a usage error (exit 2) at parse time instead of a silently ignored rule at session
 * open. Unknown TOOL NAMES still pass here — the engine warns about those (forward compat).
 */
export function checkPermissionRule(flag: string, value: string | undefined): string {
  if (value === undefined || value === "") {
    throw new UsageError(`${flag} expects a permission rule like "bash(git status *)" or "read_file"`)
  }
  if (!isValidPermissionRule(value)) {
    throw new UsageError(
      `${flag}: invalid rule "${value}" — expected a tool name with an optional (pattern), e.g. bash(git status *)`,
    )
  }
  return value
}

/** Parses a `--permission-mode` value; "bypass" is deliberately not reachable via this flag. */
export function checkPermissionModeValue(value: string | undefined): ConfigPermissionMode {
  if (value !== undefined && isConfigPermissionMode(value)) return value
  if (value === "bypass") {
    throw new UsageError(
      "--permission-mode cannot select bypass; bypass requires the --bypass-approvals launch flag each session",
    )
  }
  throw new UsageError(`--permission-mode expects plan, default, or accept-edits, got ${value ?? "nothing"}`)
}

/** Validates one `-c/--config` override's syntax eagerly so mistakes exit 2 before any I/O. */
function checkConfigOverride(value: string): string {
  try {
    applyConfigOverrides({}, [value])
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  return value
}

/**
 * Pulls repeatable `-c/--config key=value` flags out of a subcommand's argument list, for
 * subcommands whose parsers live in src/commands and take the overrides separately.
 */
export function extractConfigOverrides(args: string[]): { args: string[]; configOverrides: string[] } {
  const rest: string[] = []
  const configOverrides: string[] = []

  for (let index = 0; index < args.length; index++) {
    const argument = args[index] as string
    if (argument === "-c" || argument === "--config") {
      const value = args[++index]
      if (value === undefined) throw new UsageError("--config expects a dotted.path=value override")
      configOverrides.push(checkConfigOverride(value))
    } else if (argument.startsWith("--config=")) {
      configOverrides.push(checkConfigOverride(argument.slice("--config=".length)))
    } else if (argument.startsWith("-c=")) {
      configOverrides.push(checkConfigOverride(argument.slice("-c=".length)))
    } else {
      rest.push(argument)
    }
  }

  return { args: rest, configOverrides }
}

export function parseAppArguments(args: string[]): { path?: string; options: AppOptions } {
  const configOverrides: string[] = []
  const allowRules: string[] = []
  const askRules: string[] = []
  const denyRules: string[] = []
  const options: AppOptions = {
    noHistory: false,
    fullAccess: false,
    configOverrides,
    bypassApprovals: false,
    allowRules,
    askRules,
    denyRules,
    trustWorkspace: false,
  }
  let path: string | undefined

  for (let index = 0; index < args.length; index++) {
    const argument = args[index] as string
    if (argument === "--no-history") {
      options.noHistory = true
    } else if (argument === "--full-access") {
      options.fullAccess = true
    } else if (argument === "--bypass-approvals") {
      options.bypassApprovals = true
    } else if (argument === "--permission-mode" || argument.startsWith("--permission-mode=")) {
      const value = argument.includes("=") ? argument.slice("--permission-mode=".length) : args[++index]
      options.permissionModeOverride = checkPermissionModeValue(value)
    } else if (argument === "--allow" || argument.startsWith("--allow=")) {
      const value = argument.includes("=") ? argument.slice("--allow=".length) : args[++index]
      allowRules.push(checkPermissionRule("--allow", value))
    } else if (argument === "--ask" || argument.startsWith("--ask=")) {
      const value = argument.includes("=") ? argument.slice("--ask=".length) : args[++index]
      askRules.push(checkPermissionRule("--ask", value))
    } else if (argument === "--deny" || argument.startsWith("--deny=")) {
      const value = argument.includes("=") ? argument.slice("--deny=".length) : args[++index]
      denyRules.push(checkPermissionRule("--deny", value))
    } else if (argument === "--trust") {
      // The interactive session asks with the trust screen instead; only run/review take a flag.
      throw new UsageError("--trust is for run and review; interactive sessions show a trust screen")
    } else if (argument === "-c" || argument === "--config") {
      const value = args[++index]
      if (value === undefined) throw new UsageError("--config expects a dotted.path=value override")
      configOverrides.push(checkConfigOverride(value))
    } else if (argument.startsWith("--config=")) {
      configOverrides.push(checkConfigOverride(argument.slice("--config=".length)))
    } else if (argument.startsWith("-c=")) {
      configOverrides.push(checkConfigOverride(argument.slice("-c=".length)))
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
  /** `--effort`: reasoning effort combined with the model (or the default model) by the runner. */
  effort?: ReasoningEffort
  outputFormat: HeadlessOutputFormat
  auto: boolean
  maxTurns?: number
  sandboxOverride?: ConfigSandboxMode
  noHistory: boolean
  /** `--resume <id>`: append this turn to the recorded codesplash session with that id. */
  resume?: string
  /** `--continue`: append to the project's most recently updated codesplash session. */
  continueSession: boolean
  /** Repeatable `-c/--config key=value` overrides applied to this run's config load. */
  configOverrides: string[]
  /** `--permission-mode`: explicit mode for this run; wins over config and a resumed session. */
  permissionMode?: ConfigPermissionMode
  /** Repeatable `--allow <rule>`: CLI-tier allow rules. */
  allowRules: string[]
  /** Repeatable `--ask <rule>`: CLI-tier ask rules. */
  askRules: string[]
  /** Repeatable `--deny <rule>`: CLI-tier deny rules. */
  denyRules: string[]
  /** `--trust`: persist a trusted decision for the workspace before the run starts. */
  trust: boolean
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
  let effort: ReasoningEffort | undefined
  let outputFormat: HeadlessOutputFormat = "text"
  let auto = false
  let maxTurns: number | undefined
  let sandboxOverride: ConfigSandboxMode | undefined
  let noHistory = false
  let resume: string | undefined
  let continueSession = false
  let permissionMode: ConfigPermissionMode | undefined
  let trust = false
  const allowRules: string[] = []
  const askRules: string[] = []
  const denyRules: string[] = []
  const configOverrides: string[] = []
  const positionals: string[] = []

  for (let index = 0; index < args.length; index++) {
    const argument = args[index] as string
    if (argument === "-p" || argument === "--prompt" || argument.startsWith("--prompt=")) {
      const value = argument.startsWith("--prompt=") ? argument.slice("--prompt=".length) : args[++index]
      if (value === undefined) throw new UsageError("--prompt expects the prompt text")
      promptFlag = value
    } else if (argument === "--effort" || argument.startsWith("--effort=")) {
      const value = argument.includes("=") ? argument.slice("--effort=".length) : args[++index]
      if (value !== "low" && value !== "medium" && value !== "high") {
        throw new UsageError(`--effort expects low, medium, or high, got ${value ?? "nothing"}`)
      }
      effort = value
    } else if (argument === "--resume" || argument.startsWith("--resume=")) {
      const value = argument.includes("=") ? argument.slice("--resume=".length) : args[++index]
      if (value === undefined || value === "" || value.startsWith("-")) {
        throw new UsageError("--resume expects a session id (see the resume picker or session store)")
      }
      resume = value
    } else if (argument === "--continue") {
      continueSession = true
    } else if (argument === "-c" || argument === "--config") {
      const value = args[++index]
      if (value === undefined) throw new UsageError("--config expects a dotted.path=value override")
      configOverrides.push(checkConfigOverride(value))
    } else if (argument.startsWith("--config=")) {
      configOverrides.push(checkConfigOverride(argument.slice("--config=".length)))
    } else if (argument.startsWith("-c=")) {
      configOverrides.push(checkConfigOverride(argument.slice("-c=".length)))
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
    } else if (argument === "--permission-mode" || argument.startsWith("--permission-mode=")) {
      const value = argument.includes("=") ? argument.slice("--permission-mode=".length) : args[++index]
      permissionMode = checkPermissionModeValue(value)
    } else if (argument === "--allow" || argument.startsWith("--allow=")) {
      const value = argument.includes("=") ? argument.slice("--allow=".length) : args[++index]
      allowRules.push(checkPermissionRule("--allow", value))
    } else if (argument === "--ask" || argument.startsWith("--ask=")) {
      const value = argument.includes("=") ? argument.slice("--ask=".length) : args[++index]
      askRules.push(checkPermissionRule("--ask", value))
    } else if (argument === "--deny" || argument.startsWith("--deny=")) {
      const value = argument.includes("=") ? argument.slice("--deny=".length) : args[++index]
      denyRules.push(checkPermissionRule("--deny", value))
    } else if (argument === "--trust") {
      trust = true
    } else if (argument === "--bypass-approvals") {
      throw new UsageError(
        "--bypass-approvals: run mode approves with --auto; dangerous commands are always declined headlessly",
      )
    } else if (argument === "--full-access") {
      throw new UsageError("--full-access is for interactive sessions only; run mode cannot confirm it")
    } else if (argument.startsWith("-")) {
      throw new UsageError(`Unknown option ${argument} for run`)
    } else {
      positionals.push(argument)
    }
  }

  if (resume !== undefined && continueSession) {
    throw new UsageError("--resume and --continue conflict; pass at most one")
  }
  if ((resume !== undefined || continueSession) && noHistory) {
    throw new UsageError("--no-history cannot resume a session; resumed runs append to its history")
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

  return {
    path,
    prompt,
    model,
    effort,
    outputFormat,
    auto,
    maxTurns,
    sandboxOverride,
    noHistory,
    resume,
    continueSession,
    configOverrides,
    permissionMode,
    allowRules,
    askRules,
    denyRules,
    trust,
  }
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
  const stderr = overrides.stderr ?? process.stderr

  let prompt = command.prompt
  if (prompt === undefined) {
    const isTty = overrides.stdinIsTty ?? process.stdin.isTTY === true
    if (!isTty) prompt = (await (overrides.readStdinText ?? readAllOfStdin)()).trim()
  }
  if (prompt === undefined || prompt.trim() === "") {
    throw new UsageError("run needs a prompt: pass -p/--prompt, positional text, or pipe it on stdin")
  }

  const { applyStoredCredentials } = await import("./engines/codesplash/auth.ts")
  applyStoredCredentials(env)

  const { inspectProject } = await import("./core/preflight.ts")
  const project = await inspectProject(command.path ?? process.cwd())

  const { configDirectory, configFilePath, loadConfig } = await import("./core/config.ts")
  const config = await loadConfig(configFilePath(configDirectory(env)), command.configOverrides)

  if (command.model !== undefined) {
    // Validate against the static built-in catalog first (availability-agnostic, like always),
    // then against the config-driven registry so custom-provider models pass too.
    const selector = command.effort ? `${command.model}:${command.effort}` : command.model
    const { buildProviderRegistry, parseModelSelector } = await import("./engines/codesplash/catalog.ts")
    try {
      parseModelSelector(selector)
    } catch (staticError) {
      try {
        buildProviderRegistry(config, env).parseSelector(selector)
      } catch {
        throw new UsageError(staticError instanceof Error ? staticError.message : String(staticError))
      }
    }
  }

  const { effectiveHistoryEnabled, effectiveSessionPolicy } = await import("./core/app-options.ts")
  const appOptions: AppOptions = {
    noHistory: command.noHistory,
    fullAccess: false,
    sandboxOverride: command.sandboxOverride,
    permissionModeOverride: command.permissionMode,
    bypassApprovals: false, // run mode has no bypass; the flag is rejected at parse time
    allowRules: command.allowRules,
    askRules: command.askRules,
    denyRules: command.denyRules,
    trustWorkspace: command.trust,
  }
  let policy = effectiveSessionPolicy(config, appOptions)
  let localSessionId: string = crypto.randomUUID()
  let recorder: SessionRecorder | undefined
  let nativeTranscriptPath: string | undefined
  let firstSequence: number | undefined
  let initialUsage: SessionUsageSnapshot | undefined
  let recordedPermissionMode: string | undefined
  let recordPermissionMode: ((mode: PermissionMode) => void) | undefined

  // Permission plumbing that exists with or without history: the CLI rule tier, the trust store's
  // data directory (env-derived dirs included), and the project's remembered-grants file.
  const { dataDirectory } = await import("./core/config.ts")
  const trustDataDir = dataDirectory(env)
  const { permissionGrantsPathFor, projectIdFor: grantsProjectIdFor } = await import("./core/sessions.ts")
  const permissionGrantsPath = permissionGrantsPathFor(trustDataDir, grantsProjectIdFor(project.cwd))
  const permissionOverrides =
    command.allowRules.length + command.askRules.length + command.denyRules.length > 0
      ? { allow: command.allowRules, ask: command.askRules, deny: command.denyRules }
      : undefined

  const resuming = command.resume !== undefined || command.continueSession
  if (resuming && !effectiveHistoryEnabled(config, appOptions)) {
    throw new UsageError("Resuming needs session history, but it is disabled in config")
  }
  if (resuming || effectiveHistoryEnabled(config, appOptions)) {
    const { projectIdFor, readSessionEvents, SessionStore, transcriptPathFor } = await import(
      "./core/sessions.ts"
    )
    const { SessionRecorder } = await import("./core/session-recorder.ts")
    const store = overrides.store ?? new SessionStore()
    const projectId = projectIdFor(project.cwd)

    if (resuming) {
      const targetId = command.resume ?? (await latestCodesplashSessionId(store, projectId))
      let handle: Awaited<ReturnType<SessionStore["open"]>>
      try {
        handle = await store.open(projectId, targetId)
      } catch {
        throw new UsageError(`No recorded session "${targetId}" for this project`)
      }
      if (handle.meta.engine !== "codesplash") {
        throw new UsageError(
          `Session "${targetId}" belongs to the ${handle.meta.engine} engine; run can only resume codesplash sessions`,
        )
      }
      localSessionId = handle.meta.localSessionId
      // A crash mid-turn leaves events.jsonl ahead of meta.lastSequence (meta only syncs on
      // turn.completed/session.status), so the on-disk events decide the next sequence — reusing
      // an already-issued sequence would break the monotonic invariant replay relies on. The
      // same read seeds the cumulative usage the resumed engine session continues from.
      const { events: priorEvents } = await readSessionEvents(handle.directory)
      let highestSequence = handle.meta.lastSequence
      for (const event of priorEvents) {
        if (event.sequence > highestSequence) highestSequence = event.sequence
      }
      firstSequence = highestSequence + 1
      initialUsage = usageSnapshotFromEvents(priorEvents)
      nativeTranscriptPath = transcriptPathFor(handle)
      policy = resumedSessionPolicy(handle.meta, command.sandboxOverride, config, stderr)
      // The runner settles mode precedence (flag > recorded > policy) and reports what it used;
      // the write goes through the recorder's chain so it never races other meta updates.
      recordedPermissionMode = handle.meta.permissionMode
      recorder = new SessionRecorder(handle)
      const resumedRecorder = recorder
      recordPermissionMode = (mode) => resumedRecorder.recordPermissionMode(mode)
    } else {
      const now = new Date().toISOString()
      const handle = await store.create({
        schemaVersion: 1,
        engine: "codesplash",
        localSessionId,
        projectPath: project.cwd,
        projectId,
        createdAt: now,
        updatedAt: now,
        lastStatus: "starting",
        lastSequence: -1,
        sandbox: policy.sandbox,
        approvalPolicy: policy.approvalPolicy,
        permissionMode: policy.permissionMode,
      })
      // New recorded runs persist the engine transcript too, so --resume/--continue work later.
      // The created meta already carries the policy's mode; the runner re-records the settled one
      // through the recorder's write chain (never a bare updateMeta, which would race it).
      nativeTranscriptPath = transcriptPathFor(handle)
      recorder = new SessionRecorder(handle)
      const freshRecorder = recorder
      recordPermissionMode = (mode) => freshRecorder.recordPermissionMode(mode)
    }
  }

  let driver = overrides.driver
  if (!driver) {
    const { CodesplashDriver } = await import("./engines/codesplash/engine.ts")
    // The engine reuses this command's config load, -c overrides included.
    driver = new CodesplashDriver({ config })
  }

  const { runHeadless } = await import("./engines/codesplash/runner.ts")
  const exitCode = await runHeadless({
    prompt,
    cwd: project.cwd,
    model: command.model,
    effort: command.effort,
    policy,
    autoApprove: command.auto,
    maxTurns: command.maxTurns,
    outputFormat: command.outputFormat,
    recorder,
    driver,
    localSessionId,
    nativeTranscriptPath,
    firstSequence,
    initialUsage,
    permissionModeOverride: command.permissionMode,
    recordedPermissionMode,
    permissionOverrides,
    permissionGrantsPath,
    trustWorkspace: command.trust,
    trustDataDir,
    recordPermissionMode,
    stdout: overrides.stdout,
    stderr: overrides.stderr,
  })
  await recorder?.close(exitCode === 1 ? "failed" : "closed")
  return exitCode
}

/**
 * Cumulative usage recorded across a session's `usage.updated` events: codesplash events carry
 * session-cumulative fields, so the merge keeps each field's last defined value (a payload that
 * omits a field — e.g. a rate-limit-only update — leaves it intact). Returns undefined when the
 * log recorded no usage at all.
 */
function usageSnapshotFromEvents(events: readonly AgentEvent[]): SessionUsageSnapshot | undefined {
  let snapshot: SessionUsageSnapshot | undefined
  for (const event of events) {
    if (event.kind !== "usage.updated") continue
    const payload = event.payload
    snapshot ??= {}
    if (payload.inputTokens !== undefined) snapshot.inputTokens = payload.inputTokens
    if (payload.cachedInputTokens !== undefined) snapshot.cachedInputTokens = payload.cachedInputTokens
    if (payload.outputTokens !== undefined) snapshot.outputTokens = payload.outputTokens
    if (payload.estimatedCostUsd !== undefined) snapshot.estimatedCostUsd = payload.estimatedCostUsd
    if (payload.hasUnpricedUsage !== undefined) snapshot.hasUnpricedUsage = payload.hasUnpricedUsage
  }
  return snapshot
}

/** The most recently updated codesplash session for `--continue`; none is a usage error. */
async function latestCodesplashSessionId(store: SessionStore, projectId: string): Promise<string> {
  const sessions = await store.list(projectId)
  const latest = sessions.find((meta) => meta.engine === "codesplash")
  if (!latest) throw new UsageError("No codesplash session to continue in this project")
  return latest.localSessionId
}

/**
 * Resumed runs reuse the session's recorded sandbox and approval policy unless overridden on the
 * command line. A recorded full-access sandbox cannot be reused headless — full access always
 * needs the interactive typed confirmation — so it degrades to workspace-write with a notice.
 */
function resumedSessionPolicy(
  meta: SessionMeta,
  sandboxOverride: ConfigSandboxMode | undefined,
  config: AgentConfig,
  stderr: HeadlessSink,
): SessionPolicy {
  let sandbox = sandboxOverride ?? meta.sandbox ?? config.codex.sandbox
  if (sandbox === "danger-full-access") {
    stderr.write(
      "codesplash: the recorded session ran with full access, which needs interactive confirmation; using workspace-write (pass --sandbox to choose)\n",
    )
    sandbox = "workspace-write"
  }
  // permissionMode here is only the last-resort fallback: the headless runner resolves the
  // explicit --permission-mode flag and the session's recorded mode ahead of it.
  return {
    sandbox,
    approvalPolicy: meta.approvalPolicy ?? config.codex.approvalPolicy,
    permissionMode: config.permissions.mode,
  }
}

/* ------------------------------------------ main ------------------------------------------ */

async function main(): Promise<void> {
  const { installSignalHandlers } = await import("./core/lifecycle.ts")
  installSignalHandlers()

  const args = process.argv.slice(2)

  if (args[0] === "--internal-sandbox-supervisor") {
    await (await import("./engines/codesplash/sandbox/supervisor.ts")).supervisorMain()
    return
  }
  if (args[0] === "--internal-sandbox-worker") {
    await (await import("./engines/codesplash/sandbox/worker.ts")).workerMain()
    return
  }
  // Dispatch before global help/version flags: arguments after sandbox's -- are literal child argv.
  if (args[0] === "sandbox") {
    process.exitCode = await (await import("./commands/sandbox.ts")).runSandboxCommand(args.slice(1))
    return
  }
  if (args[0] === "secrets") {
    process.exitCode = await (await import("./commands/secrets.ts")).runSecretsCommand(
      args.slice(1),
      async () =>
        process.stdin.isTTY
          ? readSecretFromTty("Secret value (hidden): ", process.stderr)
          : (await Bun.stdin.text()).replace(/\r?\n$/, ""),
    )
    return
  }

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

  if (args[0] === "review") {
    const { runReviewCommand } = await import("./commands/review.ts")
    const { args: rest, configOverrides } = extractConfigOverrides(args.slice(1))
    process.exitCode = await runReviewCommand(rest, { configOverrides })
    return
  }

  if (args[0] === "stats") {
    const { runStatsCommand } = await import("./commands/stats.ts")
    process.exitCode = await runStatsCommand(args.slice(1))
    return
  }

  if (args[0] === "completions") {
    const { runCompletionsCommand } = await import("./commands/completions.ts")
    process.exitCode = await runCompletionsCommand(args.slice(1))
    return
  }

  if (args[0] === "debug") {
    const { runDebugCommand } = await import("./commands/debug-prompt.ts")
    const { args: rest, configOverrides } = extractConfigOverrides(args.slice(1))
    process.exitCode = await runDebugCommand(rest, { configOverrides })
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
