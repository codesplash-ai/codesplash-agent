import { HOOK_EVENTS, type HookEvent, type HookEventName } from "../../../core/hooks.ts"
import type { SessionStateAccess } from "../../../core/session/control.ts"
import { digest } from "../../../core/session/files.ts"
import { boundedJson, jsonObject } from "../mcp/bounds.ts"
import type { HookHandlerConfig } from "./config.ts"
import type { HookReview } from "./trust.ts"

export type HookReceipt = {
  key: string
  id: string
  handler: string
  event: HookEventName
  fingerprint: string
  generation: string
  scope: HookHandlerConfig["once"]
  turnId?: string
  status: "pending" | "completed" | "denied" | "uncertain" | "acknowledged"
  created: number
}
const VALUE = "hooks.v1"
/** Intent precedes effects; the current M5 state retains receipt keys without payloads. */
export class HookReceipts {
  constructor(readonly state: SessionStateAccess) {}
  #decode(value: unknown): HookReceipt[] {
    if (value === undefined) return []
    boundedJson(value, 128 * 1024, 5000)
    if (
      !Array.isArray(value) ||
      value.length > 256 ||
      value.some(
        (entry) =>
          !jsonObject(entry) ||
          typeof entry.key !== "string" ||
          !/^[a-f0-9]{64}$/.test(entry.key) ||
          typeof entry.id !== "string" ||
          typeof entry.handler !== "string" ||
          !HOOK_EVENTS.includes(entry.event as HookEventName) ||
          typeof entry.fingerprint !== "string" ||
          !/^[a-f0-9]{64}$/.test(entry.fingerprint) ||
          typeof entry.generation !== "string" ||
          !["never", "turn", "session"].includes(entry.scope as string) ||
          !["pending", "completed", "denied", "uncertain", "acknowledged"].includes(entry.status as string) ||
          typeof entry.created !== "number" ||
          !Number.isFinite(entry.created),
      )
    )
      throw new Error("Invalid hook execution receipts; inspect session recovery state")
    if (new Set(value.map((entry) => entry.key)).size !== value.length)
      throw new Error("Duplicate hook receipt keys")
    return structuredClone(value) as HookReceipt[]
  }
  list(): HookReceipt[] {
    return this.#decode(this.state.read().state.values[VALUE])
  }
  begin(review: HookReview, event: HookEvent, generation: string): HookReceipt | undefined {
    const scope = review.config.once
    if (scope === "turn" && !event.turnId) throw new Error("Turn-scoped hook has no active turn")
    const key = digest(
      JSON.stringify([
        event.sessionId,
        review.fingerprint,
        event.name,
        scope === "session" ? "session" : scope === "turn" ? event.turnId : event.id,
      ]),
    )
    const before = this.state.read(),
      receipts = this.#decode(before.state.values[VALUE])
    const prior = receipts.find((receipt) => receipt.key === key)
    if (prior) {
      if (prior.status === "denied")
        throw new Error("Hook previously denied this once scope; disable or review the handler to proceed")
      if (prior.status === "pending" || prior.status === "uncertain")
        throw new Error("Hook execution is uncertain; inspect and acknowledge its receipt before continuing")
      return undefined
    }
    const retained = receipts
      .filter(
        (receipt) =>
          receipt.status === "pending" ||
          receipt.status === "uncertain" ||
          receipt.scope === "session" ||
          (receipt.scope === "turn" && receipt.turnId === event.turnId),
      )
      .slice()
    const receipt: HookReceipt = {
      key,
      id: event.operationId ?? event.id,
      handler: review.id,
      event: event.name,
      fingerprint: review.fingerprint,
      generation,
      scope,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      status: "pending",
      created: Date.now(),
    }
    retained.push(receipt)
    if (retained.length > 256)
      throw new Error("Hook receipt capacity reached; resolve uncertain receipts before proceeding")
    boundedJson(retained, 128 * 1024, 5000)
    this.state.update(before.revision, "hooks/intent", (state) => {
      state.values[VALUE] = retained
    })
    return receipt
  }
  settle(key: string, status: "completed" | "denied" | "uncertain"): void {
    const before = this.state.read(),
      receipts = this.#decode(before.state.values[VALUE])
    const receipt = receipts.find((entry) => entry.key === key)
    if (!receipt || receipt.status !== "pending") throw new Error("Hook receipt changed before completion")
    receipt.status = status
    this.state.update(before.revision, "hooks/settle", (state) => {
      state.values[VALUE] = receipts
    })
  }
  acknowledge(key: string): void {
    const before = this.state.read(),
      receipts = this.#decode(before.state.values[VALUE])
    const receipt = receipts.find((entry) => entry.key === key)
    if (!receipt || !["pending", "uncertain"].includes(receipt.status))
      throw new Error("No uncertain hook receipt has that key")
    receipt.status = "acknowledged"
    this.state.update(before.revision, "hooks/acknowledge", (state) => {
      state.values[VALUE] = receipts
    })
  }
}
