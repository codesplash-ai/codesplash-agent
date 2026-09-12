import type { SessionStateAccess } from "../session/control.ts"
import { digest } from "../session/files.ts"

export type AutomationLimits = { tokens: number; timeoutMs: number; rounds: number }
export type WorkflowStep = { id: string; needs?: string[] } & (
  | { kind: "prompt"; prompt: string; agent?: string }
  | { kind: "command"; command: string }
  | { kind: "verification"; prompt: string }
  | { kind: "parallel" }
)
export type WorkflowDefinition = {
  version: 1
  name: string
  enabled: boolean
  limits: AutomationLimits
  steps: WorkflowStep[]
}
export type AutomationStep = {
  id: string
  status: "running" | "completed" | "failed" | "execution-uncertain"
  task?: string
  output?: string
  evidence?: string[]
}
export type AutomationRecord = {
  id: string
  kind: "goal" | "workflow"
  objective: string
  status: "ready" | "running" | "paused" | "complete"
  limits: AutomationLimits
  used: number
  reserved: number
  uncertain: boolean
  elapsedMs: number
  round: number
  started?: number
  task?: string
  reason?: string
  identity: string
  definition?: WorkflowDefinition
  fingerprint?: string
  source?: string
  steps: AutomationStep[]
}
export type GoalRequest =
  | { action: "get" }
  | { action: "create"; objective: string; limits: AutomationLimits }
  | { action: "start" | "pause" }
  | { action: "resume"; reviewUsage?: boolean; limits?: AutomationLimits }
export type WorkflowRequest =
  | { action: "list" }
  | { action: "start"; definition: WorkflowDefinition; fingerprint: string }
  | { action: "start"; name: string; fingerprint: string }
  | { action: "pause"; id: string }
  | { action: "resume"; id: string; reviewUsage?: boolean; limits?: AutomationLimits }
  | { action: "review"; id: string; step: string; outcome: "completed" | "retry" }
  | { action: "forget"; id: string }
export function object(raw: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).some((k) => !allowed.includes(k))
  )
    throw new Error("Unknown or invalid automation fields")
  return raw as Record<string, unknown>
}
export function boundedText(raw: unknown, max: number): string {
  if (typeof raw !== "string" || !raw.trim() || raw.includes("\0") || Buffer.byteLength(raw) > max)
    throw new Error(`Expected text of 1–${max} bytes without NUL`)
  return raw
}
export function limitsOf(raw: unknown): AutomationLimits {
  const v = object(raw, ["tokens", "timeoutMs", "rounds"])
  for (const [key, min, max] of [
    ["tokens", 1000, 1000000],
    ["timeoutMs", 1000, 3600000],
    ["rounds", 1, 32],
  ] as const)
    if (!Number.isSafeInteger(v[key]) || (v[key] as number) < min || (v[key] as number) > max)
      throw new Error(`Invalid automation ${key} limit`)
  return v as AutomationLimits
}
const name = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
export function workflowOf(raw: unknown): WorkflowDefinition {
  const v = object(raw, ["version", "name", "enabled", "limits", "steps"])
  if (
    v.version !== 1 ||
    typeof v.name !== "string" ||
    !name.test(v.name) ||
    typeof v.enabled !== "boolean" ||
    !Array.isArray(v.steps) ||
    !v.steps.length ||
    v.steps.length > 128 ||
    Buffer.byteLength(JSON.stringify(v)) > 65536
  )
    throw new Error("Invalid workflow definition")
  limitsOf(v.limits)
  const seen = new Set<string>()
  for (const rawStep of v.steps) {
    const s = object(rawStep, [
      "id",
      "kind",
      "needs",
      ...(rawStep?.kind === "command"
        ? ["command"]
        : rawStep?.kind === "parallel"
          ? []
          : ["prompt", ...(rawStep?.kind === "prompt" ? ["agent"] : [])]),
    ])
    if (
      typeof s.id !== "string" ||
      s.id.length > 128 ||
      (s.task !== undefined && (typeof s.task !== "string" || !/^[a-f0-9-]{36}$/.test(s.task))) ||
      !name.test(s.id) ||
      seen.has(s.id) ||
      !["prompt", "command", "verification", "parallel"].includes(s.kind as string)
    )
      throw new Error("Invalid or duplicate workflow step")
    seen.add(s.id)
    if (
      s.needs !== undefined &&
      (!Array.isArray(s.needs) || s.needs.length > 128 || s.needs.some((n) => typeof n !== "string"))
    )
      throw new Error("Invalid workflow dependencies")
    if (s.kind !== "parallel") boundedText(s.kind === "command" ? s.command : s.prompt, 4096)
    else if (!(s.needs as string[] | undefined)?.length)
      throw new Error("Parallel joins require dependencies")
    if (s.agent !== undefined) boundedText(s.agent, 256)
  }
  const steps = v.steps as WorkflowStep[],
    visited = new Set<string>(),
    visiting = new Set<string>()
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("Workflow dependency cycle")
    if (visited.has(id)) return
    const step = steps.find((s) => s.id === id)
    if (!step) throw new Error("Unknown workflow dependency")
    visiting.add(id)
    for (const dep of step.needs ?? []) visit(dep)
    visiting.delete(id)
    visited.add(id)
  }
  for (const step of steps) visit(step.id)
  return structuredClone(v) as WorkflowDefinition
}
export const workflowFingerprint = (definition: WorkflowDefinition) =>
  digest(JSON.stringify(workflowOf(definition)))
type Journal = { version: 1; records: AutomationRecord[] }
function recordsOf(j: Journal | undefined): AutomationRecord[] {
  if (j === undefined) return []
  if (
    !j ||
    j.version !== 1 ||
    !Array.isArray(j.records) ||
    j.records.length > 9 ||
    Buffer.byteLength(JSON.stringify(j)) > 262144
  )
    throw new Error("Corrupt automation journal")
  const ids = new Set<string>()
  for (const r of j.records) {
    if (
      !r ||
      typeof r.id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(r.id) ||
      ids.has(r.id) ||
      !["goal", "workflow"].includes(r.kind) ||
      !["ready", "running", "paused", "complete"].includes(r.status) ||
      typeof r.identity !== "string" ||
      r.identity.length > 8192 ||
      (r.reason !== undefined && (typeof r.reason !== "string" || Buffer.byteLength(r.reason) > 4096)) ||
      (r.task !== undefined && (typeof r.task !== "string" || !/^[a-f0-9-]{36}$/.test(r.task))) ||
      typeof r.uncertain !== "boolean" ||
      [r.used, r.reserved, r.elapsedMs, r.round].some((v) => !Number.isSafeInteger(v) || v < 0) ||
      (r.started !== undefined && (!Number.isSafeInteger(r.started) || r.started < 0)) ||
      !Array.isArray(r.steps) ||
      r.steps.length > 128 ||
      new Set(r.steps.map((s) => s?.id)).size !== r.steps.length ||
      r.steps.some(
        (s) =>
          !s ||
          typeof s.id !== "string" ||
          s.id.length > 128 ||
          (s.task !== undefined && (typeof s.task !== "string" || !/^[a-f0-9-]{36}$/.test(s.task))) ||
          !["running", "completed", "failed", "execution-uncertain"].includes(s.status) ||
          (s.output !== undefined && (typeof s.output !== "string" || Buffer.byteLength(s.output) > 4096)),
      )
    )
      throw new Error("Corrupt automation record")
    ids.add(r.id)
    boundedText(r.objective, 4096)
    limitsOf(r.limits)
    if (r.source !== undefined && (typeof r.source !== "string" || !name.test(r.source)))
      throw new Error("Corrupt workflow source")
    if (r.definition) {
      workflowOf(r.definition)
      if (workflowFingerprint(r.definition) !== r.fingerprint) throw new Error("Workflow fingerprint changed")
    }
    if (r.kind === "workflow" && !r.definition) throw new Error("Missing workflow definition")
  }
  if (j.records.filter((r) => r.kind === "goal").length > 1) throw new Error("Multiple current goals")
  return structuredClone(j.records)
}
/** Canonical control journal; all mutations occur under the existing session owner. */
export class AutomationJournal {
  constructor(readonly state: SessionStateAccess) {}
  list(): AutomationRecord[] {
    this.state.assertOwned?.()
    const j = this.state.read().state.values.automation as Journal | undefined
    return recordsOf(j)
  }
  update(change: (records: AutomationRecord[]) => void) {
    const before = this.state.read(),
      records = this.list()
    change(records)
    const journal: Journal = { version: 1, records }
    if (records.length > 9 || Buffer.byteLength(JSON.stringify(journal)) > 262144)
      throw new Error("Automation journal retention limit reached")
    recordsOf(journal)
    this.state.update(before.revision, "automation/update", (s) => {
      s.values.automation = journal
    })
  }
  recover() {
    this.update((records) => {
      for (const r of records) {
        if (r.reserved) {
          r.used += r.reserved
          r.reserved = 0
          r.uncertain = true
        }
        if (r.status === "running") {
          r.elapsedMs += Math.max(0, Date.now() - (r.started ?? Date.now()))
          delete r.started
          r.status = "paused"
          r.reason = "Previous owner stopped; review unconfirmed work before resuming"
          for (const s of r.steps) if (s.status === "running") s.status = "execution-uncertain"
        }
      }
    })
  }
}
