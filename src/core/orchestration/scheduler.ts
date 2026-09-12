import { existsSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { atomic, canonicalRoot, digest, directory, json, lease } from "../session/files.ts"
import { type AutomationLimits, boundedText, limitsOf, object } from "./automation.ts"

export type ScheduleSpec = {
  name: string
  prompt: string
  agent?: string
  interval?: string
  cron?: string
  watch?: string
  limits: AutomationLimits
  maxOccurrences: number
  totalTokens: number
  expiresAfterMs: number
}
export type ScheduleRecord = {
  id: string
  spec: ScheduleSpec
  enabled: boolean
  fingerprint: string
  identity: string
  created: number
  expires: number
  next: number
  count: number
  used: number
  reserved: number
  reason?: string
}
export type ScheduleOccurrence = {
  id: string
  schedule: string
  due: number
  created: number
  status: "running" | "completed" | "failed" | "execution-uncertain"
  reserved: number
  used: number
  owner: string
  session?: string
  workflow?: string
  task?: string
  output?: string
  reviewed?: boolean
}
export type ScheduleRequest =
  | { action: "list" }
  | { action: "create"; spec: ScheduleSpec; enabled?: boolean }
  | { action: "enable"; id: string; fingerprint: string }
  | { action: "delete"; id: string }
  | { action: "review"; occurrence: string }
  | { action: "start"; durationMs: number }
  | { action: "stop" }
  | { action: "run"; id: string }
type Manifest = {
  version: 1
  cwd: string
  revision: string
  schedules: ScheduleRecord[]
  occurrences: ScheduleOccurrence[]
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const hash = /^[a-f0-9]{64}$/
export function intervalMs(raw: unknown): number {
  const value = boundedText(raw, 16),
    match = /^(\d+)(s|m|h|d)$/.exec(value)
  const ms = match ? Number(match[1]) * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]!] ?? 0) : 0
  if (!Number.isSafeInteger(ms) || ms < 60000 || ms > 604800000)
    throw new Error("Schedule interval must be 1 minute–7 days")
  return ms
}
export function cadence(spec: Pick<ScheduleSpec, "interval" | "cron">): number {
  if (spec.interval !== undefined && spec.cron === undefined) return intervalMs(spec.interval)
  const match =
    typeof spec.cron === "string" && spec.interval === undefined
      ? /^\*\/(\d+) \* \* \* \*$/.exec(spec.cron)
      : undefined
  const minutes = match ? Number(match[1]) : 0
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 60 || 60 % minutes !== 0)
    throw new Error("Supported cron is UTC */N * * * * with N dividing 60; select one recurrence")
  return minutes * 60000
}
export function scheduleSpec(raw: unknown): ScheduleSpec {
  const v = object(raw, [
    "name",
    "prompt",
    "agent",
    "interval",
    "cron",
    "watch",
    "limits",
    "maxOccurrences",
    "totalTokens",
    "expiresAfterMs",
  ])
  if (typeof v.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v.name))
    throw new Error("Invalid schedule name")
  boundedText(v.prompt, v.watch === undefined ? 4096 : 2048)
  if (v.agent !== undefined) boundedText(v.agent, 256)
  const limits = limitsOf(v.limits)
  if (limits.rounds !== 1) throw new Error("Scheduled prompts use one bounded workflow step")
  cadence(v as ScheduleSpec)
  if (
    v.watch !== undefined &&
    (typeof v.watch !== "string" ||
      v.watch.length > 1024 ||
      isAbsolute(v.watch) ||
      v.watch.split("/").some((p) => !p || p === ".." || (p.startsWith(".") && p !== ".")) ||
      v.watch.includes("\\") ||
      v.watch.includes("\0"))
  )
    throw new Error("Watch root must be a literal visible workspace directory (or .)")
  for (const [key, min, max] of [
    ["maxOccurrences", 1, 1000],
    ["totalTokens", limits.tokens, 1000000],
    ["expiresAfterMs", 60000, 604800000],
  ] as const)
    if (!Number.isSafeInteger(v[key]) || (v[key] as number) < min || (v[key] as number) > max)
      throw new Error(`Invalid schedule ${key}`)
  return structuredClone(v) as ScheduleSpec
}
export const scheduleFingerprint = (spec: ScheduleSpec) => digest(JSON.stringify(scheduleSpec(spec)))
const next = (spec: ScheduleSpec, now: number) =>
  spec.cron ? (Math.floor(now / cadence(spec)) + 1) * cadence(spec) : now + cadence(spec)
/** Durable explicit scheduling, independent of transcript retention. All writes use a private OS lease. */
export class ScheduleStore {
  readonly cwd: string
  readonly root: string
  #worker?: { id: string; release: () => void }
  constructor(
    cwd: string,
    dataRoot: string,
    readonly now: () => number = Date.now,
  ) {
    this.cwd = canonicalRoot(cwd)
    this.root = join(canonicalRoot(dataRoot), "schedules", digest(this.cwd))
  }
  #validate(raw: unknown): Manifest {
    const m = raw as Manifest
    if (
      !m ||
      m.version !== 1 ||
      m.cwd !== this.cwd ||
      !uuid.test(m.revision) ||
      !Array.isArray(m.schedules) ||
      m.schedules.length > 32 ||
      !Array.isArray(m.occurrences) ||
      m.occurrences.length > 256 ||
      Buffer.byteLength(JSON.stringify(m)) > 524288
    )
      throw new Error("Corrupt schedule manifest")
    const ids = new Set<string>()
    for (const s of m.schedules) {
      if (
        !s ||
        !uuid.test(s.id) ||
        ids.has(s.id) ||
        typeof s.enabled !== "boolean" ||
        typeof s.identity !== "string" ||
        s.identity.length > 8192 ||
        !hash.test(s.fingerprint) ||
        [s.created, s.expires, s.next, s.count, s.used, s.reserved].some(
          (n) => !Number.isSafeInteger(n) || n < 0,
        ) ||
        (s.reason !== undefined && (typeof s.reason !== "string" || s.reason.length > 2048))
      )
        throw new Error("Corrupt schedule record")
      ids.add(s.id)
      if (scheduleFingerprint(s.spec) !== s.fingerprint) throw new Error("Schedule fingerprint changed")
    }
    ids.clear()
    for (const o of m.occurrences) {
      if (
        !o ||
        !uuid.test(o.id) ||
        ids.has(o.id) ||
        !uuid.test(o.schedule) ||
        !uuid.test(o.owner) ||
        !["running", "completed", "failed", "execution-uncertain"].includes(o.status) ||
        [o.due, o.created, o.reserved, o.used].some((n) => !Number.isSafeInteger(n) || n < 0) ||
        (o.output !== undefined && (typeof o.output !== "string" || Buffer.byteLength(o.output) > 4096)) ||
        (o.reviewed !== undefined && typeof o.reviewed !== "boolean") ||
        [o.session, o.workflow, o.task].some(
          (id) => id !== undefined && (typeof id !== "string" || !uuid.test(id)),
        )
      )
        throw new Error("Corrupt occurrence journal")
      ids.add(o.id)
    }
    return m
  }
  read(): Manifest {
    const path = join(this.root, "schedules.json")
    return existsSync(path)
      ? structuredClone(this.#validate(json(path, 524288)))
      : { version: 1, cwd: this.cwd, revision: crypto.randomUUID(), schedules: [], occurrences: [] }
  }
  #update<T>(change: (manifest: Manifest) => T): T {
    directory(this.root, true)
    const release = lease(this.root, "schedule-edit.lease")
    try {
      const m = this.read(),
        result = change(m)
      m.revision = crypto.randomUUID()
      this.#validate(m)
      atomic(join(this.root, "schedules.json"), JSON.stringify(m))
      return result
    } finally {
      release()
    }
  }
  create(raw: unknown, identity: string, enabled = false) {
    return this.createMany([raw], identity, enabled)[0]!
  }
  createMany(raw: unknown[], identity: string, enabled = false) {
    if (!raw.length || raw.length > 32) throw new Error("Schedule import requires 1–32 definitions")
    const now = this.now(),
      records: ScheduleRecord[] = raw.map((value) => {
        const spec = scheduleSpec(value)
        return {
          id: crypto.randomUUID(),
          spec,
          enabled,
          fingerprint: scheduleFingerprint(spec),
          identity,
          created: now,
          expires: now + spec.expiresAfterMs,
          next: next(spec, now),
          count: 0,
          used: 0,
          reserved: 0,
        }
      })
    this.#update((m) => {
      const all = [...m.schedules, ...records]
      if (all.length > 32 || new Set(all.map((s) => s.spec.name)).size !== all.length)
        throw new Error("Schedule count or unique name limit reached")
      m.schedules.push(...records)
    })
    return structuredClone(records)
  }
  enable(id: string, fingerprint: string, identity: string) {
    this.#update((m) => {
      const s = m.schedules.find((s) => s.id === id)
      if (!s || s.fingerprint !== fingerprint)
        throw new Error("Schedule is missing or changed; review exact fingerprint")
      if (
        m.occurrences.some(
          (o) => o.schedule === id && (o.status === "running" || (o.status !== "completed" && !o.reviewed)),
        )
      )
        throw new Error("Review active/uncertain occurrence before enabling future runs")
      if (
        s.count >= s.spec.maxOccurrences ||
        s.used + s.spec.limits.tokens > s.spec.totalTokens ||
        this.now() >= s.expires
      )
        throw new Error("Schedule lifetime budget or expiry exhausted")
      s.enabled = true
      s.identity = identity
      s.next = next(s.spec, this.now())
      delete s.reason
    })
  }
  disable(id: string, reason: string) {
    this.#update((m) => {
      const s = m.schedules.find((s) => s.id === id)
      if (!s) throw new Error("Unknown schedule")
      s.enabled = false
      s.reason = reason.slice(0, 2048)
    })
  }
  remove(id: string) {
    this.#update((m) => {
      const i = m.schedules.findIndex((s) => s.id === id)
      if (i < 0) throw new Error("Unknown schedule")
      if (
        m.occurrences.some(
          (o) => o.schedule === id && (o.status === "running" || (o.status !== "completed" && !o.reviewed)),
        )
      )
        throw new Error("Review uncertain occurrences before deleting the schedule")
      m.schedules.splice(i, 1)
    })
  }
  review(id: string) {
    this.#update((m) => {
      const o = m.occurrences.find((o) => o.id === id)
      if (!o || !["execution-uncertain", "failed"].includes(o.status))
        throw new Error("No reviewable occurrence")
      o.reviewed = true
    })
  }
  acquireWorker(): string {
    if (this.#worker) throw new Error("Scheduler worker already started")
    directory(this.root, true)
    const release = lease(this.root, "scheduler-worker.lease"),
      id = crypto.randomUUID()
    this.#worker = { id, release }
    try {
      this.#update((m) => {
        for (const o of m.occurrences)
          if (o.status === "running") {
            o.status = "execution-uncertain"
            o.used = o.reserved
            const s = m.schedules.find((s) => s.id === o.schedule)
            if (s) {
              s.used += o.reserved
              s.reserved = Math.max(0, s.reserved - o.reserved)
              s.enabled = false
              s.reason = "Previous occurrence outcome is uncertain; review before future runs"
            }
          }
      })
      return id
    } catch (error) {
      this.releaseWorker()
      throw error
    }
  }
  releaseWorker() {
    this.#worker?.release()
    this.#worker = undefined
  }
  get ownsWorker() {
    return !!this.#worker
  }
  due(dirty: ReadonlySet<string> = new Set()): ScheduleRecord[] {
    if (!this.#worker) throw new Error("Scheduler worker lease required")
    const now = this.now()
    const m = this.read()
    return m.schedules
      .filter(
        (s) =>
          s.enabled &&
          s.next <= now &&
          (!s.spec.watch || dirty.has(s.id)) &&
          now < s.expires &&
          s.count < s.spec.maxOccurrences &&
          s.used + s.reserved + s.spec.limits.tokens <= s.spec.totalTokens,
      )
      .sort((a, b) => a.next - b.next)
      .slice(0, 1)
  }
  begin(id: string, identity: string, dirty = false, manual = false): ScheduleOccurrence {
    if (!this.#worker) throw new Error("Scheduler worker lease required")
    const owner = this.#worker.id,
      now = this.now()
    return this.#update((m) => {
      const s = m.schedules.find((s) => s.id === id)
      if (
        !s?.enabled ||
        s.identity !== identity ||
        (!manual && s.next > now) ||
        now >= s.expires ||
        s.count >= s.spec.maxOccurrences ||
        s.used + s.reserved + s.spec.limits.tokens > s.spec.totalTokens ||
        (s.spec.watch && !dirty && !manual) ||
        m.occurrences.some((o) => o.status === "running")
      )
        throw new Error("Schedule is no longer admissible")
      if (m.occurrences.length >= 256) {
        const i = m.occurrences.findIndex((o) => o.status === "completed" || o.reviewed)
        if (i < 0) throw new Error("Uncertain occurrence retention limit reached")
        m.occurrences.splice(i, 1)
      }
      const due = manual
        ? now
        : s.spec.cron
          ? Math.floor(now / cadence(s.spec)) * cadence(s.spec)
          : s.next + Math.floor((now - s.next) / cadence(s.spec)) * cadence(s.spec)
      const o: ScheduleOccurrence = {
        id: crypto.randomUUID(),
        schedule: id,
        due,
        created: now,
        status: "running",
        reserved: s.spec.limits.tokens,
        used: 0,
        owner,
      }
      s.next = next(s.spec, now)
      s.count++
      s.reserved += o.reserved
      m.occurrences.push(o)
      return structuredClone(o)
    })
  }
  attach(id: string, session: string, workflow: string, task: string) {
    this.#update((m) => {
      const o = m.occurrences.find((o) => o.id === id)
      if (!o || o.owner !== this.#worker?.id || o.status !== "running")
        throw new Error("Occurrence ownership changed")
      Object.assign(o, { session, workflow, task })
    })
  }
  finish(
    id: string,
    result: { status: "completed" | "failed" | "execution-uncertain"; used?: number; output: string },
  ) {
    this.#update((m) => {
      const o = m.occurrences.find((o) => o.id === id),
        s = m.schedules.find((s) => s.id === o?.schedule)
      if (!o || !s || o.owner !== this.#worker?.id || o.status !== "running")
        throw new Error("Occurrence ownership changed")
      const known = result.used !== undefined && Number.isSafeInteger(result.used) && result.used >= 0
      o.status = known ? result.status : "execution-uncertain"
      o.used = known ? result.used! : o.reserved
      o.output = Buffer.from(result.output).subarray(0, 1024).toString("utf8")
      s.used += o.used
      s.reserved -= o.reserved
      if (
        o.status !== "completed" ||
        s.count >= s.spec.maxOccurrences ||
        s.used + s.spec.limits.tokens > s.spec.totalTokens ||
        this.now() >= s.expires
      ) {
        s.enabled = false
        s.reason =
          o.status === "completed"
            ? "Lifetime budget or expiry reached"
            : "Occurrence needs review before future runs"
      }
    })
  }
}
