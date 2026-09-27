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
import { brand, dispatchArguments } from "./core/distribution/brand.ts"
import type { EngineDriver, SessionPolicy, SessionUsageSnapshot } from "./core/engine.ts"
import type { AgentEvent } from "./core/events.ts"
import { bytes as boundedFileBytes } from "./core/session/files.ts"
import type { SessionRecorder } from "./core/session-recorder.ts"
import type { SessionMeta, SessionStore } from "./core/sessions.ts"
import { beginStartupPhase, measureStartup } from "./core/startup-timing.ts"
import type { ProviderId, ReasoningEffort } from "./engines/codesplash/contracts.ts"
import type { HeadlessOutputFormat, HeadlessSink } from "./engines/codesplash/runner.ts"
import { validateEnvironments } from "./engines/codesplash/tools/environments.ts"
import { APP_VERSION } from "./version.ts"

function printHelp() {
  process.stdout.write(`${brand.name}

Usage:
  codesplash [path] [prompt words...] [-p TEXT] [--file PATH] [--resume ID_OR_TITLE|--search TEXT|--continue]
             [--no-history] [--sandbox <mode>] [--full-access] [--permission-mode <mode>]
             [--allow <rule>] [--ask <rule>] [--deny <rule>] [--bypass-approvals] [-c <key=value>]
  codesplash login <anthropic|openai> [--keyring] [--api-key <key>]
  codesplash identity <login|logout> <provider>
  codesplash update [status|check|apply --apply|rollback --apply]
  codesplash fleet <status|refresh FILE --apply>
  codesplash features [list|announcements|set NAME on|off|default --apply]
  codesplash disk
  codesplash relay --socket PRIVATE_SOCKET [--timeout-ms N] [--max-bytes N]
  codesplash key-proxy --config FILE
  codesplash wrap [--clipboard] -- CMD [ARGS...]
  codesplash isolate PROFILE.json -- COMMAND [ARGS...]
  codesplash windows-sandbox <status|verify|install --apply|uninstall --apply>
  codesplash --build-info
  codesplash logout <anthropic|openai>
  codesplash run [path] [-p|--prompt <text>] [run options]
  codesplash review [path] [review options]
  codesplash stats [--days <n>] [--json]
  codesplash completions <bash|zsh|fish|powershell>
  codesplash sandbox [--read-only] [--read-root PATH] [--write-root PATH]
                     [--allow-host HOST:PORT] [--no-history] -- CMD [ARGS...]
  codesplash secrets set NAME | list | delete NAME
  codesplash import <claude|cursor> <source-dir> [--apply] [--destination DIR]
  codesplash import settings <claude|codex|cursor> FILE [--apply]
  codesplash import sessions <codesplash|claude|codex|cursor> SOURCE [args]
  codesplash create-skill <name> [--write]
  codesplash session <list|search|show|rename|archive|unarchive|delete|projects|move|section|migrate|compress|recover|reindex> [args]
  codesplash session <info|recap|outcomes> <id> [--json]
  codesplash session rename <id> <title|--auto|--generate>
  codesplash session <export|import|foreign|cd|pwd|tree|fork|rewind|checkpoints|restore> [args]
  codesplash memory <list|show|search|remember|edit|forget|accept|status|repair|index|link|refresh|extract|consolidate> [args]
                    [--path DIR] [--trust] [--read-only] [--no-history] [--model ID]
  codesplash debug prompt [path] [--model <id[:effort]>] [--sandbox <mode>] [-c <key=value>]
  codesplash --doctor
  codesplash --version
  codesplash --fixture
  codesplash --codex-smoke
  codesplash --codex-live-smoke
  codesplash --claude-handoff-smoke
  codesplash --help

Commands:
  eval           Run isolated native tasks, fault fixtures and budgeted model judges
  diagnostics    Inspect content-free lifecycle logs and crash history
  trace          Export and replay diagnostic timelines without repeating effects
  feedback       Prepare diagnostics; upload only with explicit destination and consent
  serve          Run the authenticated native daemon or --stdio JSON-RPC server
  attach         Attach the terminal UI to a daemon thread
  daemon         Inspect daemon status or issue a one-time pairing code
  acp            Run the Agent Client Protocol stdio adapter
  mcp-server     Expose codesplash and codesplash-reply as MCP tools
  generate       Emit versioned protocol types, JSON Schema and OpenAPI
  ide            Package or install the VS Code daemon extension
  lsp            Review and install managed language services and formatters
  integrations   Run an operator-configured GitHub App or Slack Socket Mode bridge
  pr             Preview or apply an isolated GitHub PR checkout and session import
  open           Inspect a codesplash:// link; --attach opens a local reader
  login          Store an API key for the native CodeSplash engine. Without --api-key the key is
                 read from stdin — hidden when the terminal is interactive, a plain line otherwise
  logout         Remove a stored API key
  run            Run one headless CodeSplash turn and exit. The prompt comes from -p/--prompt,
                 else the remaining positional text, else piped stdin
  review         Collect a git diff and run one read-only CodeSplash review turn over it
  stats          Aggregate recorded session usage (tokens, estimated cost) per engine and model
  completions    Print a shell completion script for bash, zsh, fish, or powershell
  import         Preview/apply supported resources, settings or conversation history
  session        Search, organize, export/import and recover local sessions; inspect foreign history
  memory         Inspect and manage repository memory; automatic learning is opt-in
  create-skill   Preview a native skill scaffold; --write creates it without overwriting
  mcp            Manage native MCP servers, trust, connection checks and OAuth login
  shell-state    Capture, review and trust explicit shell definitions
  peer           Send data to or listen on an authenticated local peer mailbox
  projection     Create or expand an explicit local Git sparse projection
  worktree       Create, inspect, apply and clean up owned Git worktrees
  agents         List, draft, create and enable reviewed native child definitions (alias: agent)
  workflows      Create, review, enable and import saved native workflows
  automation     Run bounded goals/workflows; inspect or resume durable journals
  teams          Run finite native teams, inspect rosters and view optional tmux panes
  scheduler      Review recurring prompts, inspect occurrences and run workers or install a user service
  hooks          Review native lifecycle handlers, trust and execution receipts
  plugin         Install, inspect and activate pinned plugins/marketplaces
  extensions     Review and trust native TS/JS extensions
  config         Explain/validate effective configuration and select named profiles
  models         List/refresh model metadata and discover/pull local runtime models
  tools          Inspect tool versions, presets, verified assets and attribution policies
  debug          Inspect harness internals; "debug prompt" prints the model-visible surface
                 (model, system prompt, tool specs) as JSON without opening a session

Options:
  path           Project directory (defaults to the current directory)
  --offline      Refuse governed outbound network requests (before COMMAND)
  --harden       Apply supported kernel process hardening (before COMMAND)
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
  --profile <name>
                 Select a named configuration profile for this invocation
  --strict-config
                 Reject unknown configuration settings
  --fixture      Render the synthetic OpenTUI development fixture
  --input-format text|stream-json   Headless stdin format (bounded user frames)
  --output-schema JSON|@FILE       Validate final JSON without retrying effects
  --output-last-message FILE      Atomically save a successful final response
  --agent ID                     Run through a reviewed native child role
  --tools NAMES                   Comma-separated tool ceiling
  --exclude-tools NAMES           Comma-separated tool exclusions
  --features NAMES                Opt into notebook, anchors, clock, code, browser, generation, plugins, environments
  --browser-origins ORIGINS       Exact comma-separated allowed HTTP(S) origins
  --environments FILE             Reviewed local/container/SSH/micro-VM environment manifest
  --toolset NAME                  Apply a named tool ceiling (concise, plan, read-only, anchors)
  --max-budget-usd N              Cumulative estimated model spend ceiling
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
/** Shared resolver controls; keep values out of ordinary dotted overrides. */
export function extractConfigControls(args: string[]): {
  args: string[]
  profile?: string
  strictConfig?: boolean
  disableExtensions?: boolean
} {
  const result: { args: string[]; profile?: string; strictConfig?: boolean; disableExtensions?: boolean } = {
    args: [],
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--") {
      result.args.push(...args.slice(index))
      break
    }
    if (
      [
        "-c",
        "--config",
        "-p",
        "--prompt",
        "--model",
        "--path",
        "--sandbox",
        "--permission-mode",
        "--allow",
        "--ask",
        "--deny",
        "--resume",
        "--effort",
        "--max-turns",
        "--output-format",
      ].includes(arg)
    ) {
      result.args.push(arg)
      const value = args[++index]
      if (value !== undefined) result.args.push(value)
      continue
    }
    if (arg === "--no-extensions") result.disableExtensions = true
    else if (arg === "--strict-config") result.strictConfig = true
    else if (arg === "--profile" || arg.startsWith("--profile=")) {
      const value = arg.startsWith("--profile=") ? arg.slice(10) : args[++index]
      if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value))
        throw new UsageError("--profile requires a profile name")
      result.profile = value
    } else result.args.push(arg)
  }
  return result
}

export function extractConfigOverrides(args: string[]): {
  args: string[]
  configOverrides: string[]
  profile?: string
  strictConfig?: boolean
  disableExtensions?: boolean
} {
  const { args: remaining, ...controls } = extractConfigControls(args)
  args = remaining
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

  return { args: rest, configOverrides, ...controls }
}

export function parseAppArguments(args: string[]): { path?: string; options: AppOptions } {
  const { args: remaining, ...controls } = extractConfigControls(args)
  args = remaining
  const configOverrides: string[] = []
  const allowRules: string[] = []
  const askRules: string[] = []
  const denyRules: string[] = []
  const options: AppOptions = {
    ...controls,
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
    if (["-p", "--prompt", "--file", "--resume", "--search", "--path"].includes(argument.split("=")[0]!)) {
      const flag = argument.split("=")[0]!,
        value = argument.includes("=") ? argument.slice(flag.length + 1) : args[++index]
      if (!value) throw new UsageError(`${flag} requires a value`)
      options.launch ??= { files: [] }
      const launch = options.launch
      if (flag === "--file") launch.files.push(value)
      else if (flag === "--path") {
        if (path !== undefined) throw new UsageError("Project path was specified twice")
        path = value
      } else if (flag === "--resume") launch.resume = value
      else if (flag === "--search") launch.search = value
      else {
        if (launch.prompt !== undefined) throw new UsageError("Prompt was specified twice")
        launch.prompt = value
      }
    } else if (argument === "--continue") {
      options.launch ??= { files: [] }
      options.launch.continue = true
    } else if (argument === "--") {
      options.launch ??= { files: [] }
      options.launch.prompt = args.slice(index + 1).join(" ")
      break
    } else if (argument === "--no-history") {
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
      options.launch ??= { files: [] }
      const launch = options.launch
      launch.prompt = launch.prompt ? `${launch.prompt} ${argument}` : argument
    }
  }

  if (options.launch) {
    const count = [options.launch.resume, options.launch.search, options.launch.continue].filter(
      Boolean,
    ).length
    if (count > 1) throw new UsageError("Choose one of --resume, --search or --continue")
    if (count && options.noHistory) throw new UsageError("--no-history cannot resume a session")
  }
  return { path, options }
}

/* ------------------------------- login / logout subcommands ------------------------------- */

export type LoginCommand = { provider: ProviderId; apiKey?: string; keyring?: boolean }

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
  let keyring = false

  for (let index = 0; index < args.length; index++) {
    const argument = args[index] as string
    if (argument === "--keyring") keyring = true
    else if (argument === "--api-key" || argument.startsWith("--api-key=")) {
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

  return { provider: parseProviderArgument("login", provider), apiKey, ...(keyring ? { keyring: true } : {}) }
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
  const { provider, apiKey, keyring } = parseLoginArguments(args)
  const env = io.env ?? process.env
  const stdout = io.stdout ?? process.stdout
  const key = apiKey ?? (await readApiKeyFromStdin(provider, io))
  if (key.trim() === "") throw new UsageError("API key must be a non-empty string")

  const { credentialsFilePath, setApiKey, setKeyringApiKey } = await import("./engines/codesplash/auth.ts")
  if (keyring) {
    await setKeyringApiKey(provider, key, env)
    stdout.write(`Saved ${provider} API key to OS credential store\n`)
    return 0
  }
  setApiKey(provider, key, env)
  stdout.write(`Saved ${provider} API key to ${credentialsFilePath(env)}\n`)
  return 0
}

export async function runLogoutCommand(args: string[], io: CredentialCommandIo = {}): Promise<number> {
  const { provider } = parseLogoutArguments(args)
  const { deleteAllApiKeys } = await import("./engines/codesplash/auth.ts")
  const removed = await deleteAllApiKeys(provider, io.env ?? process.env)
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
  files?: string[]
  agent?: string
  inputFormat?: "text" | "stream-json"
  outputSchema?: string
  outputLastMessage?: string
  execution?: import("./engines/codesplash/execution.ts").ExecutionLimits
  profile?: string
  strictConfig?: boolean
  disableExtensions?: boolean
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
  const { args: remaining, ...controls } = extractConfigControls(args)
  args = remaining
  const executionOptions: Pick<
    RunCommand,
    "execution" | "inputFormat" | "outputSchema" | "outputLastMessage" | "agent"
  > = {}
  const files: string[] = []
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
    if (argument === "--file" || argument.startsWith("--file=")) {
      const value = argument.includes("=") ? argument.slice(7) : args[++index]
      if (!value || files.length >= 32)
        throw new UsageError("--file requires a literal path; at most 32 attachments")
      files.push(value)
    } else if (
      [
        "--browser-origins",
        "--features",
        "--environments",
        "--toolset",
        "--agent",
        "--input-format",
        "--output-schema",
        "--output-last-message",
        "--tools",
        "--exclude-tools",
        "--max-budget-usd",
      ].includes(argument.split("=")[0]!)
    ) {
      const flag = argument.split("=")[0]!,
        value = argument.includes("=") ? argument.slice(flag.length + 1) : args[++index]
      if (value === undefined) throw new UsageError(`${flag} requires a value`)
      if (flag === "--agent") {
        if (!value.trim()) throw new UsageError("Agent name required")
        executionOptions.agent = value
      } else if (flag === "--input-format") {
        if (value !== "text" && value !== "stream-json") throw new UsageError("Invalid input format")
        executionOptions.inputFormat = value
      } else if (flag === "--output-schema") executionOptions.outputSchema = value
      else if (flag === "--output-last-message") executionOptions.outputLastMessage = value
      else {
        executionOptions.execution ??= {}
        if (flag === "--environments")
          executionOptions.execution.environments = validateEnvironments(
            JSON.parse(boundedFileBytes(value, 65536).toString()),
          )
        else if (flag === "--browser-origins") executionOptions.execution.browserOrigins = value.split(",")
        else if (flag === "--features") executionOptions.execution.features = value.split(",")
        else if (flag === "--toolset") executionOptions.execution.toolset = value
        else if (flag === "--max-budget-usd") {
          const budget = Number(value)
          if (!Number.isFinite(budget) || budget <= 0)
            throw new UsageError("Budget must be positive and finite")
          executionOptions.execution.maxBudgetUsd = budget
        } else
          executionOptions.execution[flag === "--tools" ? "allowedTools" : "excludedTools"] = value
            ? value.split(",")
            : []
      }
    } else if (argument === "-p" || argument === "--prompt" || argument.startsWith("--prompt=")) {
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
    ...executionOptions,
    ...(files.length ? { files } : {}),
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
    ...controls,
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
  let inputs: AsyncIterable<string> | undefined
  if (command.inputFormat === "stream-json") {
    if (
      prompt !== undefined ||
      command.files?.length ||
      (overrides.stdinIsTty ?? process.stdin.isTTY === true)
    )
      throw new UsageError("stream-json requires piped stdin and no prompt argument")
    const { ndjson } = await import("./server/transport.ts")
    const source = overrides.readStdinText
      ? (async function* () {
          yield await overrides.readStdinText!()
        })()
      : process.stdin
    inputs = (async function* () {
      for await (const frame of ndjson(source)) {
        const input = frame as { type?: string; text?: unknown }
        if (
          !input ||
          input.type !== "user" ||
          typeof input.text !== "string" ||
          !input.text.trim() ||
          Object.keys(input).some((k) => !["type", "text"].includes(k))
        )
          throw new UsageError("Each input line must be {type: user, text: nonempty string}")
        yield input.text
      }
    })()
    prompt = "stream input"
  }
  let outputSchema: unknown
  if (command.outputSchema) {
    const { bytes } = await import("./core/session/files.ts")
    outputSchema = JSON.parse(
      command.outputSchema.startsWith("@")
        ? bytes(command.outputSchema.slice(1), 65536).toString()
        : command.outputSchema,
    )
    ;(await import("./engines/codesplash/execution.ts")).outputValidator(outputSchema)
  }
  if (prompt === undefined) {
    const isTty = overrides.stdinIsTty ?? process.stdin.isTTY === true
    if (!isTty) prompt = (await (overrides.readStdinText ?? readAllOfStdin)()).trim()
  }
  if (prompt === undefined || prompt.trim() === "") {
    throw new UsageError("run needs a prompt: pass -p/--prompt, positional text, or pipe it on stdin")
  }

  const { applyStoredCredentials, hydrateKeyringCredentials } = await import("./engines/codesplash/auth.ts")
  await measureStartup("startup.credentials", async () => {
    await hydrateKeyringCredentials(env)
    applyStoredCredentials(env)
  })

  const { inspectProject } = await import("./core/preflight.ts")
  let requestedPath = command.path ?? process.cwd()
  if (command.resume) {
    const { SessionRepository } = await import("./core/session/repository.ts")
    const target = await new SessionRepository(overrides.store?.root)
      .resolve(command.resume)
      .catch(() => undefined)
    if (target?.effectiveProjectId) requestedPath = target.projectPath
  }
  const project = await measureStartup("startup.project", () => inspectProject(requestedPath))

  const { configDirectory, configFilePath, loadConfig } = await import("./core/config.ts")
  const config = await measureStartup("startup.configuration", () =>
    loadConfig(configFilePath(configDirectory(env)), command.configOverrides, {
      cwd: project.cwd,
      env,
      workspaceTrusted: command.trust || undefined,
      profile: command.profile,
      strict: command.strictConfig,
    }),
  )

  if (command.model !== undefined && !command.model.startsWith("ext_")) {
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
    disableExtensions: command.disableExtensions,
  }
  let policy = effectiveSessionPolicy(config, appOptions)
  let localSessionId: string = crypto.randomUUID()
  let recorder: SessionRecorder | undefined
  let sessionState: import("./core/session/control.ts").SessionStateAccess | undefined
  let promptHistory: import("./core/session/prompt-history.ts").PromptHistory | undefined
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
    const { projectPromptHistory } = await import("./core/session/prompt-history.ts")
    promptHistory = await projectPromptHistory(store.root, projectId, "codesplash")

    if (resuming) {
      const targetId = command.resume ?? (await latestCodesplashSessionId(store, projectId))
      let handle: Awaited<ReturnType<SessionStore["open"]>>
      try {
        const { SessionRepository } = await import("./core/session/repository.ts")
        const target = await new SessionRepository(store.root).resolve(targetId, projectId)
        handle = await store.open(target.projectId, targetId)
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
      recorder = new SessionRecorder(handle)
      const { events: priorEvents } = await readSessionEvents(handle.directory)
      let highestSequence = handle.meta.lastSequence
      for (const event of priorEvents) {
        if (event.sequence > highestSequence) highestSequence = event.sequence
      }
      firstSequence = highestSequence + 1
      initialUsage = usageSnapshotFromEvents(priorEvents)
      sessionState = handle.state
      nativeTranscriptPath = transcriptPathFor(handle)
      policy = resumedSessionPolicy(handle.meta, command.sandboxOverride, config, stderr)
      // The runner settles mode precedence (flag > recorded > policy) and reports what it used;
      // the write goes through the recorder's chain so it never races other meta updates.
      recordedPermissionMode = handle.meta.permissionMode
      const resumedRecorder = recorder
      recordPermissionMode = (mode) => resumedRecorder.recordPermissionMode(mode)
    } else {
      const now = new Date().toISOString()
      const handle = await store.create({
        schemaVersion: 2,
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
      sessionState = handle.state
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
  const attachmentInput = (await import("./core/launch-input.ts")).launchInput(
    project.cwd,
    prompt,
    command.files,
  )
  const exitCode = await runHeadless({
    images: attachmentInput?.images,
    files: attachmentInput?.files,
    agent: command.agent,
    inputs,
    execution: command.execution,
    outputSchema,
    outputLastMessage: command.outputLastMessage,
    resuming,
    prompt,
    cwd: project.cwd,
    model: command.model ?? config.models?.codesplash,
    effort: command.effort,
    policy,
    autoApprove: command.auto,
    maxTurns: command.maxTurns,
    outputFormat: command.outputFormat,
    recorder,
    driver,
    localSessionId,
    nativeTranscriptPath,
    sessionState,
    promptHistory,
    firstSequence,
    initialUsage,
    permissionModeOverride: command.permissionMode,
    recordedPermissionMode,
    permissionOverrides,
    permissionGrantsPath,
    trustWorkspace: command.trust,
    disableExtensions: command.disableExtensions,
    trustDataDir,
    recordPermissionMode,
    stdout: overrides.stdout,
    stderr: overrides.stderr,
  })
  if (inputs && !overrides.readStdinText) process.stdin.destroy()
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
    if (payload.embeddingInputTokens !== undefined)
      snapshot.embeddingInputTokens = payload.embeddingInputTokens
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

  const finishArguments = beginStartupPhase("startup.arguments")
  let args = process.argv.slice(2)
  let requestedHardening = process.env.CODESPLASH_HARDEN === "1"
  while (args[0] === "--offline" || args[0] === "--harden") {
    if (args.shift() === "--offline") process.env.CODESPLASH_OFFLINE = "1"
    else requestedHardening = true
  }
  args = dispatchArguments(process.argv0, args)
  finishArguments()
  let hardening: Awaited<ReturnType<typeof import("./core/hardening.ts").hardenProcess>> | undefined
  if (requestedHardening) {
    hardening = await measureStartup("startup.hardening", async () =>
      (await import("./core/hardening.ts")).hardenProcess(),
    )
  }
  if (args[0] === "--build-info") {
    process.stdout.write(
      `${JSON.stringify({ ...brand, version: APP_VERSION, ...(hardening ? { hardening } : {}) })}\n`,
    )
    return
  }
  if (args[0] === "windows-sandbox") {
    process.exitCode = await (await import("./commands/windows-sandbox.ts")).runWindowsSandboxCommand(
      args.slice(1),
    )
    return
  }
  if (args[0] === "isolate") {
    if (!args[1] || args[2] !== "--")
      throw new UsageError("Usage: codesplash isolate PROFILE.json -- COMMAND [ARGS...]")
    process.exitCode = await (await import("./core/startup-isolation.ts")).runIsolatedAgent(
      args[1],
      args.slice(3),
    )
    return
  }
  if (args[0] === "wrap") {
    process.exitCode = await (await import("./commands/wrap.ts")).runWrapCommand(args.slice(1))
    return
  }
  if (args[0] === "disk") {
    process.exitCode = await (await import("./commands/disk.ts")).runDiskCommand(args.slice(1))
    return
  }
  if (args[0] === "relay") {
    process.exitCode = await (await import("./commands/relay.ts")).runRelayCommand(args.slice(1))
    return
  }
  if (args[0] === "key-proxy") {
    process.exitCode = await (await import("./commands/key-proxy.ts")).runKeyProxyCommand(args.slice(1))
    return
  }
  if (args[0] === "identity") {
    process.exitCode = await (await import("./commands/identity.ts")).runIdentityCommand(args.slice(1))
    return
  }
  if (["update", "fleet", "features"].includes(args[0] ?? "")) {
    process.exitCode = await (await import("./commands/distribution.ts")).runDistributionCommand(
      args[0]!,
      args.slice(1),
    )
    return
  }
  if (!args[0]?.startsWith("--internal-") && !args.includes("--doctor") && !args.includes("--version"))
    await measureStartup("startup.installation", async () =>
      (await import("./core/distribution/update.ts")).assertInstallationReady(),
    )
  if (
    !args.includes("--no-history") &&
    !args[0]?.startsWith("--internal-") &&
    process.env.CODESPLASH_DIAGNOSTICS_DISABLED !== "1"
  ) {
    const { startAppDiagnostics } = await import("./core/diagnostics.ts")
    startAppDiagnostics()
  }
  if (["diagnostics", "trace", "feedback"].includes(args[0] ?? "")) {
    process.exitCode = await (await import("./commands/diagnostics.ts")).runDiagnosticsCommand(
      args[0]!,
      args.slice(1),
    )
    return
  }

  if (args[0] === "tools") {
    process.exitCode = await (await import("./commands/tools.ts")).runToolsCommand(args.slice(1))
    return
  }
  if (args[0] === "models") {
    process.exitCode = await (await import("./commands/models.ts")).runModelsCommand(args.slice(1))
    return
  }
  if (args[0] === "eval") {
    process.exitCode = await (await import("./commands/evals.ts")).runEvalCommand(args.slice(1))
    return
  }
  if (args[0] === "open") {
    process.exitCode = await (await import("./commands/open-link.ts")).runOpenLink(args.slice(1))
    return
  }
  if (args[0] === "pr") {
    process.exitCode = await (await import("./commands/pr.ts")).runPrCommand(args.slice(1))
    return
  }
  if (args[0] === "integrations") {
    process.exitCode = await (await import("./commands/integrations.ts")).runIntegrationsCommand(
      args.slice(1),
    )
    return
  }
  if (args[0] === "ide") {
    process.exitCode = await (await import("./commands/ide.ts")).runIdeCommand(args.slice(1))
    return
  }
  if (args[0] === "lsp") {
    process.exitCode = await (await import("./commands/language.ts")).runLanguageCommand(args.slice(1))
    return
  }
  if (["serve", "attach", "daemon", "acp", "mcp-server", "generate"].includes(args[0] ?? "")) {
    process.exitCode = await (await import("./commands/server.ts")).runServerCommand(args[0]!, args.slice(1))
    return
  }

  if (args[0] === "--internal-session-sqlite") {
    ;(await import("./core/session/foreign-sqlite-worker.ts")).foreignSqliteMain(args[1])
    return
  }
  if (args[0] === "--internal-sandbox-supervisor") {
    await (await import("./engines/codesplash/sandbox/supervisor.ts")).supervisorMain()
    return
  }
  if (args[0] === "--internal-sandbox-pty-supervisor") {
    const { terminalSupervisorMain } = await import("./engines/codesplash/sandbox/terminal-worker.ts")
    await terminalSupervisorMain()
    return
  }
  if (args[0] === "--internal-sandbox-stream-supervisor") {
    await (await import("./engines/codesplash/sandbox/supervisor.ts")).streamSupervisorMain()
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

  if (args[0] === "mcp") {
    process.exitCode = await (await import("./commands/mcp.ts")).runMcpCommand(args.slice(1))
    return
  }
  if (args[0] === "plugin") {
    process.exitCode = await (await import("./commands/plugin.ts")).runPluginCommand(args.slice(1))
    return
  }
  if (args[0] === "peer") {
    process.exitCode = await (await import("./commands/peer.ts")).runPeerCommand(args.slice(1))
    return
  }
  if (args[0] === "projection") {
    process.exitCode = await (await import("./commands/projection.ts")).runProjectionCommand(args.slice(1))
    return
  }
  if (args[0] === "worktree") {
    process.exitCode = await (await import("./commands/worktree.ts")).runWorktreeCommand(args.slice(1))
    return
  }
  if (args[0] === "teams") {
    process.exitCode = await (await import("./commands/teams.ts")).runTeamsCommand(args.slice(1))
    return
  }
  if (args[0] === "scheduler") {
    process.exitCode = await (await import("./commands/scheduler.ts")).runSchedulerCommand(args.slice(1))
    return
  }
  if (args[0] === "workflows") {
    process.exitCode = await (await import("./commands/workflows.ts")).runWorkflowsCommand(args.slice(1))
    return
  }
  if (args[0] === "automation") {
    process.exitCode = await (await import("./commands/automation.ts")).runAutomationCommand(args.slice(1))
    return
  }
  if (args[0] === "agents" || args[0] === "agent") {
    process.exitCode = await (await import("./commands/agents.ts")).runAgentsCommand(args.slice(1))
    return
  }
  if (args[0] === "shell-state") {
    process.exitCode = await (await import("./commands/shell-state.ts")).runShellStateCommand(args.slice(1))
    return
  }
  if (args[0] === "extensions") {
    process.exitCode = await (await import("./commands/extensions.ts")).runExtensionsCommand(args.slice(1))
    return
  }
  if (args[0] === "hooks") {
    process.exitCode = await (await import("./commands/hooks.ts")).runHooksCommand(args.slice(1))
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

  if (args[0] === "session") {
    process.exitCode = await (await import("./commands/session.ts")).runSessionCommand(args.slice(1))
    return
  }

  if (args[0] === "config") {
    const { args: rest, ...configOptions } = extractConfigOverrides(args.slice(1))
    process.exitCode = await (await import("./commands/config.ts")).runConfigCommand(rest, configOptions)
    return
  }

  if (args[0] === "memory") {
    const { args: rest, ...configOptions } = extractConfigOverrides(args.slice(1))
    process.exitCode = await (await import("./commands/memory.ts")).runMemoryCommand(rest, configOptions)
    return
  }
  if (args[0] === "import") {
    process.exitCode = await (await import("./commands/import.ts")).runImportCommand(args.slice(1))
    return
  }
  if (args[0] === "create-skill") {
    const [name, flag, ...extra] = args.slice(1)
    if (!name || (flag && flag !== "--write") || extra.length)
      throw new UsageError("Usage: codesplash create-skill <name> [--write]")
    process.stdout.write(
      await (await import("./engines/codesplash/inputs/authoring.ts")).createSkill(
        process.cwd(),
        name,
        flag === "--write",
      ),
    )
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
    const { args: rest, ...configOptions } = extractConfigOverrides(args.slice(1))
    process.exitCode = await runReviewCommand(rest, configOptions)
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
    const { args: rest, ...configOptions } = extractConfigOverrides(args.slice(1))
    process.exitCode = await runDebugCommand(rest, configOptions)
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

  if (!process.stdin.isTTY) {
    const { readLaunchPipe } = await import("./core/launch-input.ts")
    const piped = await readLaunchPipe(process.stdin)
    if (piped.trim()) {
      options.launch ??= { files: [] }
      const launch = options.launch
      launch.prompt = [launch.prompt, piped].filter(Boolean).join("\n\n")
    }
    const { openSync } = await import("node:fs"),
      { ReadStream } = await import("node:tty")
    const terminal = new ReadStream(openSync(process.platform === "win32" ? "CONIN$" : "/dev/tty", "r"))
    Object.defineProperty(process, "stdin", { value: terminal, configurable: true })
    ;(await import("./core/lifecycle.ts")).registerCleanup(() => {
      terminal.destroy()
    })
  }

  // Stored native-engine credentials feed the interactive session too (env vars still win).
  const { applyStoredCredentials, hydrateKeyringCredentials } = await import("./engines/codesplash/auth.ts")
  await measureStartup("startup.credentials", async () => {
    await hydrateKeyringCredentials()
    applyStoredCredentials()
  })

  const { inspectProject } = await import("./core/preflight.ts")
  const project = await measureStartup("startup.project", () => inspectProject(path ?? process.cwd()))
  const { runWelcome } = await measureStartup("startup.tui-import", () => import("./tui/run-welcome.tsx"))
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
