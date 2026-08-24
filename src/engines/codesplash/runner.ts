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
  type SessionPolicy,
  type SessionRecorder,
  serializeEvent,
  type TurnStatus,
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
  const output = createOutput(options.outputFormat, stdout, stderr)

  let session: EngineSession
  try {
    session = await driver.openSession({
      cwd: options.cwd,
      localSessionId: options.localSessionId ?? crypto.randomUUID(),
      model: headlessModelSelector(options.model, options.effort),
      policy: options.policy,
    })
  } catch (error) {
    stderr.write(`codesplash: ${describeError(error)}\n`)
    return 1
  }
  if (session.nativeSessionId) recorder?.recordNativeSessionId(session.nativeSessionId)

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
          const choice =
            event.payload.requestKind === "approval" ? (options.autoApprove ? "accept" : "decline") : "cancel"
          if (choice === "decline") stderr.write(`declined: ${event.payload.title}\n`)
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
): HeadlessOutput {
  if (format === "text") return new TextOutput(stdout, stderr)
  if (format === "json") return new JsonOutput(stdout)
  return new StreamJsonOutput(stdout)
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
    }
  }

  get result(): string {
    return this.#lastMessageId === undefined ? "" : (this.#messages.get(this.#lastMessageId) ?? "")
  }

  get usage(): { inputTokens?: number; outputTokens?: number; totalTokens?: number } {
    const usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {}
    if (this.#inputTokens !== undefined) usage.inputTokens = this.#inputTokens
    if (this.#outputTokens !== undefined) usage.outputTokens = this.#outputTokens
    const total = this.#totalTokens ?? this.#contextTokens
    if (total !== undefined) usage.totalTokens = total
    return usage
  }
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

  constructor(private readonly stdout: HeadlessSink) {}

  onEvent(event: AgentEvent): void {
    this.#accumulator.observe(event)
  }

  finish(status: FinalTurnStatus, turns: number): void {
    const { result, usage } = this.#accumulator
    this.stdout.write(`${JSON.stringify({ result, turns, usage, status })}\n`)
  }
}

/**
 * Every consumed AgentEvent as one JSON line on stdout — the recorder-shaped serialization with
 * the raw provider payload stripped — then a final result line.
 */
class StreamJsonOutput implements HeadlessOutput {
  readonly #accumulator = new ResultAccumulator()

  constructor(private readonly stdout: HeadlessSink) {}

  onEvent(event: AgentEvent): void {
    this.#accumulator.observe(event)
    this.stdout.write(`${serializeEvent(event)}\n`)
  }

  finish(status: FinalTurnStatus): void {
    const { result, usage } = this.#accumulator
    this.stdout.write(`${JSON.stringify({ type: "result", result, status, usage })}\n`)
  }
}

/* -------------------------------------- helpers -------------------------------------- */

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
