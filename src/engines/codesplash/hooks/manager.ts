import { stableValue } from "../../../core/config/source.ts"
import type { AgentConfig, PermissionMode } from "../../../core/config.ts"
import {
  type HookActivity,
  type HookEvent,
  type HookFields,
  type HookResult,
  hookIsGate,
  hookMatches,
} from "../../../core/hooks.ts"
import { redactSensitiveText } from "../../../core/redaction.ts"
import type { SessionStateAccess } from "../../../core/session/control.ts"
import { boundedJson } from "../mcp/bounds.ts"
import type { SandboxRuntime } from "../sandbox/contracts.ts"
import { SENSITIVE_NAME, SecretSanitizer } from "../sandbox/env-policy.ts"
import type { ToolOutputStore } from "../tool-output-store.ts"
import { HookReceipts } from "./receipts.ts"
import { validateHookResult } from "./results.ts"
import { runHookHandler } from "./runner.ts"
import { type HookReview, hookTrusted, reviewHook } from "./trust.ts"

export type HookDispatch = {
  fields: HookFields
  decision?: HookResult["decision"]
  reason?: string
  context: string[]
  instructions: string[]
  continuations: Array<{ handler: string; text: string }>
}
type Invocation = { abort: AbortController; work: Promise<unknown>; async: boolean }
const boundary = (config: AgentConfig) =>
  stableValue([
    config.hooks ?? null,
    config.codex.sandbox,
    config.sandbox ?? null,
    config.permissions,
    config.resolution?.constraints ?? null,
  ])

/** A session owns all handler work. Construction never executes, reviews or creates state. */
export class HookManager {
  readonly receipts: HookReceipts
  readonly #work = new Set<Invocation>()
  readonly #dispatches = new Set<Promise<unknown>>()
  readonly #credentials = new Set<string>()
  readonly #disabled = new Set<string>()
  #config: AgentConfig
  #abort = new AbortController()
  #generation = crypto.randomUUID()
  #closed = false
  #transition = false
  #preparing = false
  constructor(
    readonly options: {
      cwd: string
      dataDir: string
      config: AgentConfig
      resolveConfig: () => Promise<AgentConfig>
      mode: () => PermissionMode
      sandbox: SandboxRuntime
      state: SessionStateAccess
      outputs: ToolOutputStore
      env?: NodeJS.ProcessEnv
      activity?: (activity: HookActivity) => void
      diagnostic?: (text: string) => void
    },
  ) {
    this.#config = structuredClone(options.config)
    this.receipts = new HookReceipts(options.state)
  }
  get generation(): string {
    return this.#generation
  }
  get continuationLimits() {
    return this.#config.hooks?.continuation ?? { maxCount: 0, maxDurationMs: 120000, maxTokens: 0 }
  }
  disabled(id: string): boolean {
    return this.#disabled.has(id)
  }
  get enabled(): boolean {
    return Object.entries(this.#config.hooks?.handlers ?? {}).some(
      ([id, handler]) => handler.enabled && !this.#disabled.has(id),
    )
  }
  async suspend(): Promise<void> {
    if (this.#closed || this.#transition) throw new Error("Hook owner is unavailable")
    this.#transition = true
    try {
      this.#abort.abort()
      await Promise.allSettled([...this.#dispatches, ...[...this.#work].map((entry) => entry.work)])
      if (this.#closed) return
      this.#generation = crypto.randomUUID()
      this.#abort = new AbortController()
    } finally {
      this.#transition = false
    }
  }
  async disable(id: string): Promise<void> {
    if (this.#closed || this.#transition) throw new Error("Hook owner is unavailable")
    if (!this.#config.hooks?.handlers[id]) throw new Error("Unknown hook handler")
    this.#transition = true
    try {
      this.#abort.abort()
      await Promise.allSettled([...this.#dispatches, ...[...this.#work].map((entry) => entry.work)])
      if (this.#closed) return
      this.#disabled.add(id)
      this.#generation = crypto.randomUUID()
      this.#abort = new AbortController()
    } finally {
      this.#transition = false
    }
  }
  /** Recheck source eligibility after approvals without repeating handler effects. */
  async revalidate(event: HookEvent, callerSignal: AbortSignal): Promise<void> {
    if (this.#closed || this.#transition) throw new Error("Hook owner is unavailable")
    const signal = AbortSignal.any([callerSignal, this.#abort.signal, AbortSignal.timeout(30000)])
    const config = await this.options.resolveConfig()
    signal.throwIfAborted()
    if (boundary(config) !== boundary(this.#config))
      throw new Error("Hook configuration or policy changed; reload at idle before continuing")
    for (const [id, handler] of Object.entries(this.#config.hooks?.handlers ?? {})) {
      if (
        this.#disabled.has(id) ||
        !handler.enabled ||
        !handler.events.includes(event.name) ||
        (handler.matchTools.length &&
          !handler.matchTools.some((pattern) => hookMatches(pattern, event.metadata.toolName ?? ""))) ||
        (handler.matchSources.length &&
          !handler.matchSources.some((pattern) => hookMatches(pattern, event.metadata.toolSource ?? "")))
      )
        continue
      await this.#review(id, event, signal)
    }
  }
  #sanitize(text: string): string {
    const clean = redactSensitiveText(
      new SecretSanitizer([...this.#credentials]).redact(text),
      this.options.env ?? process.env,
    )
    return this.options.sandbox.sanitize?.(clean) ?? clean
  }
  #clean(value: unknown): unknown {
    if (typeof value === "string") return this.#sanitize(value)
    if (Array.isArray(value)) return value.map((entry) => this.#clean(entry))
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          this.#sanitize(key),
          SENSITIVE_NAME.test(key) ? "[REDACTED]" : this.#clean(entry),
        ]),
      )
    return value
  }
  #diagnostic(text: string): void {
    try {
      this.options.diagnostic?.(this.#sanitize(text).slice(0, 2048))
    } catch {
      /* presentation never owns execution */
    }
  }
  #activity(review: HookReview, event: HookEvent, state: HookActivity["state"], detail?: string): void {
    try {
      this.options.activity?.({
        handler: review.id,
        source: review.source,
        fingerprint: review.fingerprint,
        generation: event.generation,
        event: event.name,
        operationId: event.operationId ?? event.id,
        state,
        ...(detail ? { detail: this.#sanitize(detail).slice(0, 2048) } : {}),
      })
    } catch {
      /* presentation never owns execution */
    }
  }
  async #review(id: string, event: HookEvent, signal: AbortSignal): Promise<HookReview> {
    signal.throwIfAborted()
    const config = await this.options.resolveConfig()
    signal.throwIfAborted()
    if (boundary(config) !== boundary(this.#config))
      throw new Error("Hook configuration or policy changed; reload at idle or start a new session")
    const handler = config.hooks?.handlers[id],
      constraints = config.resolution?.constraints
    if (
      !handler?.enabled ||
      (constraints?.hookHandlers && !constraints.hookHandlers.includes(id)) ||
      (constraints?.hookEvents && !constraints.hookEvents.includes(event.name))
    )
      throw new Error("Hook is disabled or denied by managed policy")
    if (handler.allowLoopback && constraints?.allowedHosts !== undefined)
      throw new Error("Managed public-host policy does not permit hook loopback exceptions")
    const review = await reviewHook(config, id, this.options.cwd, signal)
    if (constraints?.hooksManagedOnly && !review.managed)
      throw new Error("Only managed hook sources may execute")
    if (!hookTrusted(this.options.dataDir, review))
      throw new Error("Hook source requires explicit fingerprint trust")
    signal.throwIfAborted()
    return review
  }
  /** Reload publication follows cancellation and settlement; new grants require a new native session. */
  async reload(beforePublish?: () => Promise<void>): Promise<void> {
    if (this.#closed || this.#transition) throw new Error("Hook owner is closed or already changing")
    this.#transition = true
    const previous = this.#config
    const disabled = [...this.#disabled]
    let staged = false
    try {
      const config = await this.options.resolveConfig()
      const policy = (value: AgentConfig) =>
        stableValue([value.codex.sandbox, value.sandbox ?? null, value.resolution?.constraints ?? null])
      if (policy(config) !== policy(this.#config))
        throw new Error("Hook sandbox policy changed; start a new session")
      // Validate every enabled source before retiring the previous generation.
      for (const id of Object.keys(config.hooks?.handlers ?? {})) {
        if (!config.hooks?.handlers[id]?.enabled) continue
        const review = await reviewHook(config, id, this.options.cwd, this.#abort.signal)
        if (!hookTrusted(this.options.dataDir, review))
          throw new Error(`Hook ${id} requires fingerprint trust`)
      }
      this.#abort.abort()
      await Promise.allSettled([...this.#dispatches, ...[...this.#work].map((entry) => entry.work)])
      if (this.#closed) throw new Error("Hook owner closed during reload")
      this.#config = structuredClone(config)
      this.#generation = crypto.randomUUID()
      this.#abort = new AbortController()
      staged = true
      this.#disabled.clear()
      this.#preparing = true
      await beforePublish?.()
      this.#preparing = false
      this.#disabled.clear()
    } catch (error) {
      if (staged) {
        this.#abort.abort()
        await Promise.allSettled([...this.#dispatches, ...[...this.#work].map((entry) => entry.work)])
        this.#config = previous
        this.#disabled.clear()
        for (const id of disabled) this.#disabled.add(id)
        this.#generation = crypto.randomUUID()
        this.#abort = new AbortController()
      }
      throw error
    } finally {
      this.#preparing = false
      this.#transition = false
    }
  }
  async close(): Promise<void> {
    this.#closed = true
    this.#abort.abort()
    await Promise.allSettled([...this.#dispatches, ...[...this.#work].map((entry) => entry.work)])
  }
  dispatch(
    event: HookEvent,
    signal: AbortSignal,
    validateInput?: (input: Record<string, unknown>) => void | Promise<void>,
  ): Promise<HookDispatch> {
    if (this.#dispatches.size >= 16) return Promise.reject(new Error("Hook event limit reached"))
    const work = this.#dispatch(event, signal, validateInput)
    this.#dispatches.add(work)
    void work.finally(() => this.#dispatches.delete(work)).catch(() => {})
    return work
  }
  async #dispatch(
    event: HookEvent,
    callerSignal: AbortSignal,
    validateInput?: (input: Record<string, unknown>) => void | Promise<void>,
  ): Promise<HookDispatch> {
    if (this.#closed || (this.#transition && !(this.#preparing && event.name === "config.before")))
      throw new Error("Hook owner is unavailable")
    const signal = AbortSignal.any([callerSignal, this.#abort.signal, AbortSignal.timeout(30000)])
    const current = structuredClone(event)
    current.generation = this.#generation
    const result: HookDispatch = { fields: current.fields, context: [], instructions: [], continuations: [] }
    // Hidden tool work has only its explicit enclosing resource/transition hook surface.
    if (current.metadata.hidden && current.name.startsWith("tool.")) return result
    const config = await this.options.resolveConfig()
    signal.throwIfAborted()
    if (
      !this.enabled &&
      !Object.entries(config.hooks?.handlers ?? {}).some(
        ([id, handler]) => handler.enabled && !this.#disabled.has(id),
      )
    )
      return result
    if (boundary(config) !== boundary(this.#config)) {
      const message = "Hook configuration or policy changed; reload at idle before continuing"
      if (hookIsGate(current.name)) throw new Error(message)
      this.#diagnostic(message)
      return result
    }
    let contextBytes = 0
    for (const [id, handler] of Object.entries(this.#config.hooks?.handlers ?? {})) {
      if (
        this.#disabled.has(id) ||
        !handler.enabled ||
        !handler.events.includes(current.name) ||
        (handler.matchTools.length &&
          !handler.matchTools.some((pattern) => hookMatches(pattern, current.metadata.toolName ?? ""))) ||
        (handler.matchSources.length &&
          !handler.matchSources.some((pattern) => hookMatches(pattern, current.metadata.toolSource ?? "")))
      )
        continue
      signal.throwIfAborted()
      const apply = async (output: HookResult) => {
        if (output.input !== undefined) {
          if (!validateInput) throw new Error("This dispatch cannot validate hook input rewrites")
          await validateInput(output.input)
          signal.throwIfAborted()
        }
        const retained: Array<{ key: "context" | "instructions" | "continuation"; text: string }> = []
        for (const key of ["context", "instructions", "continuation"] as const) {
          const value = output[key]
          if (!value) continue
          contextBytes += Buffer.byteLength(value)
          if (contextBytes > 1024 * 1024) throw new Error("Hook context exceeds 1 MiB per event")
          const text = await this.options.outputs.retain(`[Hook ${id} / ${current.name}]\n${value}`)
          signal.throwIfAborted()
          retained.push({ key, text })
        }
        return () => {
          if (output.input !== undefined) current.fields.input = output.input
          if (output.text !== undefined) current.fields.text = output.text
          if (output.result !== undefined) current.fields.result = output.result
          if (output.decision === "ask" || (output.decision === "allow" && result.decision !== "ask"))
            result.decision = output.decision
          if (output.reason) result.reason = output.reason
          for (const { key, text } of retained) {
            if (key === "continuation") result.continuations.push({ handler: id, text })
            else result[key].push(text)
          }
        }
      }
      if (
        this.#work.size >= 16 ||
        (handler.async && [...this.#work].filter((entry) => entry.async).length >= 4)
      ) {
        const message = `Hook ${id}: owned handler limit reached`
        if (hookIsGate(current.name)) throw new Error(message)
        this.#diagnostic(message)
        continue
      }
      const abort = new AbortController()
      const invocation = { abort, async: handler.async, work: Promise.resolve() as Promise<unknown> }
      this.#work.add(invocation)
      invocation.work = this.#invoke(
        id,
        structuredClone(current),
        AbortSignal.any([signal, abort.signal, AbortSignal.timeout(handler.timeoutMs)]),
        handler.async ? undefined : apply,
      ).finally(() => this.#work.delete(invocation))
      if (handler.async)
        void invocation.work.catch((error) =>
          this.#diagnostic(`Hook ${id}: ${error instanceof Error ? error.message : "failed"}`),
        )
      else {
        try {
          await invocation.work
        } catch (error) {
          signal.throwIfAborted()
          const message = this.#sanitize(
            `Hook ${id}: ${error instanceof Error ? error.message : "failed"}`,
          ).slice(0, 2048)
          if (hookIsGate(current.name)) throw new Error(message)
          this.#diagnostic(message)
        }
      }
    }
    return result
  }
  async #invoke(
    id: string,
    event: HookEvent,
    signal: AbortSignal,
    apply?: (output: HookResult) => Promise<() => void>,
  ): Promise<void> {
    const review = await this.#review(id, event, signal)
    const mode = this.options.mode()
    let bearer: string | undefined
    if (review.config.bearerEnv) {
      bearer = (this.options.env ?? process.env)[review.config.bearerEnv]
      if (
        !bearer ||
        bearer.length > 16384 ||
        Array.from(bearer).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
      )
        throw new Error("Hook bearer credential is unavailable or invalid")
      if (!this.#credentials.has(bearer) && this.#credentials.size >= 512)
        throw new Error("Hook credential retention limit reached; start a new session")
      this.#credentials.add(bearer)
    }
    const fields = Object.fromEntries(
      review.config.share
        .filter((key) => event.fields[key] !== undefined)
        .map((key) => [key, event.fields[key]]),
    )
    boundedJson(fields, 128 * 1024, 5000)
    const input = boundedJson(
      {
        ...event,
        metadata: this.#clean(event.metadata),
        fields: this.#clean(fields),
        handler: { id, source: review.source, fingerprint: review.fingerprint },
      },
      128 * 1024,
      5000,
    )
    signal.throwIfAborted()
    const receipt = this.receipts.begin(review, event, event.generation)
    if (!receipt) {
      this.#activity(review, event, "skipped")
      return
    }
    this.#activity(review, event, "running")
    let settled = false
    try {
      const raw = await runHookHandler({
        review,
        event: event.name,
        input,
        sandbox: this.options.sandbox,
        mode,
        signal,
        ...(bearer ? { bearer } : {}),
      })
      boundedJson(raw, 128 * 1024, 5000)
      const output = validateHookResult(event.name, this.#clean(raw), review.config)
      const after = await this.#review(id, event, signal)
      if (
        after.fingerprint !== review.fingerprint ||
        this.options.mode() !== mode ||
        event.generation !== this.#generation
      )
        throw new Error("Hook source or runtime changed during execution")
      signal.throwIfAborted()
      if (output.decision === "deny") {
        this.receipts.settle(receipt.key, "denied")
        settled = true
        throw new Error(output.reason || "Handler denied this operation")
      }
      const commit = await apply?.(output)
      const final = await this.#review(id, event, signal)
      if (
        final.fingerprint !== review.fingerprint ||
        this.options.mode() !== mode ||
        event.generation !== this.#generation
      )
        throw new Error("Hook source or runtime changed before result publication")
      signal.throwIfAborted()
      this.receipts.settle(receipt.key, "completed")
      settled = true
      commit?.()
      this.#activity(review, event, "completed")
      if (output.diagnostic) this.#diagnostic(`Hook ${id}: ${output.diagnostic}`)
    } catch (error) {
      if (!settled) this.receipts.settle(receipt.key, "uncertain")
      this.#activity(review, event, settled ? "failed" : "uncertain")
      throw error
    }
  }
}
