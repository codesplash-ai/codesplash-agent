import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { stableValue } from "../../../core/config/source.ts"
import type { AgentConfig } from "../../../core/config.ts"
import { type FormResponse, type InteractionForm, validateFormValues } from "../../../core/forms.ts"
import { HOOK_EVENTS, type HookEvent, type HookEventName } from "../../../core/hooks.ts"
import { redactSensitiveText } from "../../../core/redaction.ts"
import { digest } from "../../../core/session/files.ts"
import {
  type HarnessTool,
  type ModelInfo,
  type ProviderRuntime,
  type ProviderStreamEvent,
  ToolInputError,
} from "../contracts.ts"
import { boundedJson } from "../mcp/bounds.ts"
import { BoundedSchemaValidators, boundedSchema } from "../mcp/schema.ts"
import type { ToolRegistry } from "../tools/registry.ts"
import type {
  ExtensionApi,
  ExtensionCommand,
  ExtensionFactory,
  ExtensionProvider,
  ExtensionTool,
  ExtensionUiUpdate,
  HostExtension,
} from "./api.ts"
import { EXTENSION_ID, validateExtensions } from "./config.ts"
import { snapshotExtension } from "./loader.ts"
import { type ExtensionReview, extensionTrusted, reviewExtension } from "./trust.ts"
import { validateExtensionForm, validateExtensionSchema, validateExtensionTargets } from "./validation.ts"

export type ExtensionHost = {
  interactive(): boolean
  ui(update: ExtensionUiUpdate): boolean
  dialog(form: InteractionForm, signal: AbortSignal): Promise<FormResponse>
  complete(model: string, prompt: string, signal: AbortSignal): Promise<string>
  diagnostic(message: string): void
}
type Timer = {
  milliseconds: number
  callback: (signal: AbortSignal) => void | Promise<void>
  handle?: ReturnType<typeof setTimeout>
}
type Owner = {
  host?: HostExtension
  hostPolicy?: string
  review: ExtensionReview
  generation: string
  state: "staging" | "active" | "closed" | "quarantined"
  abort: AbortController
  tools: ExtensionTool[]
  providers: ExtensionProvider[]
  commands: ExtensionCommand[]
  flags: Set<string>
  events: Map<HookEventName, Array<(event: HookEvent, signal: AbortSignal) => void | Promise<void>>>
  timers: Set<Timer>
  pending: Set<Promise<unknown>>
  streams: Map<AsyncIterator<ProviderStreamEvent>, Promise<void> | undefined>
  cleanup?: () => void | Promise<void>
  snapshot?: Awaited<ReturnType<typeof snapshotExtension>>
  ui: Map<string, ExtensionUiUpdate>
}
const validName = (name: unknown): name is string => typeof name === "string" && EXTENSION_ID.test(name)
const protectedNames = new Set([
  "ask_user",
  "enter_plan_mode",
  "exit_plan_mode",
  "request_permissions",
  "read_tool_output",
  "skill",
  "todo_write",
])

import { extensionToolId } from "./identifiers.ts"

export { extensionToolId } from "./identifiers.ts"

/** Session-owned trusted code. Revocation fences APIs; it cannot stop direct arbitrary JS effects. */
export class ExtensionRuntime {
  readonly generation = randomUUID()
  readonly #owners: Owner[] = []
  readonly #secrets = new Set<string>()
  readonly #scope = new AsyncLocalStorage<AbortSignal>()
  #host?: ExtensionHost
  #closed = false
  #workAbort = new AbortController()
  #eventTail: Promise<void> = Promise.resolve()
  #eventCount = 0
  constructor(
    readonly options: {
      config: AgentConfig
      cwd: string
      dataDir: string
      disabled?: boolean
      hostExtensions?: readonly HostExtension[]
      resolveConfig?: () => Promise<AgentConfig>
      sanitize?: (value: string) => string
    },
  ) {}

  get enabled(): boolean {
    return this.#owners.some((owner) => owner.state === "active")
  }
  sanitize(value: string): string {
    for (const secret of this.#secrets) value = value.replaceAll(secret, "[REDACTED]")
    return redactSensitiveText(this.options.sanitize?.(value) ?? value)
  }
  #sanitizeValue(value: unknown): unknown {
    if (typeof value === "string") return this.sanitize(value)
    if (Array.isArray(value)) return value.map((item) => this.#sanitizeValue(item))
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          /^(?:password|secret|token|authorization|credential|api[_-]?key)$/i.test(key)
            ? "[REDACTED]"
            : this.#sanitizeValue(item),
        ]),
      )
    return value
  }
  async stage(signal = AbortSignal.timeout(30000)): Promise<void> {
    if (this.#closed || this.#owners.length) throw new Error("Extension runtime cannot be staged twice")
    if (this.options.disabled || this.options.config.extensions?.disabled) return
    try {
      const entries = Object.entries(this.options.config.extensions?.entries ?? {})
      const hosts = this.options.hostExtensions ?? []
      if (entries.length + hosts.length > 32) throw new Error("At most 32 extension owners are supported")
      const ids = new Set(entries.map(([id]) => id))
      for (const host of hosts) {
        if (ids.has(host.id) || typeof host.factory !== "function")
          throw new Error("Invalid or duplicate host extension")
        ids.add(host.id)
        const validated = validateExtensions({
          entries: {
            [host.id]: {
              root: this.options.cwd,
              entry: "host.js",
              enabled: true,
              flags: host.flags ?? {},
              overrides: host.overrides ?? [],
            },
          },
        })
        entries.push([host.id, validated.entries[host.id]!])
      }
      for (const [id, entry] of entries) {
        if (!entry.enabled) continue
        const host = hosts.find((candidate) => candidate.id === id)
        signal.throwIfAborted()
        const ceiling = this.options.config.resolution?.constraints?.extensionIds
        if (ceiling && !ceiling.includes(id))
          throw new Error(`Extension ${id} is prohibited by managed policy`)
        const config = this.options.config
        const review: ExtensionReview = host
          ? {
              id,
              cwd: this.options.cwd,
              root: this.options.cwd,
              config: entry,
              sources: [],
              files: [],
              policy: {
                permissions: config.permissions,
                sandbox: config.codex.sandbox,
                sandboxConfig: config.sandbox ?? {},
                constraints: config.resolution?.constraints ?? {},
              },
              fingerprint: digest(`host:${this.generation}:${id}`),
              source: `host-extension:${id}`,
            }
          : await reviewExtension(config, id, this.options.cwd, signal)
        if (!host && !extensionTrusted(this.options.dataDir, review))
          throw new Error(`Extension ${id} requires explicit fingerprint trust`)
        const owner: Owner = {
          review,
          host,
          hostPolicy: host ? stableValue(review.policy) : undefined,
          generation: randomUUID(),
          state: "staging",
          abort: new AbortController(),
          tools: [],
          providers: [],
          commands: [],
          flags: new Set(),
          events: new Map(),
          timers: new Set(),
          pending: new Set(),
          streams: new Map(),
          ui: new Map(),
        }
        this.#owners.push(owner)
        if (!host) owner.snapshot = await snapshotExtension(review, signal)
        await this.#invoke(
          owner,
          signal,
          async () => {
            const module = await owner.snapshot?.load()
            const factory = host?.factory ?? module?.default
            if (typeof factory !== "function") throw new Error("Extension must export a default factory")
            const cleanup = await (factory as ExtensionFactory)(this.#api(owner))
            if (cleanup !== undefined && typeof cleanup !== "function")
              throw new Error("Extension factory must return a cleanup function or nothing")
            owner.cleanup = typeof cleanup === "function" ? cleanup : undefined
          },
          true,
        )
        if (Object.keys(review.config.flags).some((name) => !owner.flags.has(name)))
          throw new Error(`Unknown configured extension flag for ${id}`)
        await this.#reviewCurrent(owner, signal)
      }
    } catch (error) {
      await this.close()
      throw new Error(this.sanitize(error instanceof Error ? error.message : "Extension staging failed"))
    }
  }
  async revalidate(signal: AbortSignal): Promise<void> {
    for (const owner of this.#owners) await this.#reviewCurrent(owner, signal)
  }
  activate(host: ExtensionHost): void {
    if (this.#closed) throw new Error("Extension runtime closed")
    if (this.#owners.some((owner) => owner.state !== "staging"))
      throw new Error("Extension already activated")
    this.#host = host
    for (const owner of this.#owners) {
      owner.state = "active"
      for (const timer of owner.timers) this.#startTimer(owner, timer)
      for (const update of owner.ui.values()) {
        try {
          host.ui(update)
        } catch {
          /* Presentation cannot break registry publication. */
        }
      }
    }
  }
  status() {
    return {
      generation: this.generation,
      entries: this.#owners.map((owner) => ({
        id: owner.review.id,
        generation: owner.generation,
        fingerprint: owner.review.fingerprint,
        state: owner.state,
        tools: owner.tools.map((tool) => ({
          name: tool.name,
          id: tool.override ?? extensionToolId(owner.review.id, tool.name),
          override: tool.override,
        })),
        providers: owner.providers.map((provider) => this.#providerId(owner, provider)),
        commands: owner.commands.map((command) => ({
          name: `${owner.review.id}/${command.name}`,
          description: command.description,
        })),
        flags: [...owner.flags],
      })),
      warning: "Trusted in-process code has harness privileges. Recovery: --no-extensions.",
    }
  }
  registry(base: ToolRegistry): ToolRegistry {
    if (!this.#owners.length) return base
    const byName = new Map<string, HarnessTool>(),
      validators = new BoundedSchemaValidators()
    for (const owner of this.#owners)
      for (const definition of owner.tools) {
        const name = definition.override ?? extensionToolId(owner.review.id, definition.name)
        const original = definition.override ? base.get(name) : undefined
        if (byName.has(name) || (!definition.override && base.get(name)))
          throw new Error(`Extension tool collision: ${name}`)
        if (
          definition.override &&
          (!original ||
            original.hidden ||
            protectedNames.has(name) ||
            name.startsWith("memory_") ||
            name.startsWith("context_") ||
            original.source?.id.startsWith("extension:") ||
            !owner.review.config.overrides.includes(name))
        )
          throw new Error(`Extension override is not permitted: ${name}`)
        // Overrides retain the original schema so its target extraction and policy floors remain meaningful.
        if (original && stableValue(original.inputSchema) !== stableValue(definition.inputSchema))
          throw new Error(`Override ${name} must preserve the original input schema`)
        const validate = validators.getValidator(definition.inputSchema)
        const checked = (input: unknown) => {
          this.#assert(owner)
          const result = validate(input)
          if (!result.valid) throw new ToolInputError("Extension input does not match its schema")
          return input
        }
        const tool: HarnessTool = {
          name,
          description: `[Extension ${owner.review.id}/${definition.name}] ${definition.description}`,
          inputSchema: structuredClone(definition.inputSchema),
          source: { id: `${owner.review.source}/tool/${definition.name}`, generation: owner.generation },
          permissionName: extensionToolId(owner.review.id, definition.name),
          ...(original ? { permissionFloor: original } : {}),
          effects:
            original && definition.effects === "external" && original.effects !== "external"
              ? "workspace-and-external"
              : (definition.effects ?? "workspace-and-external"),
          allowPersistentApproval: false,
          isReadOnly: (input) => {
            checked(input)
            return definition.readOnly === true && (!original || original.isReadOnly(input))
          },
          permissionTargets: (input, context) => {
            checked(input)
            const targets = definition.targets?.(structuredClone(input), context.cwd)
            if (targets) {
              validateExtensionTargets(targets)
              if (targets.paths) targets.paths = targets.paths.map((path) => resolve(context.cwd, path))
            }
            return targets ?? original?.permissionTargets?.(input, context) ?? {}
          },
          permission: (input, context) => {
            checked(input)
            if (
              !tool.isReadOnly(input) &&
              (context.policy.sandbox === "read-only" || context.permissions?.mode === "plan")
            )
              throw new ToolInputError("Extension operation is not read-only under this policy")
            original?.permission(input, context)
            return {
              kind: "approval",
              title: `Run extension ${owner.review.id}/${definition.name}?`,
              detail: `Trusted in-process code; effects may extend beyond workspace checkpoints.\nSource: ${owner.review.fingerprint}\nGeneration: ${owner.generation}`,
              sessionKey: `${name}:${owner.review.fingerprint}:${owner.generation}`,
            }
          },
          run: async (input, context) => {
            checked(input)
            tool.permission(input, context)
            return this.#invoke(
              owner,
              context.signal,
              async (signal) => {
                await this.#reviewCurrent(owner, signal)
                let progressCount = 0
                const outcome = await definition.run(structuredClone(input), {
                  cwd: context.cwd,
                  signal,
                  progress: (text) => {
                    this.#assert(owner)
                    signal.throwIfAborted()
                    if (++progressCount > 256 || typeof text !== "string" || text.length > 16384)
                      throw new Error("Extension progress limit exceeded")
                    context.progress?.(this.sanitize(text))
                  },
                })
                signal.throwIfAborted()
                this.#assert(owner)
                boundedJson(outcome, 4 * 1024 * 1024, 20000)
                if (
                  typeof outcome.text !== "string" ||
                  typeof outcome.label !== "string" ||
                  outcome.planSteps
                )
                  throw new Error("Invalid extension tool outcome")
                return {
                  ...outcome,
                  text: this.sanitize(outcome.text),
                  label: this.sanitize(outcome.label).slice(0, 512),
                }
              },
              false,
              context.holdMutationUntil,
            )
          },
        }
        byName.set(name, tool)
      }
    if (
      byName.size > 128 ||
      boundedJson(
        [...byName.values()].map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
        512 * 1024,
        20000,
      ).length >
        512 * 1024
    )
      throw new Error("Extension tool catalog exceeds the 128-tool / 512 KiB limit")
    const generation = `${base.generation}:${this.generation}`
    return {
      generation,
      specs: () =>
        [
          ...base.specs().filter((spec) => !byName.has(spec.name)),
          ...[...byName.values()]
            .filter((tool) =>
              this.#owners.some(
                (owner) => owner.generation === tool.source?.generation && owner.state === "active",
              ),
            )
            .map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        ].sort((a, b) => a.name.localeCompare(b.name)),
      get: (name, expected) => {
        if (expected !== undefined && expected !== generation)
          throw new Error("Stale extension tool selection")
        return byName.get(name) ?? base.get(name)
      },
      source: (name) => byName.get(name)?.source ?? base.source(name),
    }
  }
  providers(): ProviderRuntime[] {
    return this.#owners.flatMap((owner) =>
      owner.providers.map((provider) => {
        const id = this.#providerId(owner, provider)
        const models: ModelInfo[] = provider.models.map((model) => ({
          ...structuredClone(model),
          id: `${id}/${model.id}`,
          provider: id,
          protocol: provider.protocol,
        }))
        const runtime = this
        return {
          id,
          protocol: provider.protocol,
          displayName: provider.displayName,
          keyEnvVar: "",
          requiresKey: false,
          client: {
            id: provider.protocol,
            models,
            async *stream(request, parentSignal) {
              runtime.#assert(owner)
              const abort = new AbortController(),
                streamWorkSignal = runtime.#workAbort.signal,
                signal = AbortSignal.any([
                  parentSignal,
                  owner.abort.signal,
                  streamWorkSignal,
                  abort.signal,
                  AbortSignal.timeout(120000),
                ])
              let iterator: AsyncIterator<ProviderStreamEvent> | undefined
              try {
                await runtime.#reviewCurrent(owner, signal)
                const credential = provider.auth
                  ? await runtime.#invoke(owner, signal, async () => provider.auth?.(signal))
                  : undefined
                if (credential !== undefined) {
                  if (
                    !credential ||
                    credential.length > 16384 ||
                    Array.from(credential).some((char) => char.charCodeAt(0) < 32) ||
                    (runtime.#secrets.size >= 128 && !runtime.#secrets.has(credential))
                  )
                    throw new Error("Invalid extension provider credential")
                  runtime.#secrets.add(credential)
                }
                iterator = provider
                  .stream(structuredClone(request), { signal, ...(credential ? { credential } : {}) })
                  [Symbol.asyncIterator]()
                owner.streams.set(iterator, undefined)
                let count = 0,
                  bytes = 0
                while (true) {
                  const next = await runtime.#invoke(owner, signal, () => iterator!.next())
                  if (next.done) break
                  const event = next.value
                  bytes += boundedJson(event, 1024 * 1024, 5000).length
                  if (++count > 100000 || bytes > 16 * 1024 * 1024)
                    throw new Error("Extension provider stream limit exceeded")
                  runtime.#validateProviderEvent(event)
                  yield runtime.#sanitizeValue(event) as ProviderStreamEvent
                  if (event.type === "done") return
                }
                throw new Error("Extension provider stream omitted its done event")
              } catch (error) {
                if (!parentSignal.aborted && !owner.abort.signal.aborted && !streamWorkSignal.aborted)
                  runtime.#quarantine(owner)
                throw new Error(
                  runtime.sanitize(error instanceof Error ? error.message : "Extension provider failed"),
                )
              } finally {
                abort.abort()
                if (iterator) void runtime.#retireStream(owner, iterator)
              }
            },
          },
        } satisfies ProviderRuntime
      }),
    )
  }
  async observe(event: HookEvent, signal: AbortSignal): Promise<void> {
    if (!this.enabled) return
    if (++this.#eventCount > 64) {
      this.#eventCount--
      throw new Error("Extension lifecycle queue limit exceeded")
    }
    const operation = this.#eventTail.then(async () => {
      for (const owner of this.#owners) {
        if (owner.state !== "active") continue
        for (const callback of owner.events.get(event.name) ?? []) {
          try {
            await this.#invoke(owner, signal, async (ownedSignal) => {
              await this.#reviewCurrent(owner, ownedSignal)
              const serialized = boundedJson(event, 128 * 1024, 5000)
              const safe = this.#sanitizeValue(JSON.parse(serialized)) as HookEvent
              await callback(safe, ownedSignal)
            })
          } catch {
            break
          }
        }
      }
    })
    this.#eventTail = operation.catch(() => {})
    try {
      await operation
    } finally {
      this.#eventCount--
    }
  }
  async command(selector: string, argument: string, signal: AbortSignal): Promise<string> {
    const { owner, command } = this.#command(selector)
    if (argument.length > 16384) throw new Error("Extension command argument too large")
    return this.#invoke(owner, signal, async (signal) => {
      await this.#reviewCurrent(owner, signal)
      const result = await command.run(argument, { signal })
      if (result !== undefined && (typeof result !== "string" || result.length > 65536))
        throw new Error("Extension command output too large")
      return this.sanitize(result ?? "")
    })
  }
  async completeCommand(selector: string, argument: string, signal: AbortSignal): Promise<string[]> {
    const { owner, command } = this.#command(selector)
    if (argument.length > 4096) return []
    return this.#invoke(owner, signal, async (signal) => {
      await this.#reviewCurrent(owner, signal)
      const values = (await command.complete?.(argument, signal)) ?? []
      if (
        !Array.isArray(values) ||
        values.length > 64 ||
        values.some((value) => typeof value !== "string" || value.length > 1024)
      )
        throw new Error("Invalid extension completions")
      return values.map((value) => this.sanitize(value))
    })
  }
  suspend(): void {
    this.#workAbort.abort(new Error("Extension work suspended by a session transition"))
    this.#workAbort = new AbortController()
    for (const owner of this.#owners) {
      for (const timer of owner.timers) if (timer.handle) clearTimeout(timer.handle)
      owner.timers.clear()
      for (const iterator of owner.streams.keys()) void this.#retireStream(owner, iterator)
    }
  }
  async disable(id: string): Promise<void> {
    const owner = this.#owners.find((owner) => owner.review.id === id)
    if (!owner) throw new Error("Unknown active extension")
    await this.#closeOwner(owner)
  }
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await Promise.all(this.#owners.map((owner) => this.#closeOwner(owner)))
  }
  #command(selector: string) {
    const [id, name, extra] = selector.split("/")
    const owner = this.#owners.find((owner) => owner.review.id === id)
    const command = owner?.commands.find((command) => command.name === name)
    if (!owner || !command || extra) throw new Error("Unknown extension command; use ID/COMMAND")
    this.#assert(owner)
    return { owner, command }
  }
  #providerId(owner: Owner, provider: ExtensionProvider) {
    return `ext_${owner.review.id}_${provider.name}`
  }
  #assert(owner: Owner, staging = false): void {
    this.#scope.getStore()?.throwIfAborted()
    if (this.#closed || (owner.state !== "active" && !(staging && owner.state === "staging")))
      throw new Error(`Extension ${owner.review.id} is ${owner.state}`)
  }
  async #reviewCurrent(owner: Owner, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const config = (await this.options.resolveConfig?.()) ?? this.options.config
    if (
      config.extensions?.disabled ||
      (!owner.host && !config.extensions?.entries[owner.review.id]?.enabled) ||
      (config.resolution?.constraints?.extensionIds &&
        !config.resolution.constraints.extensionIds.includes(owner.review.id))
    )
      throw new Error("Extension no longer enabled by current policy")
    if (owner.host) {
      const policy = {
        permissions: config.permissions,
        sandbox: config.codex.sandbox,
        sandboxConfig: config.sandbox ?? {},
        constraints: config.resolution?.constraints ?? {},
      }
      if (stableValue(policy) !== owner.hostPolicy)
        throw new Error("Host extension policy changed; open a new session")
      return
    }
    const current = await reviewExtension(config, owner.review.id, this.options.cwd, signal)
    if (current.fingerprint !== owner.review.fingerprint || !extensionTrusted(this.options.dataDir, current))
      throw new Error("Extension source or policy changed; review and reload before execution")
  }
  async #invoke<T>(
    owner: Owner,
    parentSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
    staging = false,
    holdUntil?: (pending: Promise<unknown>) => void,
  ): Promise<T> {
    this.#assert(owner, staging)
    if (owner.pending.size >= 16) throw new Error("Extension callback concurrency limit exceeded")
    const inherited = this.#scope.getStore(),
      workSignal = this.#workAbort.signal
    const signal = AbortSignal.any([
      parentSignal,
      owner.abort.signal,
      workSignal,
      ...(inherited ? [inherited] : []),
      AbortSignal.timeout(30000),
    ])
    signal.throwIfAborted()
    let cancel: () => void = () => {}
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason ?? new Error("Extension callback cancelled"))
      signal.addEventListener("abort", cancel, { once: true })
    })
    const pending = Promise.resolve().then(() => {
      signal.throwIfAborted()
      return this.#scope.run(signal, () => operation(signal))
    })
    owner.pending.add(pending)
    holdUntil?.(pending)
    void pending.finally(() => owner.pending.delete(pending)).catch(() => {})
    try {
      const result = await Promise.race([pending, cancelled])
      signal.throwIfAborted()
      this.#assert(owner, staging)
      return result
    } catch (error) {
      if (!parentSignal.aborted && !owner.abort.signal.aborted && !workSignal.aborted) this.#quarantine(owner)
      throw new Error(this.sanitize(error instanceof Error ? error.message : "Extension callback failed"))
    } finally {
      signal.removeEventListener("abort", cancel)
    }
  }
  #quarantine(owner: Owner, diagnostic = true): void {
    if (["closed", "quarantined"].includes(owner.state)) return
    owner.state = "quarantined"
    owner.abort.abort(new Error("Extension quarantined"))
    for (const timer of owner.timers) if (timer.handle) clearTimeout(timer.handle)
    owner.timers.clear()
    owner.ui.clear()
    this.#host?.ui({
      owner: owner.review.id,
      generation: owner.generation,
      operation: "clear",
      key: "",
      text: "",
    })
    if (diagnostic)
      this.#host?.diagnostic(
        `Extension ${owner.review.id} failed and was quarantined. Inspect its source before reloading.`,
      )
  }
  async #closeOwner(owner: Owner): Promise<void> {
    if (owner.state === "closed") return
    this.#quarantine(owner, false)
    owner.state = "closed"
    const cleanup = owner.cleanup
    owner.cleanup = undefined
    for (const iterator of owner.streams.keys()) void this.#retireStream(owner, iterator)
    const settled = (async () => {
      // A cancellation can schedule a stream finalizer while another callback is settling.
      while (owner.pending.size) await Promise.allSettled([...owner.pending])
      try {
        await cleanup?.()
      } catch {
        /* API ownership has already been revoked. */
      }
      await owner.snapshot?.close()
    })().catch(() => {
      this.#host?.diagnostic(`Extension ${owner.review.id} snapshot cleanup was incomplete`)
    })
    // Never remove a snapshot under noncooperative active code. Retire it after its work settles.
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      settled,
      new Promise<void>((done) => {
        timer = setTimeout(done, 1000)
      }),
    ])
    if (timer) clearTimeout(timer)
    void settled.catch(() => {})
  }
  #retireStream(owner: Owner, iterator: AsyncIterator<ProviderStreamEvent>): Promise<void> {
    if (!owner.streams.has(iterator)) return Promise.resolve()
    const existing = owner.streams.get(iterator)
    if (existing) return existing
    const closing = Promise.resolve()
      .then(async () => {
        await iterator.return?.()
      })
      .catch(() => {})
      .finally(() => {
        owner.streams.delete(iterator)
        owner.pending.delete(closing)
      })
    owner.streams.set(iterator, closing)
    owner.pending.add(closing)
    return closing
  }
  #startTimer(owner: Owner, timer: Timer): void {
    timer.handle = this.#scope.exit(() =>
      setTimeout(() => {
        owner.timers.delete(timer)
        void this.#invoke(owner, owner.abort.signal, async (signal) => {
          await this.#reviewCurrent(owner, signal)
          await timer.callback(signal)
        }).catch(() => {})
      }, timer.milliseconds),
    )
  }
  #validateProviderEvent(event: ProviderStreamEvent): void {
    if (
      ![
        "text_delta",
        "reasoning_delta",
        "thinking",
        "redacted_thinking",
        "tool_call",
        "usage",
        "done",
      ].includes(event.type)
    )
      throw new Error("Unknown extension provider event")
    if (
      ["text_delta", "reasoning_delta", "thinking"].includes(event.type) &&
      !("text" in event && typeof event.text === "string")
    )
      throw new Error("Invalid extension provider text")
    if (event.type === "redacted_thinking" && typeof event.data !== "string")
      throw new Error("Invalid extension redacted thinking")
    if (event.type === "thinking" && event.signature !== undefined && typeof event.signature !== "string")
      throw new Error("Invalid extension thinking signature")
    if (
      event.type === "usage" &&
      (Object.keys(event.usage).some(
        (key) => !["inputTokens", "cachedInputTokens", "outputTokens"].includes(key),
      ) ||
        Object.values(event.usage).some(
          (value) => !Number.isSafeInteger(value) || value < 0 || value > 100000000,
        ))
    )
      throw new Error("Invalid extension provider usage")
    if (
      event.type === "done" &&
      !["end_turn", "tool_use", "max_tokens", "aborted"].includes(event.stopReason)
    )
      throw new Error("Invalid extension provider stop reason")
    if (
      event.type === "tool_call" &&
      (typeof event.id !== "string" ||
        event.id.length > 256 ||
        typeof event.name !== "string" ||
        event.name.length > 128)
    )
      throw new Error("Invalid extension provider tool call")
  }
  #api(owner: Owner): ExtensionApi {
    const registration = () => {
      this.#assert(owner, true)
      if (owner.state !== "staging") throw new Error("Extension registration is sealed")
      if (
        owner.tools.length +
          owner.providers.length +
          owner.commands.length +
          [...owner.events.values()].flat().length >=
        128
      )
        throw new Error("Extension registration limit exceeded")
    }
    const ui = (operation: "status" | "widget" | "composer", key: string, text = "") => {
      this.#assert(owner, true)
      if ((operation !== "composer" && !validName(key)) || typeof text !== "string" || text.length > 16384)
        throw new Error("Invalid extension UI contribution")
      const update: ExtensionUiUpdate = {
        owner: owner.review.id,
        generation: owner.generation,
        operation,
        key,
        text: this.sanitize(text),
      }
      if (operation === "composer") return owner.state === "active" && this.#host?.ui(update) === true
      if (owner.ui.size >= 32 && !owner.ui.has(`${operation}:${key}`))
        throw new Error("Extension UI limit exceeded")
      owner.ui.set(`${operation}:${key}`, update)
      return owner.state === "active" && this.#host?.ui(update) === true
    }
    const runtime = this
    return {
      version: 1,
      id: owner.review.id,
      generation: owner.generation,
      cwd: this.options.cwd,
      signal: owner.abort.signal,
      registerTool: (tool) => {
        registration()
        if (
          !validName(tool.name) ||
          !tool.description ||
          tool.description.length > 4096 ||
          typeof tool.run !== "function" ||
          owner.tools.some((item) => item.name === tool.name)
        )
          throw new Error("Invalid or duplicate extension tool")
        validateExtensionSchema(tool.inputSchema)
        if (tool.inputSchema.type !== "object")
          throw new Error("Extension tool schema must describe an object")
        if (tool.readOnly !== undefined && typeof tool.readOnly !== "boolean")
          throw new Error("Invalid extension readOnly declaration")
        if (tool.effects && !["workspace", "external", "workspace-and-external"].includes(tool.effects))
          throw new Error("Invalid extension effects")
        owner.tools.push({ ...tool, inputSchema: structuredClone(tool.inputSchema) })
      },
      registerProvider: (provider) => {
        registration()
        if (
          !validName(provider.name) ||
          !provider.displayName ||
          provider.displayName.length > 256 ||
          !["openai", "anthropic"].includes(provider.protocol) ||
          typeof provider.stream !== "function" ||
          owner.providers.some((item) => item.name === provider.name) ||
          !Array.isArray(provider.models) ||
          !provider.models.length ||
          provider.models.length > 64
        )
          throw new Error("Invalid extension provider")
        const names = new Set<string>()
        for (const model of provider.models) {
          boundedJson(model, 16384, 128)
          if (
            !validName(model.id) ||
            names.has(model.id) ||
            typeof model.displayName !== "string" ||
            model.displayName.length > 256 ||
            !Number.isSafeInteger(model.contextWindow) ||
            model.contextWindow < 1024 ||
            model.contextWindow > 2000000 ||
            !Number.isSafeInteger(model.maxOutputTokens) ||
            model.maxOutputTokens < 1 ||
            model.maxOutputTokens > model.contextWindow ||
            typeof model.isDefault !== "boolean" ||
            typeof model.supportsReasoning !== "boolean"
          )
            throw new Error("Invalid extension model")
          if (
            model.pricing &&
            (typeof model.pricing.inputPerMTok !== "number" ||
              typeof model.pricing.outputPerMTok !== "number" ||
              Object.keys(model.pricing).some(
                (key) => !["inputPerMTok", "outputPerMTok", "cachedInputPerMTok"].includes(key),
              ) ||
              Object.values(model.pricing).some(
                (value) => typeof value !== "number" || !Number.isFinite(value) || value < 0,
              ))
          )
            throw new Error("Invalid extension pricing")
          names.add(model.id)
        }
        if (provider.models.filter((model) => model.isDefault).length !== 1)
          throw new Error("Extension provider needs exactly one default model")
        owner.providers.push({ ...provider, models: structuredClone(provider.models) })
      },
      registerCommand: (command) => {
        registration()
        if (
          !validName(command.name) ||
          !command.description ||
          command.description.length > 1024 ||
          typeof command.run !== "function" ||
          owner.commands.some((item) => item.name === command.name)
        )
          throw new Error("Invalid extension command")
        owner.commands.push({ ...command })
      },
      registerFlag: (name, options) => {
        registration()
        if (
          !validName(name) ||
          owner.flags.has(name) ||
          owner.flags.size >= 32 ||
          !["string", "boolean", "number"].includes(options.type)
        )
          throw new Error("Invalid extension flag")
        const value = owner.review.config.flags[name] ?? options.default
        if (
          value !== undefined &&
          (typeof value !== options.type ||
            (typeof value === "string" && value.length > 4096) ||
            (typeof value === "number" && !Number.isFinite(value)))
        )
          throw new Error("Extension flag has the wrong type")
        owner.flags.add(name)
        return value
      },
      on: (event, callback) => {
        registration()
        if (!HOOK_EVENTS.includes(event) || typeof callback !== "function")
          throw new Error("Invalid extension event subscription")
        const callbacks = owner.events.get(event) ?? []
        callbacks.push(callback)
        owner.events.set(event, callbacks)
      },
      after: (milliseconds, callback) => {
        this.#assert(owner, true)
        if (
          !Number.isInteger(milliseconds) ||
          milliseconds < 10 ||
          milliseconds > 86400000 ||
          typeof callback !== "function" ||
          owner.timers.size >= 32
        )
          throw new Error("Invalid extension timer")
        const timer: Timer = { milliseconds, callback }
        owner.timers.add(timer)
        if (owner.state === "active") this.#startTimer(owner, timer)
        return () => {
          if (timer.handle) clearTimeout(timer.handle)
          owner.timers.delete(timer)
        }
      },
      ui: {
        get available() {
          return owner.state === "active" && runtime.#host?.interactive() === true
        },
        status: (key, text) => ui("status", key, text),
        widget: (key, text) => ui("widget", key, text),
        composer: (text) => ui("composer", "", text),
        dialog: async (form, parent = owner.abort.signal) => {
          this.#assert(owner)
          if (!this.#host?.interactive()) return { action: "unsupported" }
          const full = validateExtensionForm(this.#sanitizeValue(form) as typeof form, {
            server: owner.review.source,
            generation: owner.generation,
            operation: randomUUID(),
          })
          return this.#invoke(owner, parent, async (signal) => {
            const answer = await this.#host!.dialog(full, signal)
            if (answer.action === "accept") validateFormValues(full, answer.content)
            return answer
          })
        },
      },
      complete: async (model, prompt, parent = owner.abort.signal) => {
        this.#assert(owner)
        if (!this.#host || typeof prompt !== "string" || prompt.length > 32768)
          throw new Error("Extension auxiliary request unavailable or too large")
        return this.#invoke(owner, parent, async (signal) =>
          this.#host!.complete(model, this.sanitize(prompt), signal),
        )
      },
    }
  }
}
