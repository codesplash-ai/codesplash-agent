import { isAbsolute } from "node:path"
import { stableValue } from "../../../core/config/source.ts"
import type { AgentConfig, PermissionMode } from "../../../core/config.ts"
import { digest } from "../../../core/session/files.ts"
import type { PermissionRuntime, ProviderClient, ProviderUsage } from "../contracts.ts"
import { type CodesplashPermissionRuntime, describePermissionRules } from "../permissions.ts"
import type { AccessGrant, SandboxProfile } from "../sandbox/contracts.ts"
import { contains, createProfile, physicalPath } from "../sandbox/profile.ts"
import { NativeSandbox } from "../sandbox/runtime.ts"
import type { ToolRegistry } from "../tools/registry.ts"
import type { ResolvedAgent } from "./definitions.ts"

export function narrowedMode(parent: PermissionMode, selected: ResolvedAgent["mode"]): ResolvedAgent["mode"] {
  const order = ["plan", "default", "accept-edits", "bypass"]
  return order[Math.min(order.indexOf(parent), order.indexOf(selected))] as ResolvedAgent["mode"]
}
function roots(parent: string[], selected: string[] | undefined): string[] {
  if (selected === undefined) return [...parent]
  return selected.map((path) => {
    if (!isAbsolute(path) || [...path].some((char) => char.charCodeAt(0) < 32 || "*?[]{}".includes(char)))
      throw new Error("Agent roots must be literal absolute paths")
    const canonical = physicalPath(path)
    if (!parent.some((root) => contains(root, canonical)))
      throw new Error("Agent filesystem scope exceeds its parent")
    return canonical
  })
}
export function scopedProfile(
  parent: SandboxProfile,
  definition: ResolvedAgent,
  mode: PermissionMode,
  cwd = parent.cwd,
): SandboxProfile {
  if (parent.mode === "danger-full-access")
    throw new Error("Child sessions require an enforced parent sandbox")
  const readOnly = mode === "plan" || parent.mode === "read-only"
  let readRoots = roots(parent.readRoots, definition.readRoots)
  if (!readRoots.some((root) => contains(root, cwd)))
    throw new Error("Child read roots must include its working directory")
  let selectedWrite = roots(parent.writeRoots, definition.writeRoots)
  if (cwd !== parent.cwd) {
    if (!contains(parent.cwd, cwd))
      throw new Error("Child worktree must remain inside parent workspace authority")
    readRoots = [cwd]
    selectedWrite = selectedWrite.some((root) => contains(root, cwd)) ? [cwd] : []
  }
  const allowedHosts = definition.allowedHosts ?? parent.allowedHosts
  if (allowedHosts.some((host) => !parent.allowedHosts.includes(host)))
    throw new Error("Agent network scope exceeds its parent")
  const { hash: _, ...base } = parent
  const profile = {
    ...structuredClone(base),
    cwd,
    protectedPaths: [
      ...new Set([
        ...base.protectedPaths,
        ...(cwd !== parent.cwd
          ? createProfile(cwd, readOnly ? "read-only" : "workspace-write").protectedPaths
          : []),
      ]),
    ],
    mode: readOnly ? ("read-only" as const) : ("workspace-write" as const),
    readRoots,
    writeRoots: readOnly ? [] : selectedWrite,
    allowedHosts: [...allowedHosts],
  }
  return { ...profile, hash: digest(JSON.stringify(profile)) }
}
export function scopedConfig(config: AgentConfig, definition: ResolvedAgent): AgentConfig {
  const result = structuredClone(config)
  const servers = result.mcp?.servers ?? {}
  const requested =
    typeof definition.mcp === "object"
      ? "only" in definition.mcp
        ? definition.mcp.only
        : definition.mcp.except
      : []
  if (requested.some((name) => !servers[name]?.enabled))
    throw new Error("Agent selected an MCP server outside its parent's enabled scope")
  for (const [name, server] of Object.entries(servers)) {
    const selected =
      definition.mcp === "all" ||
      (typeof definition.mcp === "object" &&
        ("only" in definition.mcp
          ? definition.mcp.only.includes(name)
          : !definition.mcp.except.includes(name)))
    server.enabled = server.enabled && selected
  }
  return result
}
export function scopedPermissions(
  base: PermissionRuntime,
  parent: PermissionRuntime,
  definition: ResolvedAgent,
): PermissionRuntime & Pick<CodesplashPermissionRuntime, "describeRules"> {
  const maxMode = narrowedMode(parent.mode, definition.mode)
  const toolAllowed = (name: string) =>
    !definition.denyTools.includes(name) &&
    (definition.tools === undefined || definition.tools.includes(name))
  return {
    get mode() {
      return base.mode
    },
    describeRules: () => [
      ...describePermissionRules(base),
      ...describePermissionRules(parent).filter((rule) => rule.action !== "allow"),
    ],
    decideContextRead(name, targets) {
      if (definition.denyTools.includes(name))
        return { kind: "deny", reason: "Context read denied by child definition" }
      const own = base.decide(name, targets, true)
      const ceiling = parent.decideContextRead?.(name, targets) ?? parent.decide(name, targets, true)
      if (own.kind === "deny") return own
      if (ceiling.kind === "deny") return ceiling
      if (ceiling.kind === "ask") return { ...ceiling, persistableRule: undefined }
      return own.kind === "ask" ? { ...own, persistableRule: undefined } : own
    },
    setMode(mode) {
      if (narrowedMode(maxMode, mode === "bypass" ? "accept-edits" : mode) !== mode)
        throw new Error("Child permission mode exceeds its capability envelope")
      base.setMode(mode)
    },
    decide(name, targets, readOnly) {
      if (!toolAllowed(name) || (maxMode === "plan" && !readOnly))
        return { kind: "deny", reason: "Tool is outside the child capability envelope" }
      const ceiling = parent.decide(name, targets, readOnly),
        own = base.decide(name, targets, readOnly)
      if (own.kind === "deny") return own
      if (ceiling.kind === "deny") return ceiling
      if (ceiling.kind === "ask") return { ...ceiling, persistableRule: undefined }
      return own.kind === "ask" ? { ...own, persistableRule: undefined } : own
    },
    isReadDenied(path, name) {
      return parent.isReadDenied(path, name) ?? base.isReadDenied(path, name)
    },
    async persistGrant() {
      throw new Error("Child approvals are never persisted or inherited")
    },
    reload: () => base.reload?.() ?? Promise.resolve(),
  }
}
export function scopedRegistry(registry: ToolRegistry, permissions: PermissionRuntime): ToolRegistry {
  const permitted = (name: string) => {
    const tool = registry.get(name)
    if (
      tool?.hidden &&
      ["context_read", "user_context_read", "context_list", "context_files", "attachment_access"].includes(
        name,
      )
    )
      return true
    // Permission decisions still check concrete targets at execution; catalog filtering
    // only removes explicit envelope exclusions. Never invoke tool-specific input parsers here.
    return !!tool && permissions.decide(tool.permissionName ?? name, undefined, true).kind !== "deny"
  }
  return {
    get generation() {
      return registry.generation
    },
    specs: () => registry.specs().filter((tool) => permitted(tool.name)),
    get: (name, generation) => (permitted(name) ? registry.get(name, generation) : undefined),
    source: (name) => (permitted(name) ? registry.source(name) : undefined),
    ...(registry.resolve ? { resolve: registry.resolve.bind(registry) } : {}),
  }
}
export const configurationIdentity = (config: AgentConfig) =>
  digest(stableValue({ ...config, resolution: config.resolution?.generation }))

/** Synchronous reservations across ancestry; providers with unknown usage stop further work. */
export class ChildBudget {
  used = 0
  reserved = 0
  uncertain = false
  readonly deadline: number
  constructor(
    readonly limit: number,
    timeoutMs: number,
    readonly parent?: ChildBudget,
    readonly changed?: (budget: ChildBudget) => void,
  ) {
    this.deadline = Math.min(Date.now() + timeoutMs, parent?.deadline ?? Infinity)
  }
  get remaining(): number {
    return Math.max(0, Math.min(this.limit - this.used - this.reserved, this.parent?.remaining ?? Infinity))
  }
  #chain(): ChildBudget[] {
    return [this, ...(this.parent ? this.parent.#chain() : [])]
  }
  reserveAuxiliary(tokens: number): (usage?: number) => void {
    const chain = this.#chain()
    if (
      !Number.isSafeInteger(tokens) ||
      tokens < 1 ||
      tokens > this.remaining ||
      chain.some((b) => b.uncertain || Date.now() >= b.deadline)
    )
      throw new Error("Auxiliary budget cannot admit this request")
    for (const b of chain) b.reserved += tokens
    try {
      for (const b of chain) b.changed?.(b)
    } catch (error) {
      for (const b of chain) {
        b.reserved -= tokens
        b.uncertain = true
      }
      throw error
    }
    let settled = false
    return (usage) => {
      if (settled) return
      settled = true
      const known = usage !== undefined && Number.isSafeInteger(usage) && usage >= 0
      for (const b of chain) {
        b.reserved -= tokens
        b.used += known ? usage : tokens
        if (!known) b.uncertain = true
      }
      for (const b of chain) b.changed?.(b)
    }
  }
  wrap(provider: ProviderClient): ProviderClient {
    const budget = this
    return {
      id: provider.id,
      models: provider.models,
      async *stream(request, signal) {
        const chain = budget.#chain()
        if (chain.some((b) => b.uncertain || Date.now() >= b.deadline))
          throw new Error("Child budget is exhausted or usage is uncertain")
        // Conservative local estimate; reported provider usage remains the final debit.
        const input = Buffer.byteLength(JSON.stringify([request.system, request.messages, request.tools]))
        const output = Math.min(request.model.maxOutputTokens, Math.floor(budget.remaining - input))
        if (output < 1) throw new Error("Child token budget cannot admit another provider request")
        const reservation = input + output
        for (const b of chain) b.reserved += reservation
        try {
          for (const b of chain) b.changed?.(b)
        } catch (error) {
          for (const b of chain) {
            b.reserved -= reservation
            b.uncertain = true
          }
          throw error
        }
        let usage: ProviderUsage | undefined
        const timeout = AbortSignal.timeout(Math.max(1, budget.deadline - Date.now()))
        const combined = AbortSignal.any([signal, timeout])
        try {
          for await (const event of provider.stream(
            { ...request, model: { ...request.model, maxOutputTokens: output } },
            combined,
          )) {
            combined.throwIfAborted()
            if (event.type === "usage") {
              if (
                [event.usage.inputTokens, event.usage.cachedInputTokens, event.usage.outputTokens].some(
                  (v) => v !== undefined && (!Number.isSafeInteger(v) || v < 0),
                )
              )
                throw new Error("Invalid child usage")
              usage = event.usage
            }
            yield event
          }
        } finally {
          const known =
            usage !== undefined && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)
          const debit = known
            ? (usage?.inputTokens ?? 0) + (usage?.cachedInputTokens ?? 0) + (usage?.outputTokens ?? 0)
            : reservation
          for (const b of chain) {
            b.reserved -= reservation
            b.used += debit
            if (!known) b.uncertain = true
          }
          for (const b of chain) b.changed?.(b)
        }
        if (budget.uncertain) throw new Error("Child provider usage is unknown; continuation stopped")
      },
    }
  }
}

export class ChildSandbox extends NativeSandbox {
  override validateGrant(grant: AccessGrant, mode: PermissionMode): AccessGrant {
    const checked = super.validateGrant(grant, mode)
    const allowed =
      checked.resource === "network"
        ? this.profile.allowedHosts.includes(checked.target)
        : (checked.resource === "read" ? this.profile.readRoots : this.profile.writeRoots).some((root) =>
            contains(root, checked.target),
          )
    if (!allowed) throw new Error("Child access grant exceeds its fixed parent capability envelope")
    return checked
  }
  override grant(grant: AccessGrant): void {
    super.grant(this.validateGrant(grant, "default"))
  }
}
