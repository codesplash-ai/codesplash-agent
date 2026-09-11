import { type HookEventName, type HookResult, hookIsGate } from "../../../core/hooks.ts"
import { boundedJson, jsonObject } from "../mcp/bounds.ts"
import type { HookHandlerConfig } from "./config.ts"

const contextEvents = new Set<HookEventName>([
  "session.start",
  "session.resume",
  "input.admit",
  "turn.start",
  "tool.before",
  "tool.after",
  "tool.error",
  "compaction.before",
  "compaction.after",
  "compaction.error",
  "resource.before",
  "resource.after",
])
/** Parse event-specific changes before they can influence any permission or model request. */
export function validateHookResult(
  name: HookEventName,
  value: unknown,
  handler: HookHandlerConfig,
): HookResult {
  boundedJson(value, 128 * 1024, 5000)
  if (!jsonObject(value) || value.version !== 1) throw new Error("Hook output must be a version 1 object")
  const known = [
    "version",
    "decision",
    "reason",
    "input",
    "text",
    "context",
    "result",
    "instructions",
    "continuation",
    "diagnostic",
  ]
  if (Object.keys(value).some((key) => !known.includes(key))) throw new Error("Unknown hook result field")
  for (const field of ["reason", "text", "context", "result", "instructions", "continuation", "diagnostic"])
    if (
      value[field] !== undefined &&
      (typeof value[field] !== "string" ||
        (value[field] as string).length > (field === "diagnostic" ? 2048 : 128 * 1024))
    )
      throw new Error("Invalid or oversized hook text")
  if (handler.async && Object.keys(value).some((key) => !["version", "diagnostic"].includes(key)))
    throw new Error("Async hook output cannot change runtime decisions")
  if (value.decision !== undefined) {
    if (!hookIsGate(name) || !["deny", "ask", "allow"].includes(value.decision as string))
      throw new Error("This event cannot return that decision")
    if (value.decision === "allow" && (name !== "permission.request" || !handler.allowDefaultApproval))
      throw new Error("Hook cannot allow default approvals without explicit review")
    if (value.decision === "ask" && !["tool.before", "permission.request"].includes(name))
      throw new Error("Only tool gates can request approval")
  }
  if (
    value.input !== undefined &&
    (name !== "tool.before" || !handler.allowInputRewrite || !jsonObject(value.input))
  )
    throw new Error("Hook input rewrite is not permitted")
  if (value.text !== undefined && (name !== "input.admit" || !handler.allowTextRewrite))
    throw new Error("Hook text rewrite is not permitted")
  if (
    value.result !== undefined &&
    (!["tool.after", "tool.error"].includes(name) || !handler.allowResultRewrite)
  )
    throw new Error("Hook result rewrite is not permitted")
  if (value.context !== undefined && !contextEvents.has(name))
    throw new Error("This event cannot add context")
  if (value.instructions !== undefined && name !== "compaction.before")
    throw new Error("Only compaction.before can add summary instructions")
  if (
    value.continuation !== undefined &&
    (name !== "turn.stop" || !handler.allowContinuation || !(value.continuation as string).trim())
  )
    throw new Error("Hook continuation is not permitted")
  if (
    value.decision === "deny" &&
    ["input", "text", "result", "continuation"].some((key) => value[key] !== undefined)
  )
    throw new Error("A denied hook result cannot also rewrite an operation")
  return value as HookResult
}
