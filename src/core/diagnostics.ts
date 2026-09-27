/** Content-free, bounded diagnostics. Callers cannot attach arbitrary strings or objects. */
import { AsyncLocalStorage } from "node:async_hooks"
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  unlinkSync,
} from "node:fs"
import { join } from "node:path"
import { dataDirectory } from "./config.ts"
import type { AgentEvent } from "./events.ts"
import { operationKinds } from "./operation-kinds.ts"
import { atomic, bytes, component, directory, json } from "./session/files.ts"
import { attachStartupTiming, startupKinds } from "./startup-timing.ts"
import { Telemetry } from "./telemetry.ts"

export const diagnosticKinds = [
  ...operationKinds,
  ...startupKinds,
  "app.start",
  "app.exit",
  "app.crash",
  "app.recovered",
  "session.start",
  "session.close",
  "session.status",
  "turn.started",
  "turn.completed",
  "request.opened",
  "request.resolved",
  "item.updated",
  "usage.updated",
  "provider.start",
  "provider.first",
  "provider.delta",
  "provider.end",
  "provider.retry",
  "cache.break.model",
  "cache.break.tools",
  "cache.break.system",
  "cache.break.parameters",
  "cache.break.policy",
  "cache.break.history",
  "cache.hit-loss",
  "compaction.start",
  "compaction.end",
  "compaction.error",
  "git.operation",
  "index.operation",
  "warning",
  "error",
] as const
export type DiagnosticKind = (typeof diagnosticKinds)[number]
export type DiagnosticValues = Partial<
  Record<
    | "durationMs"
    | "gapMs"
    | "attempt"
    | "delayMs"
    | "status"
    | "count"
    | "inputTokens"
    | "outputTokens"
    | "cachedInputTokens"
    | "estimatedCostUsd"
    | "failed"
    | "interrupted"
    | "phase",
    number
  >
>
export type DiagnosticRecord = {
  version: 1
  trace: string
  sequence: number
  time: number
  kind: DiagnosticKind
  values: DiagnosticValues
}
const valueKeys = new Set([
  "durationMs",
  "gapMs",
  "attempt",
  "delayMs",
  "status",
  "count",
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "estimatedCostUsd",
  "failed",
  "interrupted",
  "phase",
])
const kinds = new Set<string>(diagnosticKinds)
export const diagnosticRoot = () => join(dataDirectory(), "diagnostics")
export const diagnosticContext = new AsyncLocalStorage<Diagnostics>()
const maxBytes = 2 * 1024 * 1024

export function cleanRecord(raw: unknown): DiagnosticRecord {
  if (!raw || typeof raw !== "object") throw new Error("Invalid diagnostic record")
  const r = raw as DiagnosticRecord
  if (
    r.version !== 1 ||
    !/^[a-f0-9]{32}$/.test(r.trace) ||
    !Number.isSafeInteger(r.sequence) ||
    r.sequence < 1 ||
    !Number.isFinite(r.time) ||
    !kinds.has(r.kind)
  )
    throw new Error("Unsupported diagnostic record")
  const values: DiagnosticValues = {}
  for (const [key, value] of Object.entries(r.values ?? {}))
    if (valueKeys.has(key) && typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e15)
      values[key as keyof DiagnosticValues] = value
  return { version: 1, trace: r.trace, sequence: r.sequence, time: r.time, kind: r.kind, values }
}

export class Diagnostics {
  readonly trace = crypto.randomUUID().replaceAll("-", "")
  readonly started = performance.now()
  #turnStarted = performance.now()
  #lastTime = 0
  #sequence = 0
  #bytes = 0
  #part = 0
  #disabled = false
  #closed = false
  #telemetry?: Telemetry
  #sink?: (record: DiagnosticRecord) => void
  constructor(
    readonly root?: string,
    sink?: (record: DiagnosticRecord) => void,
  ) {
    this.#telemetry = root ? new Telemetry() : undefined
    this.#sink = sink ?? ((record) => this.#telemetry?.record(record))
    if (root)
      try {
        directory(root, true)
        retainDiagnostics(root)
      } catch {
        this.#disabled = true
      }
  }
  record(kind: DiagnosticKind, values: DiagnosticValues = {}): void {
    if (this.#closed || process.env.CODESPLASH_DIAGNOSTICS_DISABLED === "1") return
    try {
      this.#lastTime = Math.max(Date.now(), this.#lastTime)
      const record = cleanRecord({
        version: 1,
        trace: this.trace,
        sequence: ++this.#sequence,
        time: this.#lastTime,
        kind,
        values,
      })
      try {
        this.#sink?.(record)
      } catch {}
      if (!this.root || this.#disabled) return
      const line = JSON.stringify(record) + "\n"
      if (this.#bytes + Buffer.byteLength(line) > maxBytes) {
        this.#part++
        this.#bytes = 0
        if (this.#part > 3) unlinkSync(join(this.root, `${this.trace}-${this.#part - 4}.jsonl`))
        retainDiagnostics(this.root)
      }
      const path = join(this.root, `${this.trace}-${this.#part}.jsonl`)
      const fd = openSync(
        path,
        constants.O_CREAT |
          constants.O_APPEND |
          constants.O_WRONLY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      )
      try {
        const info = fstatSync(fd)
        if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes)
          throw new Error("Unsafe diagnostic log")
        appendFileSync(fd, line)
      } finally {
        closeSync(fd)
      }
      this.#bytes += Buffer.byteLength(line)
    } catch {
      this.#disabled = true
    }
  }
  event(event: AgentEvent): void {
    if (event.kind === "turn.started") this.#turnStarted = performance.now()
    if (event.kind === "usage.updated") this.record(event.kind, event.payload)
    else if (event.kind === "turn.completed")
      this.record(event.kind, {
        failed: +(event.payload.status === "failed"),
        interrupted: +(event.payload.status === "interrupted"),
        durationMs: performance.now() - this.#turnStarted,
      })
    else if (kinds.has(event.kind)) this.record(event.kind as DiagnosticKind)
  }
  async settled(): Promise<void> {
    await this.#telemetry?.close()
  }
  close(): void {
    this.record("session.close", { durationMs: performance.now() - this.started })
    this.#closed = true
  }
}

export function retainDiagnostics(root: string): void {
  directory(root)
  const files = readdirSync(root)
    .filter((name) => /^[a-f0-9]{32}-\d+\.jsonl$/.test(name))
    .map((name) => ({ name, info: lstatSync(join(root, name)) }))
    .filter(({ info }) => info.isFile() && !info.isSymbolicLink())
  files.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)
  let size = 0
  for (const [i, file] of files.entries()) {
    size += file.info.size
    if (i >= 64 || size > 64 * 1024 * 1024 || file.info.mtimeMs < Date.now() - 14 * 86400000)
      unlinkSync(join(root, file.name))
  }
}

export function diagnosticFiles(root = diagnosticRoot()): string[] {
  if (!existsSync(root)) return []
  directory(root)
  return readdirSync(root)
    .filter((name) => /^[a-f0-9]{32}-\d+\.jsonl$/.test(name))
    .sort()
    .slice(-256)
}
export function readDiagnostics(root: string, file: string): DiagnosticRecord[] {
  component(file)
  if (!/^[a-f0-9]{32}-\d+\.jsonl$/.test(file)) throw new Error("Invalid trace file")
  return bytes(join(root, file), maxBytes + 4096)
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((line) => cleanRecord(JSON.parse(line)))
}
export function exportDiagnostics(root = diagnosticRoot()): { version: 1; records: DiagnosticRecord[] } {
  const records: DiagnosticRecord[] = []
  for (const file of diagnosticFiles(root)) {
    for (const record of readDiagnostics(root, file)) {
      if (records.length >= 20000) break
      records.push(record)
    }
    if (records.length >= 20000) break
  }
  return { version: 1, records: records.sort((a, b) => a.time - b.time || a.sequence - b.sequence) }
}
/** Diagnostic replay is a pure summary; it cannot issue model/tool calls. */
export function replayDiagnostics(raw: unknown) {
  const value = raw as { version?: number; records?: unknown[] }
  if (value?.version !== 1 || !Array.isArray(value.records) || value.records.length > 20000)
    throw new Error("Invalid diagnostic export")
  const records = value.records.map(cleanRecord),
    counts: Record<string, number> = {}
  const last = new Map<string, number>()
  for (const record of records) {
    if (record.sequence <= (last.get(record.trace) ?? 0))
      throw new Error("Trace sequence is duplicated or out of order")
    last.set(record.trace, record.sequence)
    counts[record.kind] = (counts[record.kind] ?? 0) + 1
  }
  return { version: 1, traces: last.size, records: records.length, counts }
}

/** Minimal crash marker deliberately stores no exception messages, stack paths or argv. */
export function startAppDiagnostics(root = diagnosticRoot()): () => void {
  const log = new Diagnostics(root),
    marker = join(root, `${log.trace}.active.json`)
  try {
    for (const name of readdirSync(root)
      .filter((name) => /^[a-f0-9]{32}\.active\.json$/.test(name))
      .slice(0, 128)) {
      const path = join(root, name),
        value = json<{ pid: number }>(path, 4096)
      if (!Number.isSafeInteger(value.pid) || value.pid < 1) continue
      try {
        process.kill(value.pid, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          log.record("app.recovered")
          unlinkSync(path)
        }
      }
    }
    atomic(marker, JSON.stringify({ pid: process.pid, time: Date.now() }))
  } catch {}
  const detachTiming = attachStartupTiming(({ kind, ...values }) => log.record(kind, values))
  log.record("app.start", { durationMs: performance.now() })
  const crash = () => log.record("app.crash")
  process.on("uncaughtExceptionMonitor", crash)
  const exit = (code: number) => {
    detachTiming()
    log.record("app.exit", { status: code })
    if (code === 0)
      try {
        unlinkSync(marker)
      } catch {}
    log.close()
  }
  process.once("exit", exit)
  return () => {
    process.off("uncaughtExceptionMonitor", crash)
    process.off("exit", exit)
    exit(process.exitCode ? Number(process.exitCode) : 0)
  }
}
