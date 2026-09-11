/** Versioned host hook data. Protocol credentials and provider reasoning are never fields. */
export const HOOK_EVENTS = [
  "session.start",
  "session.resume",
  "session.end",
  "input.admit",
  "turn.start",
  "turn.end",
  "tool.before",
  "tool.after",
  "tool.error",
  "permission.request",
  "compaction.before",
  "compaction.after",
  "compaction.error",
  "turn.stop",
  "resource.before",
  "resource.after",
  "config.before",
  "config.after",
  "cwd.before",
  "cwd.after",
  "branch.before",
  "branch.after",
] as const
export type HookEventName = (typeof HOOK_EVENTS)[number]
export type HookSharedField = "text" | "input" | "result" | "cwd" | "reason" | "transition"
export type HookFields = {
  text?: string
  input?: Record<string, unknown>
  result?: string
  cwd?: string
  reason?: string
  transition?: Record<string, unknown>
}
export type HookEvent = {
  version: 1
  id: string
  name: HookEventName
  sessionId: string
  turnId?: string
  operationId?: string
  generation: string
  metadata: {
    toolName?: string
    toolSource?: string
    toolGeneration?: string
    status?: "completed" | "failed" | "interrupted"
    mode?: string
    kind?: string
    /** No arbitrary internal tool dispatch is exposed through project hooks. */
    hidden?: boolean
  }
  fields: HookFields
}
export type HookResult = {
  version: 1
  decision?: "deny" | "ask" | "allow"
  reason?: string
  input?: Record<string, unknown>
  text?: string
  context?: string
  result?: string
  instructions?: string
  continuation?: string
  diagnostic?: string
}
export type HookActivity = {
  handler: string
  source: string
  fingerprint: string
  generation: string
  event: HookEventName
  operationId: string
  state: "running" | "completed" | "failed" | "uncertain" | "skipped"
  detail?: string
}

const gates = new Set<HookEventName>([
  "session.start",
  "session.resume",
  "input.admit",
  "turn.start",
  "tool.before",
  "permission.request",
  "compaction.before",
  "resource.before",
  "config.before",
  "cwd.before",
  "branch.before",
])
export function hookIsGate(name: HookEventName): boolean {
  return gates.has(name)
}

/** Exact or one-star glob. No regular expressions, alternation or implicit substring matches. */
export function hookMatches(pattern: string, value: string): boolean {
  const star = pattern.indexOf("*")
  if (star < 0) return pattern === value
  const prefix = pattern.slice(0, star),
    suffix = pattern.slice(star + 1)
  return value.length >= prefix.length + suffix.length && value.startsWith(prefix) && value.endsWith(suffix)
}
