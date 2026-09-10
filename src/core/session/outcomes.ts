import { createHash } from "node:crypto"
import type { SessionUsageSnapshot } from "../engine.ts"
import type { AgentEvent } from "../events.ts"

export type ToolCategory = "read" | "write" | "process" | "search" | "memory" | "other"
export type TurnOutcome = {
  id: string
  firstSequence: number
  lastSequence: number
  started: string
  ended?: string
  elapsedMs?: number
  status: "running" | "completed" | "interrupted" | "failed" | "uncertain"
  tools: Record<ToolCategory, { completed: number; failed: number }>
  approvals: { accepted: number; declined: number; cancelled: number; other: number }
  incomplete?: boolean
  errors: number
  usage: SessionUsageSnapshot
}
export type OutcomeState = {
  version: 1
  cursor: number
  dropped: number
  rows: TurnOutcome[]
  cumulativeUsage: SessionUsageSnapshot
  baseUsage: SessionUsageSnapshot
  tools: Record<string, { category: ToolCategory; status: string }>
  approvals: Record<string, "approval" | "user-input">
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32)
export const emptyOutcomes = (): OutcomeState => ({
  version: 1,
  cursor: -1,
  dropped: 0,
  rows: [],
  cumulativeUsage: {},
  baseUsage: {},
  tools: {},
  approvals: {},
})
export function observedUsage(value: SessionUsageSnapshot): SessionUsageSnapshot {
  const result: SessionUsageSnapshot = {}
  for (const key of [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "embeddingInputTokens",
    "estimatedCostUsd",
  ] as const) {
    const number = value[key]
    if (typeof number === "number" && Number.isFinite(number) && number >= 0) result[key] = number
  }
  if (typeof value.hasUnpricedUsage === "boolean") result.hasUnpricedUsage = value.hasUnpricedUsage
  return result
}
function usageDelta(after: SessionUsageSnapshot, before: SessionUsageSnapshot): SessionUsageSnapshot {
  return Object.fromEntries(
    Object.entries(observedUsage(after)).map(([key, value]) => [
      key,
      typeof value === "boolean"
        ? value
        : Math.max(0, value - Number(before[key as keyof SessionUsageSnapshot] ?? 0)),
    ]),
  )
}
function category(label: string): ToolCategory {
  const name = label.split(/[\s(:]/, 1)[0] ?? ""
  if (["read_file", "list_directory", "context_read", "context_files", "read_tool_output"].includes(name))
    return "read"
  if (["write_file", "edit_file", "apply_patch"].includes(name)) return "write"
  if (["bash", "shell", "exec_command"].includes(name)) return "process"
  if (["glob", "grep", "web_search", "web_fetch"].includes(name)) return "search"
  if (/^(?:memory_|history_read)/.test(name)) return "memory"
  return "other"
}
function newOutcome(event: AgentEvent): TurnOutcome {
  return {
    id: hash(`${event.engine}:${event.localSessionId}:${event.sequence}`),
    firstSequence: event.sequence,
    lastSequence: event.sequence,
    started: Number.isFinite(Date.parse(event.timestamp))
      ? new Date(event.timestamp).toISOString()
      : new Date(0).toISOString(),
    status: "running",
    tools: {
      read: { completed: 0, failed: 0 },
      write: { completed: 0, failed: 0 },
      process: { completed: 0, failed: 0 },
      search: { completed: 0, failed: 0 },
      memory: { completed: 0, failed: 0 },
      other: { completed: 0, failed: 0 },
    },
    approvals: { accepted: 0, declined: 0, cancelled: 0, other: 0 },
    errors: 0,
    usage: {},
  }
}
/** Pure projection. Persist only its rows/cursors; never event payloads or tool/request identifiers. */
export function reduceOutcome(state: OutcomeState, event: AgentEvent): OutcomeState {
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= state.cursor) return state
  const next = { ...state, cursor: event.sequence }
  if (event.kind === "turn.started") {
    const rows = [...state.rows]
    const previous = rows.at(-1)
    if (previous?.status === "running") rows[rows.length - 1] = { ...previous, status: "uncertain" }
    rows.push(newOutcome(event))
    return {
      ...next,
      rows: rows.slice(-1000),
      dropped: state.dropped + Math.max(0, rows.length - 1000),
      baseUsage: { ...state.cumulativeUsage },
      tools: {},
      approvals: {},
    }
  }
  if (event.kind === "usage.updated")
    next.cumulativeUsage = { ...state.cumulativeUsage, ...observedUsage(event.payload) }
  const last = state.rows.at(-1)
  if (!last || last.status !== "running") return next
  if (
    ![
      "item.updated",
      "request.opened",
      "request.resolved",
      "usage.updated",
      "error",
      "turn.completed",
    ].includes(event.kind)
  )
    return next
  const row = structuredClone(last)
  next.rows = [...state.rows.slice(0, -1), row]
  row.lastSequence = event.sequence
  if (event.kind === "item.updated") {
    if (
      typeof event.payload.id !== "string" ||
      typeof event.payload.label !== "string" ||
      !["running", "completed", "failed"].includes(event.payload.status)
    ) {
      row.incomplete = true
      return next
    }
    const id = hash(event.payload.id),
      old = state.tools[id],
      kind = old?.category ?? category(event.payload.label)
    if (Object.keys(state.tools).length >= 10000 && !old) {
      row.incomplete = true
      return next
    }
    if (old?.status === "completed" || old?.status === "failed") row.tools[old.category][old.status]--
    if (event.payload.status === "completed" || event.payload.status === "failed")
      row.tools[kind][event.payload.status]++
    next.tools = { ...state.tools, [id]: { category: kind, status: event.payload.status } }
  } else if (event.kind === "request.opened") {
    if (
      typeof event.payload.id !== "string" ||
      !["approval", "user-input"].includes(event.payload.requestKind)
    ) {
      row.incomplete = true
      return next
    }
    if (Object.keys(state.approvals).length < 10000)
      next.approvals = { ...state.approvals, [hash(event.payload.id)]: event.payload.requestKind }
  } else if (event.kind === "request.resolved") {
    if (typeof event.payload.id !== "string" || typeof event.payload.decision !== "string") {
      row.incomplete = true
      return next
    }
    const id = hash(event.payload.id)
    if (state.approvals[id] === "approval") {
      const decision = event.payload.decision.toLowerCase()
      row.approvals[
        /^(accept|allow|approve)/.test(decision)
          ? "accepted"
          : /^(decline|deny|reject)/.test(decision)
            ? "declined"
            : /cancel/.test(decision)
              ? "cancelled"
              : "other"
      ]++
    }
    next.approvals = { ...state.approvals }
    delete next.approvals[id]
  } else if (event.kind === "error") row.errors++
  else if (event.kind === "usage.updated") row.usage = usageDelta(next.cumulativeUsage, state.baseUsage)
  else if (event.kind === "turn.completed") {
    row.status = ["completed", "interrupted", "failed"].includes(event.payload.status)
      ? event.payload.status
      : "uncertain"
    for (const kind of Object.values(state.approvals))
      if (kind === "approval") row.approvals[row.status === "interrupted" ? "cancelled" : "other"]++
    if (Number.isFinite(Date.parse(event.timestamp))) {
      row.ended = new Date(event.timestamp).toISOString()
      row.elapsedMs = Math.max(0, Date.parse(event.timestamp) - Date.parse(row.started))
    }
    row.usage = usageDelta(next.cumulativeUsage, state.baseUsage)
    next.tools = {}
    next.approvals = {}
  }
  return next
}
export function projectOutcomes(events: readonly AgentEvent[]): OutcomeState {
  return events.reduce(reduceOutcome, emptyOutcomes())
}
export function outcomeSummary(row: TurnOutcome): string {
  const completed = Object.values(row.tools).reduce((sum, value) => sum + value.completed, 0),
    failed = Object.values(row.tools).reduce((sum, value) => sum + value.failed, 0)
  const tokens = (row.usage.inputTokens ?? 0) + (row.usage.outputTokens ?? 0)
  return `${row.status} · ${completed} tools completed${failed ? `, ${failed} failed` : ""} · ${row.approvals.accepted} approvals accepted, ${row.approvals.declined} declined${row.errors ? ` · ${row.errors} errors` : ""}${tokens ? ` · ${tokens} observed tokens` : ""}${row.usage.hasUnpricedUsage ? " · usage/cost incomplete" : ""}${row.incomplete ? " · outcome counts incomplete" : ""}`
}
export function localRecap(state: OutcomeState, since = -1, active = true): string {
  const rows = state.rows.filter((row) => row.lastSequence > since).slice(-20)
  if (!rows.length) return "No recorded turn outcomes in this range."
  return [
    `${rows.length} recent turn outcomes${state.dropped ? `; ${state.dropped} older outcomes outside the retained range` : ""}:`,
    ...rows.map(
      (row) =>
        `${row.firstSequence}–${row.lastSequence}: ${outcomeSummary(!active && row.status === "running" ? { ...row, status: "uncertain" } : row)}`,
    ),
  ].join("\n")
}
