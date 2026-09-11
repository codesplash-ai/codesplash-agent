import { isTable } from "../../../core/config/source.ts"
import { HOOK_EVENTS, type HookEventName, type HookSharedField, hookIsGate } from "../../../core/hooks.ts"
import { validateMcpConfig } from "../mcp/config.ts"

export type HookHandlerConfig = {
  enabled: boolean
  events: HookEventName[]
  kind: "command" | "http"
  command?: string
  args?: string[]
  environment?: string[]
  trustFiles?: string[]
  url?: string
  bearerEnv?: string
  allowLoopback?: boolean
  matchTools: string[]
  matchSources: string[]
  share: HookSharedField[]
  timeoutMs: number
  async: boolean
  once: "never" | "turn" | "session"
  writeWorkspace: boolean
  allowInputRewrite: boolean
  allowTextRewrite: boolean
  allowResultRewrite: boolean
  allowDefaultApproval: boolean
  allowContinuation: boolean
}
export type HookConfig = {
  handlers: Record<string, HookHandlerConfig>
  continuation: { maxCount: number; maxDurationMs: number; maxTokens: number }
}
export const HOOK_ID = /^[a-z][a-z0-9_-]{0,31}$/
const bools = [
  "enabled",
  "async",
  "writeWorkspace",
  "allowInputRewrite",
  "allowTextRewrite",
  "allowResultRewrite",
  "allowDefaultApproval",
  "allowContinuation",
] as const
function array(value: unknown, name: string, max: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    value.some(
      (entry) => typeof entry !== "string" || !entry || entry.length > 256 || /[\x00-\x1f\x7f]/.test(entry),
    )
  )
    throw new Error(`Hooks ${name}: expected at most ${max} bounded strings`)
  return [...new Set(value as string[])]
}
function number(value: unknown, fallback: number, min: number, max: number): number {
  const result = value ?? fallback
  if (typeof result !== "number" || !Number.isInteger(result) || result < min || result > max)
    throw new Error(`Hook limit must be an integer between ${min} and ${max}`)
  return result
}
export function validateHookConfig(raw: unknown): HookConfig {
  if (
    !isTable(raw) ||
    Object.keys(raw).some((key) => !["handlers", "continuation"].includes(key)) ||
    !isTable(raw.handlers)
  )
    throw new Error("[hooks]: expected named handlers")
  if (Object.keys(raw.handlers).length > 64) throw new Error("At most 64 hook handlers are supported")
  const handlers: Record<string, HookHandlerConfig> = Object.create(null)
  for (const [id, value] of Object.entries(raw.handlers)) {
    if (!HOOK_ID.test(id) || !isTable(value)) throw new Error("Invalid hook handler identifier or definition")
    const known = [
      ...bools,
      "events",
      "kind",
      "command",
      "args",
      "environment",
      "trustFiles",
      "url",
      "bearerEnv",
      "allowLoopback",
      "matchTools",
      "matchSources",
      "share",
      "timeoutMs",
      "once",
    ]
    if (Object.keys(value).some((key) => !known.includes(key)))
      throw new Error("Unknown hook setting; credentials require references")
    for (const key of bools)
      if (value[key] !== undefined && typeof value[key] !== "boolean")
        throw new Error(`Hook ${key} must be boolean`)
    if (!["command", "http"].includes(value.kind as string))
      throw new Error("Hook kind must be command or http")
    const events = array(value.events, "events", 32)
    if (!events.length || events.some((event) => !HOOK_EVENTS.includes(event as HookEventName)))
      throw new Error("Unsupported hook event; subagent events require M7")
    const matchTools = array(value.matchTools ?? [], "matchTools", 16),
      matchSources = array(value.matchSources ?? [], "matchSources", 16)
    if (
      [...matchTools, ...matchSources].some(
        (pattern) => (pattern.match(/\*/g)?.length ?? 0) > 1 || /[?[\]{}|\\]/.test(pattern),
      )
    )
      throw new Error("Hook matchers support exact names or one * only")
    const share = array(value.share ?? [], "share", 6)
    if (share.some((key) => !["text", "input", "result", "cwd", "reason", "transition"].includes(key)))
      throw new Error("Unsupported hook shared field")
    if (value.once !== undefined && !["never", "turn", "session"].includes(value.once as string))
      throw new Error("Invalid hook once scope")
    const timeoutMs = number(value.timeoutMs, value.async ? 30000 : 10000, 100, 30000)
    if (value.async && events.some((event) => hookIsGate(event as HookEventName) || event === "turn.stop"))
      throw new Error("Async hooks may observe only; gates and stop continuations must be synchronous")
    const transport: Record<string, unknown> = { transport: value.kind === "command" ? "stdio" : "http" }
    for (const key of ["command", "args", "environment", "trustFiles", "url", "bearerEnv", "allowLoopback"])
      if (value[key] !== undefined) transport[key] = value[key]
    // Reuse B's literal argv, safe environment references and destination validation.
    validateMcpConfig({ servers: { [id]: transport } })
    const handler: HookHandlerConfig = {
      kind: value.kind as HookHandlerConfig["kind"],
      enabled: value.enabled === true,
      events: events as HookEventName[],
      matchTools,
      matchSources,
      share: share as HookSharedField[],
      timeoutMs,
      async: value.async === true,
      once: (value.once ?? "never") as HookHandlerConfig["once"],
      writeWorkspace: value.writeWorkspace === true,
      allowInputRewrite: value.allowInputRewrite === true,
      allowTextRewrite: value.allowTextRewrite === true,
      allowResultRewrite: value.allowResultRewrite === true,
      allowDefaultApproval: value.allowDefaultApproval === true,
      allowContinuation: value.allowContinuation === true,
    }
    if (
      handler.async &&
      [
        handler.allowInputRewrite,
        handler.allowTextRewrite,
        handler.allowResultRewrite,
        handler.allowDefaultApproval,
        handler.allowContinuation,
      ].some(Boolean)
    )
      throw new Error("Async hooks cannot change decisions or model context")
    if (handler.allowInputRewrite && !handler.events.includes("tool.before"))
      throw new Error("Input rewrite requires tool.before")
    if (handler.allowTextRewrite && !handler.events.includes("input.admit"))
      throw new Error("Text rewrite requires input.admit")
    if (
      handler.allowResultRewrite &&
      !handler.events.some((event) => ["tool.after", "tool.error"].includes(event))
    )
      throw new Error("Result rewrite requires a post-tool event")
    if (handler.allowDefaultApproval && !handler.events.includes("permission.request"))
      throw new Error("Default approval requires permission.request")
    if (handler.allowContinuation && !handler.events.includes("turn.stop"))
      throw new Error("Continuation requires turn.stop")
    for (const [key, entry] of Object.entries(transport))
      if (key !== "transport") Object.assign(handler, { [key]: entry })
    handlers[id] = handler
  }
  const continuation = raw.continuation ?? {}
  if (
    !isTable(continuation) ||
    Object.keys(continuation).some((key) => !["maxCount", "maxDurationMs", "maxTokens"].includes(key))
  )
    throw new Error("Invalid hook continuation limits")
  return {
    handlers,
    continuation: {
      maxCount: number(continuation.maxCount, 8, 0, 8),
      maxDurationMs: number(continuation.maxDurationMs, 120000, 100, 120000),
      maxTokens: number(continuation.maxTokens, 32768, 0, 262144),
    },
  }
}
