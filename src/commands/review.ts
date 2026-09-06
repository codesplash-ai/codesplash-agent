/**
 * `codesplash review`: collects a git diff (uncommitted work, a base ref, or one commit), wraps
 * it in a senior-reviewer prompt, and runs one headless CodeSplash turn over it under a read-only
 * sandbox. The exit code is the headless runner's; git failures are reported as values (stderr
 * message, exit 1), and only caller mistakes throw UsageError.
 */
import {
  type ConfigPermissionMode,
  configDirectory,
  configFilePath,
  dataDirectory,
  type EngineDriver,
  inspectProject,
  isConfigPermissionMode,
  isValidPermissionRule,
  loadConfig,
  registerChildProcess,
} from "../core/index.ts"
import { applyStoredCredentials } from "../engines/codesplash/auth.ts"
import { buildProviderRegistry } from "../engines/codesplash/catalog.ts"
import { CodesplashDriver } from "../engines/codesplash/engine.ts"
import { type HeadlessSink, runHeadless } from "../engines/codesplash/runner.ts"
import { UsageError } from "./usage-error.ts"

/** Diff bytes handed to the reviewer prompt; larger diffs are cut with a truncation note. */
export const REVIEW_DIFF_CAP_BYTES = 200 * 1024
const GIT_TIMEOUT_MS = 30_000

export type ReviewMode =
  | { kind: "uncommitted" }
  | { kind: "base"; ref: string }
  | { kind: "commit"; sha: string }

export type ReviewOutputFormat = "text" | "json"

export type ReviewCommand = {
  path?: string
  mode: ReviewMode
  model?: string
  outputFormat: ReviewOutputFormat
  auto: boolean
  /** `--permission-mode`: explicit permission mode for the review turn. */
  permissionMode?: ConfigPermissionMode
  /** Repeatable `--allow`/`--ask`/`--deny`: CLI-tier permission rules. */
  allowRules: string[]
  askRules: string[]
  denyRules: string[]
  /** `--trust`: persist a trusted decision for the workspace before the review runs. */
  trust: boolean
}

/* -------------------------------------- parsing -------------------------------------- */

/**
 * Same permission-rule grammar check the config loader and cli.ts use (kept local: command
 * modules never import cli.ts). Violations are usage errors so they exit 2 at parse time.
 */
function checkPermissionRule(flag: string, value: string | undefined): string {
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
function checkPermissionModeValue(value: string | undefined): ConfigPermissionMode {
  if (value !== undefined && isConfigPermissionMode(value)) return value
  if (value === "bypass") {
    throw new UsageError(
      "--permission-mode cannot select bypass; bypass requires the --bypass-approvals launch flag each session",
    )
  }
  throw new UsageError(`--permission-mode expects plan, default, or accept-edits, got ${value ?? "nothing"}`)
}

export function parseReviewArguments(args: string[]): ReviewCommand {
  const modes: ReviewMode[] = []
  let path: string | undefined
  let model: string | undefined
  let outputFormat: ReviewOutputFormat = "text"
  let auto = false
  let permissionMode: ConfigPermissionMode | undefined
  let trust = false
  const allowRules: string[] = []
  const askRules: string[] = []
  const denyRules: string[] = []

  for (let index = 0; index < args.length; index++) {
    const argument = args[index] as string
    if (argument === "--uncommitted") {
      modes.push({ kind: "uncommitted" })
    } else if (argument === "--base" || argument.startsWith("--base=")) {
      const value = argument.includes("=") ? argument.slice("--base=".length) : args[++index]
      if (value === undefined || value === "") throw new UsageError("--base expects a git ref")
      modes.push({ kind: "base", ref: value })
    } else if (argument === "--commit" || argument.startsWith("--commit=")) {
      const value = argument.includes("=") ? argument.slice("--commit=".length) : args[++index]
      if (value === undefined || value === "") throw new UsageError("--commit expects a commit sha")
      modes.push({ kind: "commit", sha: value })
    } else if (argument === "--model" || argument.startsWith("--model=")) {
      const value = argument.includes("=") ? argument.slice("--model=".length) : args[++index]
      if (value === undefined) {
        throw new UsageError("--model expects a model id, optionally with :low, :medium, or :high")
      }
      model = value
    } else if (argument === "--output-format" || argument.startsWith("--output-format=")) {
      const value = argument.includes("=") ? argument.slice("--output-format=".length) : args[++index]
      if (value !== "text" && value !== "json") {
        throw new UsageError(`--output-format expects text or json for review, got ${value ?? "nothing"}`)
      }
      outputFormat = value
    } else if (argument === "--auto") {
      auto = true
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
        "--bypass-approvals: review approves with --auto; dangerous commands are always declined headlessly",
      )
    } else if (argument.startsWith("-")) {
      throw new UsageError(`Unknown option ${argument} for review`)
    } else if (path === undefined) {
      path = argument
    } else {
      throw new UsageError("review expects at most one project path")
    }
  }

  if (modes.length > 1) {
    throw new UsageError("--uncommitted, --base, and --commit are mutually exclusive; pass at most one")
  }

  return {
    path,
    mode: modes[0] ?? { kind: "uncommitted" },
    model,
    outputFormat,
    auto,
    permissionMode,
    allowRules,
    askRules,
    denyRules,
    trust,
  }
}

/* ----------------------------------- git collection ----------------------------------- */

export type GitResult = { exitCode: number; stdout: string; stderr: string }
/** Runs one git invocation in `cwd`; injectable so tests never depend on a real repository. */
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>

async function defaultGitRunner(args: string[], cwd: string): Promise<GitResult> {
  try {
    const { safeGitArguments, safeGitEnvironment } = await import("../core/git-process.ts")
    const child = Bun.spawn(["git", ...safeGitArguments(args)], {
      cwd,
      env: safeGitEnvironment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    // A dying harness must not orphan the git child; a hung git call is killed, not awaited forever.
    const unregisterChild = registerChildProcess(child)
    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS)
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      return { exitCode, stdout, stderr }
    } finally {
      clearTimeout(timer)
      unregisterChild()
    }
  } catch (error) {
    return { exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }
  }
}

type DiffCollection = { diff: string } | { error: string }

/** Collects the diff for a review mode; failures come back as values, never throws. */
export async function collectReviewDiff(
  mode: ReviewMode,
  cwd: string,
  git: GitRunner,
): Promise<DiffCollection> {
  // --end-of-options stops git from parsing a caller-supplied ref/sha that starts with "-" as an
  // option (e.g. `--commit --output=/path` would otherwise make git write to an arbitrary file).
  if (mode.kind === "base") {
    return diffOrError(
      await git(["diff", "--end-of-options", `${mode.ref}...HEAD`], cwd),
      `git diff --end-of-options ${mode.ref}...HEAD`,
    )
  }
  if (mode.kind === "commit") {
    return diffOrError(
      await git(["show", "--patch", "--end-of-options", mode.sha], cwd),
      `git show --patch --end-of-options ${mode.sha}`,
    )
  }

  const tracked = await git(["diff", "HEAD"], cwd)
  if (tracked.exitCode !== 0) return gitError("git diff HEAD", tracked)

  const status = await git(["status", "--porcelain", "--untracked-files=all"], cwd)
  if (status.exitCode !== 0) return gitError("git status --porcelain", status)

  const parts = [tracked.stdout]
  for (const path of untrackedPathsFrom(status.stdout)) {
    // Untracked files have no index entry; --no-index against /dev/null renders them as adds.
    // Exit code 1 just means "differences found" for --no-index diffs.
    const untracked = await git(["diff", "--no-index", "--", "/dev/null", path], cwd)
    if (untracked.exitCode > 1) return gitError(`git diff --no-index -- /dev/null ${path}`, untracked)
    parts.push(untracked.stdout)
  }

  return { diff: parts.filter((part) => part.trim() !== "").join("\n") }
}

function diffOrError(result: GitResult, label: string): DiffCollection {
  return result.exitCode === 0 ? { diff: result.stdout } : gitError(label, result)
}

function gitError(label: string, result: GitResult): { error: string } {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`
  return { error: `${label} failed: ${detail}` }
}

function untrackedPathsFrom(porcelain: string): string[] {
  const paths: string[] = []
  for (const line of porcelain.split("\n")) {
    if (!line.startsWith("?? ")) continue
    paths.push(unquoteGitPath(line.slice(3)))
  }
  return paths
}

/** Git C-quotes unusual paths; JSON unescaping covers the common escapes, octal falls through. */
function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === "string" ? parsed : raw.slice(1, -1)
  } catch {
    return raw.slice(1, -1)
  }
}

/* ------------------------------------ prompt build ------------------------------------ */

/** Builds the reviewer prompt around the (already capped) diff. */
export function buildReviewPrompt(diff: string, mode: ReviewMode, truncated: boolean): string {
  const label =
    mode.kind === "uncommitted"
      ? "uncommitted changes"
      : mode.kind === "base"
        ? `changes since ${mode.ref}`
        : `commit ${mode.sha}`

  const sections = [
    "You are performing a senior code review of the change below.",
    [
      "Review rubric:",
      "- Hunt for real defects first: correctness, security, data loss, concurrency, and API misuse; then significant maintainability hazards.",
      "- READ the surrounding source files with the available tools before asserting anything; never guess at code you have not opened.",
      "- Judge only the changed behavior; do not restyle code the change leaves untouched.",
      "- Skip compliments and nitpicks that a formatter or linter would catch.",
    ].join("\n"),
    [
      "Report each finding on its own line, exactly as:",
      "severity (critical|major|minor) · file:line · one-line claim · why it fails",
      "",
      'If the change is clean, report exactly: "No findings."',
    ].join("\n"),
    `## Change under review (${label})\n\n\`\`\`\`diff\n${diff}\n\`\`\`\``,
  ]
  if (truncated) {
    sections.push(
      `Note: the diff was truncated at ${Math.floor(REVIEW_DIFF_CAP_BYTES / 1024)}KB; read the files themselves for the full change.`,
    )
  }
  return sections.join("\n\n")
}

/** UTF-8 byte cap that never splits a code point (at most one full character is lost). */
function capDiffBytes(diff: string): { diff: string; truncated: boolean } {
  if (Buffer.byteLength(diff, "utf8") <= REVIEW_DIFF_CAP_BYTES) return { diff, truncated: false }
  const bytes = Buffer.from(diff, "utf8").subarray(0, REVIEW_DIFF_CAP_BYTES)
  let end = bytes.length
  while (end > 0 && ((bytes[end - 1] as number) & 0b1100_0000) === 0b1000_0000) end--
  if (end > 0 && ((bytes[end - 1] as number) & 0b1000_0000) !== 0) end--
  return { diff: bytes.subarray(0, end).toString("utf8"), truncated: true }
}

/* ------------------------------------- execution ------------------------------------- */

/** Test seams; every field defaults to the real process surface. */
export type ReviewCommandOverrides = {
  /** Scripted engine for tests; defaults to the real CodesplashDriver inside the runner. */
  driver?: EngineDriver
  stdout?: HeadlessSink
  stderr?: HeadlessSink
  env?: NodeJS.ProcessEnv
  /** Git invocation seam; defaults to spawning the real git binary. */
  git?: GitRunner
  /** Repeatable `-c/--config key=value` overrides (extracted by cli.ts) for the config load. */
  configOverrides?: readonly string[]
}

export async function runReviewCommand(
  args: string[],
  overrides: ReviewCommandOverrides = {},
): Promise<number> {
  const command = parseReviewArguments(args)
  const env = overrides.env ?? process.env
  const stdout = overrides.stdout ?? process.stdout
  const stderr = overrides.stderr ?? process.stderr
  const git = overrides.git ?? defaultGitRunner

  applyStoredCredentials(env)

  const config = await loadConfig(configFilePath(configDirectory(env)), overrides.configOverrides)

  if (command.model !== undefined) {
    try {
      buildProviderRegistry(config, env).parseSelector(command.model)
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error))
    }
  }

  const project = await inspectProject(command.path ?? process.cwd())

  const collection = await collectReviewDiff(command.mode, project.cwd, git)
  if ("error" in collection) {
    stderr.write(`codesplash: ${collection.error}\n`)
    return 1
  }
  if (collection.diff.trim() === "") {
    stdout.write("Nothing to review.\n")
    return 0
  }

  const { diff, truncated } = capDiffBytes(collection.diff)
  const prompt = buildReviewPrompt(diff, command.mode, truncated)

  // Reviews never mutate the workspace: the read-only sandbox refuses writes at the tool layer,
  // and on-request approvals keep bash gated behind the runner's accept/decline handling. The
  // default driver reuses this command's config load, -c overrides included. Permission flags
  // pass straight through to the runner; the policy deliberately carries no permissionMode
  // fallback, so without --permission-mode a review runs in "default" mode regardless of the
  // configured [permissions].mode (a config-wide plan mode must not hijack reviews).
  const permissionOverrides =
    command.allowRules.length + command.askRules.length + command.denyRules.length > 0
      ? { allow: command.allowRules, ask: command.askRules, deny: command.denyRules }
      : undefined
  return runHeadless({
    prompt,
    cwd: project.cwd,
    model: command.model,
    policy: { sandbox: "read-only", approvalPolicy: "on-request" },
    autoApprove: command.auto,
    outputFormat: command.outputFormat,
    permissionModeOverride: command.permissionMode,
    permissionOverrides,
    trustWorkspace: command.trust,
    trustDataDir: dataDirectory(env),
    driver: overrides.driver ?? new CodesplashDriver({ config }),
    stdout: overrides.stdout,
    stderr: overrides.stderr,
  })
}
