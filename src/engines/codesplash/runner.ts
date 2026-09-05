/**
 * Headless runner for the CodeSplash engine: one prompt drives one turn, streamed to stdio in one
 * of three output formats, and the process exit code reports how the turn ended. The runner
 * consumes an EngineSession's event stream directly (no TUI, no SessionController) and resolves
 * approval and user-input requests itself — a headless run cannot interview the user.
 *
 * The CLI layer owns the session recorder (creating it unless `--no-history` opted out, and
 * closing it after the run); the runner records every consumed event, records the native session
 * id, and flushes pending writes before returning.
 */
import {
  type AgentEvent,
  deferSignalExit,
  type EngineDriver,
  type EngineSession,
  isConfigPermissionMode,
  type PermissionMode,
  type PermissionRuleOverrides,
  readTrustDecision,
  type SessionPolicy,
  type SessionRecorder,
  type SessionUsageSnapshot,
  serializeEvent,
  type TurnStatus,
  writeTrustDecision,
} from "../../core/index.ts"
import { defaultModelFor, defaultProvider, formatModelSelector } from "./catalog.ts"
import type { ReasoningEffort } from "./contracts.ts"
import { CodesplashDriver } from "./engine.ts"

export type HeadlessOutputFormat = "text" | "json" | "stream-json"

/** Minimal writable surface; process.stdout/stderr satisfy it and tests capture plain strings. */
export type HeadlessSink = { write(chunk: string): unknown }

/** Recorder surface the runner needs; a real SessionRecorder satisfies it, and so do test fakes. */
export type HeadlessRecorder = Pick<SessionRecorder, "record" | "recordNativeSessionId" | "flush">

/** Upper bound on turns per run; the single-prompt cut always ends after turn 1. */
export const DEFAULT_MAX_TURNS = 40

export type HeadlessRunOptions = {
  prompt: string
  cwd: string
  /** Model id, optionally already carrying `:<effort>`; omitted → the engine's default model. */
  model?: string
  /** Reasoning effort combined with `model` (or the default model) into an `id:effort` selector. */
  effort?: ReasoningEffort
  policy: SessionPolicy
  /** Accept approval requests instead of declining them; user-input is always cancelled. */
  autoApprove: boolean
  /** Defensive upper bound on turns (default 40); one prompt runs one turn in this cut. */
  maxTurns?: number
  outputFormat: HeadlessOutputFormat
  /** CLI-owned session recorder; omitted under `--no-history`. */
  recorder?: HeadlessRecorder
  /** Injectable engine so tests run a scripted fake; defaults to the real CodesplashDriver. */
  driver?: EngineDriver
  /** Stable session id shared with the CLI's persisted event log; defaults to a random UUID. */
  localSessionId?: string
  /** Engine-owned transcript to reload on resume and append to per turn; passed to openSession. */
  nativeTranscriptPath?: string
  /** First event sequence for a resumed session's log continuity; passed to openSession. */
  firstSequence?: number
  /** Cumulative usage the resumed session already recorded; passed to openSession. */
  initialUsage?: SessionUsageSnapshot
  /** Explicit --permission-mode value; wins over a resumed session's recorded mode. */
  permissionModeOverride?: PermissionMode
  /** permissionMode recorded in a resumed session's meta; reused unless explicitly overridden. */
  recordedPermissionMode?: string
  /** CLI-tier --allow/--ask/--deny rules; passed to openSession. */
  permissionOverrides?: PermissionRuleOverrides
  /** Remembered-grants file for the engine's "always allow" persistence; passed to openSession. */
  permissionGrantsPath?: string
  /** --trust: persist a trusted=true decision for cwd before resolving workspace trust. */
  trustWorkspace?: boolean
  /** Trust-store data directory override (tests, env-derived dirs); default harness data dir. */
  trustDataDir?: string
  /** Wired by the CLI to record the run's effective permission mode into the session meta. */
  recordPermissionMode?: (mode: PermissionMode) => void
  /** Injectable sinks so tests capture output; default process.stdout / process.stderr. */
  stdout?: HeadlessSink
  stderr?: HeadlessSink
}

type FinalTurnStatus = Exclude<TurnStatus, "idle" | "running">

/**
 * Runs one headless turn and returns the process exit code (the caller calls process.exit):
 * 0 completed · 1 turn failed or provider error · 130 interrupted via SIGINT.
 */
export async function runHeadless(options: HeadlessRunOptions): Promise<number> {
  const driver = options.driver ?? new CodesplashDriver()
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const recorder = options.recorder
  const maxTurns = Math.max(1, Math.floor(options.maxTurns ?? DEFAULT_MAX_TURNS))
  const localSessionId = options.localSessionId ?? crypto.randomUUID()
  const output = createOutput(options.outputFormat, stdout, stderr, localSessionId)

  // Effective permission mode (explicit override > resumed recorded mode > the policy's resolved
  // mode) and workspace trust are settled before the session opens; the engine builds its
  // permission runtime from exactly these.
  const permissionMode = resolvePermissionMode(options, stderr)
  const workspaceTrusted = await resolveWorkspaceTrust(options, stderr)

  let session: EngineSession
  try {
    session = await driver.openSession({
      cwd: options.cwd,
      localSessionId,
      model: headlessModelSelector(options.model, options.effort),
      policy: { ...options.policy, permissionMode },
      nativeTranscriptPath: options.nativeTranscriptPath,
      firstSequence: options.firstSequence,
      initialUsage: options.initialUsage,
      workspaceTrusted,
      permissionOverrides: options.permissionOverrides,
      permissionGrantsPath: options.permissionGrantsPath,
    })
  } catch (error) {
    stderr.write(`codesplash: ${describeError(error)}\n`)
    return 1
  }
  if (session.nativeSessionId) recorder?.recordNativeSessionId(session.nativeSessionId)
  options.recordPermissionMode?.(permissionMode)

  const resolvedRequests = new Set<string>()
  let interrupted = false
  let turnStatus: FinalTurnStatus | undefined
  let turns = 0

  let closePromise: Promise<void> | undefined
  const requestClose = (): void => {
    closePromise ??= session.close().catch((error) => {
      stderr.write(`codesplash: session close failed: ${describeError(error)}\n`)
    })
  }

  // SIGINT interrupts the live turn; the turn then completes as "interrupted" and the run exits
  // 130. deferSignalExit suppresses the harness-wide signal handler (which would process.exit
  // before the final output lines are written) while this runner owns shutdown.
  const releaseSignalExit = deferSignalExit()
  const onSigint = (): void => {
    interrupted = true
    if (session.capabilities.interrupt) {
      void session.interrupt().catch(() => {})
    } else {
      requestClose()
    }
  }
  process.on("SIGINT", onSigint)

  let status: FinalTurnStatus = "failed"
  try {
    try {
      await session.send({ text: options.prompt })
      // A SIGINT during send() lands before the engine's turn exists, so interrupt() was a no-op;
      // re-issue it now that the turn has started instead of silently running the turn out.
      if (interrupted) onSigint()
      for await (const event of session.events) {
        recorder?.record(event)
        output.onEvent(event)

        if (event.kind === "warning") stderr.write(`warning: ${event.payload.message}\n`)
        if (event.kind === "request.opened") {
          // Resolve each request exactly once, immediately: headless runs cannot ask the user.
          if (resolvedRequests.has(event.payload.id)) continue
          resolvedRequests.add(event.payload.id)
          const choice = headlessRequestChoice(event.payload, options.autoApprove)
          if (choice === "decline") {
            // Dangerous-floor approvals name the command class and why --auto did not take them.
            const reason = event.payload.reason === undefined ? "" : ` — ${event.payload.reason}`
            stderr.write(
              event.payload.alwaysAsk
                ? `declined: ${event.payload.title}${reason} (always requires interactive approval; --auto never accepts it)\n`
                : `declined: ${event.payload.title}${reason}\n`,
            )
          }
          if (choice === "cancel") stderr.write(`cancelled: ${event.payload.title}\n`)
          try {
            await session.resolveRequest(event.payload.id, { choice })
          } catch (error) {
            stderr.write(`codesplash: could not resolve request: ${describeError(error)}\n`)
          }
          continue
        }
        if (event.kind === "turn.completed") {
          turns += 1
          turnStatus = event.payload.status
          // One prompt, one turn: the first completed turn ends the run. maxTurns stays the outer
          // bound so a future multi-turn cut inherits the same guard.
          if (turns >= 1 || turns >= maxTurns) break
        }
        if (event.kind === "error") {
          stderr.write(`error: ${event.payload.message}\n`)
          // A session-level crash may never complete the turn. Closing ends the event stream once
          // already-queued events (including any trailing turn.completed) have drained, so the run
          // cannot hang on a stream that will never end.
          if (!event.payload.recoverable) requestClose()
        }
      }
    } catch (error) {
      stderr.write(`codesplash: ${describeError(error)}\n`)
    }

    requestClose()
    await closePromise

    status = turnStatus ?? (interrupted ? "interrupted" : "failed")
    output.finish(status, turns)
    await recorder?.flush()
  } finally {
    // Released only after the final output line and recorder flush: a SIGINT arriving during
    // session close or flush must not re-arm the harness-wide handler, which would process.exit
    // before those writes land.
    process.removeListener("SIGINT", onSigint)
    releaseSignalExit()
  }

  return status === "completed" ? 0 : status === "interrupted" ? 130 : 1
}

/**
 * Effective permission mode for the run: an explicit --permission-mode wins, then a resumed
 * session's recorded mode, then the policy's resolved mode (same precedence as sandbox reuse).
 * A recorded "bypass" cannot be reused headless — bypass always needs the interactive launch
 * flag — so it degrades to "default" with a notice, mirroring the full-access sandbox degrade;
 * an unrecognized recorded value (meta is loosely validated) is ignored.
 */
function resolvePermissionMode(options: HeadlessRunOptions, stderr: HeadlessSink): PermissionMode {
  if (options.permissionModeOverride) return options.permissionModeOverride
  const recorded = options.recordedPermissionMode
  if (recorded === "bypass") {
    stderr.write(
      "codesplash: the recorded session ran in bypass mode, which needs the --bypass-approvals launch flag; using default (pass --permission-mode to choose)\n",
    )
    return "default"
  }
  if (recorded !== undefined && isConfigPermissionMode(recorded)) return recorded
  return options.policy.permissionMode ?? "default"
}

/**
 * Resolves workspace trust from the persistent store. `--trust` persists trusted=true first;
 * anything but a recorded trusted decision proceeds untrusted with one stderr line — run mode
 * never prompts interactively.
 */
async function resolveWorkspaceTrust(options: HeadlessRunOptions, stderr: HeadlessSink): Promise<boolean> {
  if (options.trustWorkspace) {
    try {
      await writeTrustDecision(options.cwd, true, options.trustDataDir)
    } catch (error) {
      stderr.write(`warning: could not persist workspace trust: ${describeError(error)}\n`)
    }
  }
  const decision = await readTrustDecision(options.cwd, options.trustDataDir)
  const trusted = decision?.trusted === true
  if (!trusted) {
    stderr.write(
      "Workspace not trusted: project rule files and .codesplash/permissions.toml are ignored (pass --trust to trust this folder).\n",
    )
  }
  return trusted
}

/**
 * Headless answer for a request. User-input is always cancelled; dangerous-floor approvals
 * (alwaysAsk) are declined even under --auto; plan reviews (an "approve" choice) approve under
 * --auto and cancel otherwise — the same decline-by-default posture as ordinary approvals,
 * which accept under --auto and decline otherwise. "acceptAlways" is never answered headless:
 * persisting a grant is a deliberate interactive decision.
 */
function headlessRequestChoice(
  payload: { requestKind: "approval" | "user-input"; choices: string[]; alwaysAsk?: boolean },
  autoApprove: boolean,
): string {
  if (payload.requestKind !== "approval") return "cancel"
  if (payload.alwaysAsk) return "decline"
  if (payload.choices.includes("approve")) return autoApprove ? "approve" : "cancel"
  return autoApprove ? "accept" : "decline"
}

/** Combines the model id and effort into the `id[:effort]` selector the engine parses. */
export function headlessModelSelector(
  model: string | undefined,
  effort: ReasoningEffort | undefined,
): string | undefined {
  if (model) return effort ? `${model}:${effort}` : model
  if (effort) return formatModelSelector(defaultModelFor(defaultProvider()), effort)
  return undefined
}

/* ---------------------------------- output formats ---------------------------------- */

type HeadlessOutput = {
  onEvent(event: AgentEvent): void
  finish(status: FinalTurnStatus, turns: number): void
}

function createOutput(
  format: HeadlessOutputFormat,
  stdout: HeadlessSink,
  stderr: HeadlessSink,
  sessionId: string,
): HeadlessOutput {
  if (format === "text") return new TextOutput(stdout, stderr)
  if (format === "json") return new JsonOutput(stdout, sessionId)
  return new StreamJsonOutput(stdout, sessionId)
}

/**
 * Collects the turn's outcome for the json and stream-json summaries: the final assistant
 * message's full text and the latest token usage (each usage field keeps its last defined value,
 * mirroring the TUI reducer; totalTokens falls back to the engine's contextTokens sum).
 */
class ResultAccumulator {
  readonly #messages = new Map<string, string>()
  #lastMessageId: string | undefined
  #inputTokens: number | undefined
  #outputTokens: number | undefined
  #totalTokens: number | undefined
  #contextTokens: number | undefined
  #estimatedCostUsd: number | undefined

  observe(event: AgentEvent): void {
    if (event.kind === "message.delta") {
      const { id, text } = event.payload
      this.#messages.set(id, (this.#messages.get(id) ?? "") + text)
      this.#lastMessageId = id
    } else if (event.kind === "message.completed") {
      const { id, text } = event.payload
      if (text !== undefined) this.#messages.set(id, text)
      this.#lastMessageId = id
    } else if (event.kind === "usage.updated") {
      this.#inputTokens = event.payload.inputTokens ?? this.#inputTokens
      this.#outputTokens = event.payload.outputTokens ?? this.#outputTokens
      this.#totalTokens = event.payload.totalTokens ?? this.#totalTokens
      this.#contextTokens = event.payload.contextTokens ?? this.#contextTokens
      this.#estimatedCostUsd = event.payload.estimatedCostUsd ?? this.#estimatedCostUsd
    }
  }

  get result(): string {
    return this.#lastMessageId === undefined ? "" : (this.#messages.get(this.#lastMessageId) ?? "")
  }

  get usage(): HeadlessUsage {
    const usage: HeadlessUsage = {}
    if (this.#inputTokens !== undefined) usage.inputTokens = this.#inputTokens
    if (this.#outputTokens !== undefined) usage.outputTokens = this.#outputTokens
    const total = this.#totalTokens ?? this.#contextTokens
    if (total !== undefined) usage.totalTokens = total
    if (this.#estimatedCostUsd !== undefined) usage.estimatedCostUsd = this.#estimatedCostUsd
    return usage
  }
}

type HeadlessUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  /** Session-cumulative estimated cost from the engine's usage events, when observed. */
  estimatedCostUsd?: number
}

/** Assistant text deltas stream to stdout; tool labels and their status go to stderr. */
class TextOutput implements HeadlessOutput {
  readonly #printed = new Map<string, number>()
  #wroteAny = false
  #trailing = "\n"

  constructor(
    private readonly stdout: HeadlessSink,
    private readonly stderr: HeadlessSink,
  ) {}

  onEvent(event: AgentEvent): void {
    if (event.kind === "message.delta") {
      this.#write(event.payload.text)
      this.#printed.set(
        event.payload.id,
        (this.#printed.get(event.payload.id) ?? 0) + event.payload.text.length,
      )
    } else if (event.kind === "message.completed") {
      // Engines that only report completed text still stream: print whatever the deltas missed.
      const text = event.payload.text ?? ""
      const printed = this.#printed.get(event.payload.id) ?? 0
      if (text.length > printed) this.#write(text.slice(printed))
      this.#printed.set(event.payload.id, Math.max(printed, text.length))
    } else if (event.kind === "item.updated") {
      this.stderr.write(`[${event.payload.status}] ${event.payload.label}\n`)
    }
  }

  finish(): void {
    // Leave the shell prompt on its own line without inventing output for an empty turn.
    if (this.#wroteAny && this.#trailing !== "\n") this.stdout.write("\n")
  }

  #write(text: string): void {
    if (text === "") return
    this.#wroteAny = true
    this.#trailing = text.slice(-1)
    this.stdout.write(text)
  }
}

/** Nothing until the end, then one JSON object on stdout. */
class JsonOutput implements HeadlessOutput {
  readonly #accumulator = new ResultAccumulator()

  constructor(
    private readonly stdout: HeadlessSink,
    private readonly sessionId: string,
  ) {}

  onEvent(event: AgentEvent): void {
    this.#accumulator.observe(event)
  }

  finish(status: FinalTurnStatus, turns: number): void {
    const { result, usage } = this.#accumulator
    this.stdout.write(`${JSON.stringify({ result, turns, usage, status, sessionId: this.sessionId })}\n`)
  }
}

/**
 * Every consumed AgentEvent as one JSON line on stdout — the recorder-shaped serialization with
 * the raw provider payload stripped — then a final result line.
 */
class StreamJsonOutput implements HeadlessOutput {
  readonly #accumulator = new ResultAccumulator()

  constructor(
    private readonly stdout: HeadlessSink,
    private readonly sessionId: string,
  ) {}

  onEvent(event: AgentEvent): void {
    this.#accumulator.observe(event)
    this.stdout.write(`${serializeEvent(event)}\n`)
  }

  finish(status: FinalTurnStatus): void {
    const { result, usage } = this.#accumulator
    this.stdout.write(
      `${JSON.stringify({ type: "result", result, status, usage, sessionId: this.sessionId })}\n`,
    )
  }
}

/* -------------------------------------- helpers -------------------------------------- */

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
