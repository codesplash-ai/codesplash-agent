import { join } from "node:path"
import type { AgentConfig } from "../../../core/config.ts"
import type { EngineDecision, EngineSession, SessionUsageSnapshot } from "../../../core/engine.ts"
import type { AgentEvent, AgentEventInput } from "../../../core/events.ts"
import type { HookEventName } from "../../../core/hooks.ts"
import { PeerEndpoint, sendPeerEndpoint } from "../../../core/orchestration/peer-socket.ts"
import { PeerMailbox } from "../../../core/orchestration/peers.ts"
import type { TaskHandle } from "../../../core/orchestration/tasks.ts"
import {
  control,
  MemorySessionState,
  type SessionStateAccess,
  updateControl,
} from "../../../core/session/control.ts"
import { bytes, digest, directory } from "../../../core/session/files.ts"
import type { ChatMessage, HarnessTool, ToolContext } from "../contracts.ts"
import { verifySelection } from "../plugins/store.ts"
import type { SandboxProfile } from "../sandbox/contracts.ts"
import type { NativeCommands } from "./commands.ts"
import { discoverAgents, type ResolvedAgent, selectAgent } from "./definitions.ts"
import { ChildBudget, configurationIdentity } from "./scope.ts"
import type { NativeWorktrees } from "./worktrees.ts"

export type SpawnAgentInput = {
  agent: string
  context?: "fresh" | "fork"
  worktree?: string
  directive?: string
  prompt: string
  persona?: string
  resume?: string
  reviewUncertain?: boolean
  background?: boolean
  yieldMs?: number
}
export type ChildIdentity = {
  team?: string
  member?: string
  worktree?: string
  fork?: string
  directive?: string
  extensions: string[]
  version: 1
  id: string
  root: string
  agent: string
  fingerprint: string
  persona: string
  model: string
  cwd: string
  config: string
  profile: string
}
export type ChildRuntime = EngineSession & {
  historyForDirectory(): ChatMessage[]
  usageForDirectory(): SessionUsageSnapshot
  settled(): Promise<void>
}
type ChildMemory = {
  peers: PeerMailbox
  endpoint?: PeerEndpoint
  states: Map<string, SessionStateAccess>
  history: Map<string, ChatMessage[]>
  owners: Map<string, NativeChildren>
}
export type ChildLaunch = {
  memory: ChildMemory
  resuming: boolean
  definition: ResolvedAgent
  identity: ChildIdentity
  state: SessionStateAccess
  history?: ChatMessage[]
  task: string
  budget: ChildBudget
  commands: NativeCommands
  signal: AbortSignal
}
type ChildRecord = { task: string; identity: ChildIdentity }
type RequestRoute = { child: ChildRuntime; request: string; timer: ReturnType<typeof setTimeout> }
export type ChildrenHost = {
  memory?: ChildMemory
  identity?: string
  team?(): string | undefined
  history(): ChatMessage[]
  worktrees: NativeWorktrees
  root: string
  cwd: string
  userRoot: string
  trusted: boolean
  state: SessionStateAccess
  parentTask?: string
  budget?: ChildBudget
  commands: NativeCommands
  outputSanitizer(): { push(text: string, final?: boolean): string }
  sanitize(text: string): string
  extensions(): string[]
  config(): Promise<AgentConfig>
  model(): string
  profile(): SandboxProfile
  open(launch: ChildLaunch): Promise<ChildRuntime>
  emit(event: AgentEventInput): void
  usage(delta: SessionUsageSnapshot): void
  hook(event: HookEventName, signal: AbortSignal, task: string, agent: string): Promise<void>
}
function inputOf(input: unknown): SpawnAgentInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected agent input")
  const v = input as SpawnAgentInput
  if (
    Object.keys(v).some(
      (k) =>
        ![
          "agent",
          "prompt",
          "persona",
          "resume",
          "reviewUncertain",
          "background",
          "yieldMs",
          "context",
          "worktree",
          "directive",
        ].includes(k),
    ) ||
    typeof v.agent !== "string" ||
    v.agent.length > 256 ||
    typeof v.prompt !== "string" ||
    !v.prompt.trim() ||
    Buffer.byteLength(v.prompt) > 49152 ||
    v.prompt.includes("\0")
  )
    throw new Error("Invalid agent name or prompt")
  if (
    v.persona !== undefined &&
    (typeof v.persona !== "string" || Buffer.byteLength(v.persona) > 4096 || v.persona.includes("\0"))
  )
    throw new Error("Invalid agent persona")
  if (v.resume !== undefined && (typeof v.resume !== "string" || !/^[a-f0-9-]{36}$/.test(v.resume)))
    throw new Error("Invalid child resume identity")
  for (const key of ["reviewUncertain", "background"] as const)
    if (v[key] !== undefined && typeof v[key] !== "boolean") throw new Error(`Invalid ${key}`)
  if (v.yieldMs !== undefined && (!Number.isSafeInteger(v.yieldMs) || v.yieldMs < 0 || v.yieldMs > 30000))
    throw new Error("Agent yield must be between 0 and 30000 ms")
  if (v.context !== undefined && !["fresh", "fork"].includes(v.context))
    throw new Error("Invalid child context selection")
  if (v.resume && v.context) throw new Error("Resume uses recorded context, not a new fork")
  if (v.worktree !== undefined && (typeof v.worktree !== "string" || !/^[a-f0-9-]{36}$/.test(v.worktree)))
    throw new Error("Invalid owned worktree ID")
  if (
    v.directive !== undefined &&
    (typeof v.directive !== "string" || Buffer.byteLength(v.directive) > 4096 || v.directive.includes("\0"))
  )
    throw new Error("Invalid child directive")
  return structuredClone(v)
}
function forkHistory(history: ChatMessage[]): ChatMessage[] {
  const resultIds = new Set(
    history
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result")
      .map((b) => (b.type === "tool_result" ? b.toolCallId : "")),
  )
  const selected = history
    .map((m) => ({
      ...m,
      content: m.content.filter(
        (b) =>
          b.type !== "thinking" &&
          b.type !== "redacted_thinking" &&
          (b.type !== "tool_call" || resultIds.has(b.id)),
      ),
    }))
    .filter((m) => m.content.length)
  if (Buffer.byteLength(JSON.stringify(selected)) > 1024 * 1024) throw new Error("Fork context exceeds 1 MiB")
  return structuredClone(selected)
}
export class NativeChildren {
  readonly #states: Map<string, SessionStateAccess>
  readonly #history: Map<string, ChatMessage[]>
  readonly #memory: ChildMemory
  readonly #live = new Map<string, { handle: TaskHandle; child?: ChildRuntime }>()
  readonly #requests = new Map<string, RequestRoute>()
  #closed = false
  constructor(readonly host: ChildrenHost) {
    this.#memory = host.memory ?? {
      peers: new PeerMailbox(host.root, host.state),
      states: new Map(),
      history: new Map(),
      owners: new Map(),
    }
    this.#states = this.#memory.states
    this.#history = this.#memory.history
  }
  forget(task: string): void {
    this.#memory.peers.forget(task)
    const owner = this.#memory.owners.get(task)
    if (owner && owner !== this) {
      owner.forget(task)
      return
    }
    const found = this.#findRecord(task, this.host.state, new Set())
    if (!found) return
    const { state, records, selected } = found
    state.update(state.read().revision, "child/forget", (value) => {
      value.values.children = records.filter((record) => record.task !== task)
    })
    this.#memory.owners.delete(task)
    if (!records.some((record) => record.task !== task && record.identity.id === selected.identity.id)) {
      this.#states.delete(selected.identity.id)
      this.#history.delete(selected.identity.id)
    }
  }
  #findRecord(
    task: string,
    state: SessionStateAccess,
    visited: Set<string>,
  ): { state: SessionStateAccess; records: ChildRecord[]; selected: ChildRecord } | undefined {
    const records = this.#records(state)
    const selected = records.find((record) => record.task === task)
    if (selected) return { state, records, selected }
    for (const record of records) {
      if (visited.has(record.identity.id)) continue
      if (visited.size >= 128) throw new Error("Child journal traversal limit reached")
      visited.add(record.identity.id)
      const found = this.#findRecord(task, this.#state(record.identity.id, state), visited)
      if (found) return found
    }
  }
  #records(state = this.host.state): ChildRecord[] {
    const raw = state.read().state.values.children
    if (raw === undefined) return []
    if (
      !Array.isArray(raw) ||
      raw.length > 128 ||
      raw.some(
        (r) =>
          !r ||
          typeof r.task !== "string" ||
          !/^[a-f0-9-]{36}$/.test(r.task) ||
          !r.identity ||
          r.identity.version !== 1 ||
          (r.identity.team !== undefined && !/^[a-f0-9-]{36}$/.test(r.identity.team)) ||
          (r.identity.member !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(r.identity.member)) ||
          (r.identity.worktree !== undefined &&
            (typeof r.identity.worktree !== "string" || !/^[a-f0-9-]{36}$/.test(r.identity.worktree))) ||
          (r.identity.fork !== undefined &&
            (typeof r.identity.fork !== "string" || !/^[a-f0-9]{64}$/.test(r.identity.fork))) ||
          (r.identity.directive !== undefined &&
            (typeof r.identity.directive !== "string" ||
              Buffer.byteLength(r.identity.directive) > 4096 ||
              r.identity.directive.includes("\0"))) ||
          !Array.isArray(r.identity.extensions) ||
          r.identity.extensions.length > 128 ||
          r.identity.extensions.some((id: unknown) => typeof id !== "string" || id.length > 128) ||
          r.identity.root !== this.host.root ||
          !/^[a-f0-9-]{36}$/.test(r.identity.id) ||
          [r.identity.fingerprint, r.identity.config, r.identity.profile].some(
            (hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash),
          ) ||
          [r.identity.agent, r.identity.model, r.identity.cwd, r.identity.persona].some(
            (text) => typeof text !== "string" || text.length > 4096 || text.includes("\0"),
          ),
      )
    )
      throw new Error("Corrupt child identity journal")
    return raw as ChildRecord[]
  }
  #state(id: string, parent = this.host.state): SessionStateAccess {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))
      throw new Error("Invalid child storage identity")
    const cached = this.#states.get(id)
    if (cached) return cached
    if (this.#states.size >= 128) throw new Error("Child state retention limit reached")
    let state: SessionStateAccess
    if (parent.durable && parent.directory) {
      const path = join(parent.directory, "children", id)
      parent.assertOwned?.()
      directory(path, true)
      state = {
        directory: path,
        durable: true,
        assertOwned: () => parent.assertOwned?.(),
        read: () => {
          parent.assertOwned?.()
          return control(path)
        },
        update: (revision, operation, change) => {
          parent.assertOwned?.()
          return updateControl(path, revision, operation, change)
        },
      }
    } else state = new MemorySessionState()
    this.#states.set(id, state)
    return state
  }
  async catalog(context: ToolContext): Promise<ResolvedAgent[]> {
    if (!context.runInternal) throw new Error("Agent discovery requires native context reads")
    return discoverAgents({
      cwd: this.host.cwd,
      userRoot: this.host.userRoot,
      trusted: this.host.trusted,
      config: await this.host.config(),
      run: context.runInternal,
      signal: context.signal,
    })
  }
  admission?: { parent: string; budget: ChildBudget }
  teamAdmission?: { team: string; member: string }
  get mailbox() {
    return this.#memory.peers
  }
  evidence(task: string): { output: string; hashes: string[]; failed: boolean } {
    const record = this.#records().find((r) => r.task === task)
    const history = record ? (this.#history.get(record.identity.id) ?? []) : []
    const calls = new Set<string>(),
      hashes: string[] = []
    let failed = false,
      output = ""
    for (const message of history)
      for (const block of message.content) {
        if (message.role === "assistant" && block.type === "text") output = block.text
        if (block.type === "tool_call" && ["read_file", "glob", "grep"].includes(block.name))
          calls.add(block.id)
        if (block.type === "tool_result") {
          if (block.isError) failed = true
          else if (calls.has(block.toolCallId)) hashes.push(digest(block.text))
        }
      }
    return { output: output.slice(0, 4096), hashes: hashes.slice(-16), failed }
  }
  async spawn(raw: unknown, context: ToolContext) {
    const admission = this.admission,
      membership = this.teamAdmission
    if (this.#closed) throw new Error("Child owner is closed")
    const input = inputOf(raw)
    const definition = selectAgent(await this.catalog(context), input.agent)
    const configuration = await this.host.config()
    const prior = input.resume
      ? this.#records().findLast(
          (record) => record.task === input.resume || record.identity.id === input.resume,
        )
      : undefined
    if (input.resume && !prior) throw new Error("Child resume identity is not owned by this parent")
    const fork = input.context === "fork" ? forkHistory(this.host.history()) : undefined
    const worktreeId = input.worktree ?? prior?.identity.worktree
    const worktree = worktreeId ? await this.host.worktrees.select(worktreeId) : undefined
    const team = membership?.team ?? prior?.identity.team ?? this.host.team?.()
    const identity: ChildIdentity = {
      ...(team ? { team, member: membership?.member ?? prior?.identity.member ?? crypto.randomUUID() } : {}),
      ...(worktreeId ? { worktree: worktreeId } : {}),
      ...(fork
        ? { fork: digest(JSON.stringify(fork)) }
        : prior?.identity.fork
          ? { fork: prior.identity.fork }
          : {}),
      ...(input.directive !== undefined || prior?.identity.directive !== undefined
        ? { directive: input.directive ?? prior?.identity.directive }
        : {}),
      version: 1,
      extensions: this.host.extensions(),
      id: prior?.identity.id ?? crypto.randomUUID(),
      root: this.host.root,
      agent: definition.id,
      fingerprint: definition.fingerprint,
      persona: input.persona ?? prior?.identity.persona ?? "",
      model: definition.model ?? prior?.identity.model ?? this.host.model(),
      cwd: worktree?.cwd ?? this.host.cwd,
      config: configurationIdentity(configuration),
      profile: this.host.profile().hash,
    }
    if (prior && digest(JSON.stringify(prior.identity)) !== digest(JSON.stringify(identity)))
      throw new Error("Child resume identity, source or capability envelope changed")
    if (prior) {
      const records = this.#records().filter((record) => record.identity.id === prior.identity.id)
      const tasks = this.host.commands.tasks.list()
      if (
        records.some((record) =>
          tasks.some((task) => task.id === record.task && ["queued", "running"].includes(task.status)),
        )
      )
        throw new Error("This child identity already has active work")
      const old = this.host.commands.tasks.list().find((t) => t.id === prior.task)
      if (!old || ["queued", "running"].includes(old.status))
        throw new Error("Child is still active or its task record is unavailable")
      if (old.status === "execution-uncertain" && !input.reviewUncertain)
        throw new Error("Review uncertain child execution explicitly before resuming")
    }
    const budget = new ChildBudget(
      definition.budgetTokens,
      definition.timeoutMs,
      admission?.budget ?? this.host.budget,
    )
    let child: ChildRuntime | undefined
    const handle = this.host.commands.tasks.submit(
      {
        kind: "agent",
        label: `${definition.id}: ${this.host.sanitize(input.prompt).slice(0, 200)}`,
        parent: admission?.parent ?? this.host.parentTask,
      },
      async (task) => {
        // Effects begin only after the shared registry has committed admission.
        const timer = setTimeout(
          () => {
            try {
              this.host.commands.tasks.interrupt(task.id)
            } catch {}
          },
          Math.max(1, budget.deadline - Date.now()),
        )
        const cancel = () => {
          void child?.interrupt()
        }
        task.signal.addEventListener("abort", cancel, { once: true })
        let events: Promise<void> | undefined
        let worktreeClaim: Awaited<ReturnType<NativeWorktrees["claim"]>> | undefined
        let started = false
        const sanitizer = this.host.outputSanitizer()
        try {
          if (
            configurationIdentity(await this.host.config()) !== identity.config ||
            JSON.stringify(this.host.extensions()) !== JSON.stringify(identity.extensions)
          )
            throw new Error("Parent configuration changed during child admission")
          // Re-read selected source under the same scoped reader; no cached source becomes executable.
          if (
            definition.source !== "builtin" &&
            definition.source !== "configuration" &&
            digest(bytes(definition.source, 65536)) !== definition.fingerprint
          )
            throw new Error("Agent definition changed during admission")
          if (definition.id.startsWith("plugin/")) {
            const plugin = configuration.pluginResources?.find((p) =>
              definition.id.startsWith(`plugin/${p.id}/`),
            )
            if (!plugin) throw new Error("Agent plugin is no longer active")
            await verifySelection(plugin, "plugin", task.signal)
          }
          task.signal.throwIfAborted()
          const state = this.#state(identity.id)
          const before = this.host.state.read()
          this.host.state.update(before.revision, "child/admit", (value) => {
            const records = this.#records().filter((record) => record.task !== task.id)
            if (records.length >= 128) throw new Error("Child identity retention limit reached")
            value.values.children = [...records, { task: task.id, identity }]
          })
          this.#memory.peers.register({
            id: identity.id,
            task: task.id,
            parent: this.host.identity ?? this.host.root,
            agent: definition.id,
            ...(identity.fork ? { fork: identity.fork } : {}),
            ...(identity.team ? { team: identity.team, member: identity.member } : {}),
          })
          if (identity.worktree) {
            worktreeClaim = await this.host.worktrees.claim(identity.worktree)
            if (worktreeClaim.tree.cwd !== identity.cwd)
              throw new Error("Worktree identity changed during admission")
          }
          await this.host.hook("subagent.start", task.signal, task.id, definition.id)
          started = true
          child = await this.host.open({
            definition,
            identity,
            resuming: !!prior,
            memory: this.#memory,
            state,
            history: this.#history.get(identity.id) ?? fork,
            task: task.id,
            budget,
            commands: this.host.commands,
            signal: task.signal,
          })
          const live = this.#live.get(task.id)
          if (live) live.child = child
          task.signal.throwIfAborted()
          let usage: SessionUsageSnapshot = {},
            outcome: string | undefined
          events = (async () => {
            for await (const event of child!.events) {
              if (event.kind === "message.delta") task.output.append(sanitizer.push(event.payload.text))
              else if (event.kind === "error" || event.kind === "warning")
                task.output.append(this.host.sanitize(`\n[${event.kind}] ${event.payload.message}\n`))
              else if (event.kind === "turn.completed") outcome = event.payload.status
              else if (event.kind === "usage.updated") {
                const delta: SessionUsageSnapshot = {}
                for (const key of [
                  "inputTokens",
                  "cachedInputTokens",
                  "outputTokens",
                  "embeddingInputTokens",
                  "estimatedCostUsd",
                ] as const)
                  delta[key] = Math.max(0, (event.payload[key] ?? 0) - (usage[key] ?? 0))
                delta.hasUnpricedUsage = event.payload.hasUnpricedUsage
                usage = { ...event.payload }
                this.#memory.peers.addUsage(identity.id, delta)
                this.host.usage(delta)
              } else this.#routeEvent(child!, task.id, definition.id, event)
            }
          })()
          await child.send({ text: input.prompt })
          await child.settled()
          const history = structuredClone(child.historyForDirectory())
          const retained = [...this.#history.entries()]
            .filter(([id]) => id !== identity.id)
            .reduce((sum, [, value]) => sum + Buffer.byteLength(JSON.stringify(value)), 0)
          if (retained + Buffer.byteLength(JSON.stringify(history)) > 8 * 1024 * 1024)
            throw new Error("Child context retention exceeds 8 MiB")
          this.#history.set(identity.id, history)
          await child.close()
          await events
          if (outcome !== "completed") throw new Error(`Child turn ${outcome ?? "did not complete"}`)
        } catch (error) {
          task.output.append(
            this.host.sanitize(
              `\n[Child stopped] ${error instanceof Error ? error.message : "Unknown child failure"}\n`,
            ),
          )
          throw error
        } finally {
          clearTimeout(timer)
          task.signal.removeEventListener("abort", cancel)
          await child?.close()
          await events?.catch(() => {})
          this.#clearRequests(child)
          task.output.append(sanitizer.push("", true))
          this.#live.delete(task.id)
          try {
            if (started) {
              this.host.state.assertOwned?.()
              await this.host.hook("subagent.stop", AbortSignal.timeout(5000), task.id, definition.id)
            }
          } finally {
            worktreeClaim?.release()
          }
        }
      },
    )
    this.#memory.owners.set(handle.id, this)
    this.#live.set(handle.id, { handle })
    this.host.commands.adopt(handle, context.modelContext !== false)
    const abort = () => {
      try {
        this.host.commands.tasks.interrupt(handle.id)
      } catch {}
    }
    if (!input.background) context.signal.addEventListener("abort", abort, { once: true })
    try {
      if (context.signal.aborted) abort()
      if (!input.background)
        await this.host.commands.yieldTask(handle.id, handle.finished, input.yieldMs ?? 1000)
      return {
        label: `Agent ${definition.id}`,
        text: JSON.stringify(this.host.commands.output(handle.id, 0, 16384)),
      }
    } finally {
      context.signal.removeEventListener("abort", abort)
    }
  }
  #routeEvent(child: ChildRuntime, task: string, agent: string, event: AgentEvent) {
    if (event.kind === "request.opened") {
      if (this.#closed || this.#requests.size >= 32) {
        void child.resolveRequest(event.payload.id, { choice: "cancel" })
        return
      }
      const id = crypto.randomUUID()
      const timer = setTimeout(() => {
        void this.resolve(id, { choice: "cancel" }).catch(() => {})
      }, 30000)
      this.#requests.set(id, { child, request: event.payload.id, timer })
      this.host.emit({
        kind: "request.opened",
        payload: {
          ...event.payload,
          id,
          title: `[${agent} ${task.slice(0, 8)}] ${event.payload.title}`,
          detail: `Child task ${task}\n${event.payload.detail}`,
        },
      })
    } else if (event.kind === "request.resolved") {
      for (const [id, route] of this.#requests)
        if (route.child === child && route.request === event.payload.id) {
          clearTimeout(route.timer)
          this.#requests.delete(id)
          this.host.emit({ kind: "request.resolved", payload: { id, decision: event.payload.decision } })
        }
    }
  }
  #clearRequests(child?: ChildRuntime) {
    if (!child) return
    for (const [id, route] of this.#requests)
      if (route.child === child) {
        clearTimeout(route.timer)
        this.#requests.delete(id)
        this.host.emit({ kind: "request.resolved", payload: { id, decision: "cancel" } })
      }
  }
  async resolve(id: string, decision: EngineDecision): Promise<boolean> {
    const route = this.#requests.get(id)
    if (!route) return false
    await route.child.resolveRequest(route.request, decision)
    return true
  }
  async close() {
    this.#closed = true
    for (const [id, live] of this.#live) {
      try {
        this.host.commands.tasks.interrupt(id)
      } catch {}
      void live.child?.interrupt()
    }
    await Promise.all([...this.#live.values()].map((live) => live.handle.finished))
    for (const route of this.#requests.values()) clearTimeout(route.timer)
    this.#requests.clear()
    if (!this.host.parentTask) await this.#memory.endpoint?.close()
  }
  takeMessages() {
    return this.#memory.peers.inbox(this.host.identity ?? this.host.root, true)
  }
  async peer(raw: unknown, context?: ToolContext) {
    if (this.#closed) throw new Error("Peer owner is closed")
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected peer request")
    const value = raw as {
      action: string
      target?: string
      text?: string
      endpoint?: string
      prompt?: string
      yieldMs?: number
    }
    if (
      Object.keys(value).some(
        (k) => !["action", "target", "text", "endpoint", "prompt", "yieldMs"].includes(k),
      )
    )
      throw new Error("Unknown peer field")
    const me = this.host.identity ?? this.host.root
    switch (value.action) {
      case "graph":
        return this.#memory.peers.graph(me)
      case "inbox":
        return this.#memory.peers.inbox(me)
      case "send":
        if (typeof value.target !== "string" || typeof value.text !== "string")
          throw new Error("Peer recipient and text required")
        if (value.endpoint) {
          if (this.host.parentTask) throw new Error("Only root can send across session endpoints")
          return sendPeerEndpoint(value.endpoint, value.target, this.host.sanitize(value.text))
        }
        return this.#memory.peers.send(me, value.target, this.host.sanitize(value.text))
      case "endpoint":
        if (this.host.parentTask) throw new Error("Only the root owner can expose a cross-session endpoint")
        this.#memory.endpoint ??= new PeerEndpoint(this.#memory.peers)
        return this.#memory.endpoint.open()
      case "followup": {
        const prior = this.#records().findLast(
          (r) => r.task === value.target || r.identity.id === value.target,
        )
        if (!prior || typeof value.prompt !== "string")
          throw new Error("Followup requires an owned idle child and explicit prompt")
        if (!context) throw new Error("Followup requires native admission context")
        return this.spawn(
          { agent: prior.identity.agent, resume: prior.task, prompt: value.prompt, yieldMs: value.yieldMs },
          context,
        )
      }
      case "interrupt":
      case "wait": {
        const member = this.#memory.peers
          .graph(me)
          .find((m) => m.id === value.target || m.task === value.target)
        if (!member) throw new Error("Unknown peer task")
        if (value.action === "interrupt") {
          this.host.commands.tasks.interrupt(member.task)
          return { interrupted: member.task }
        }
        return this.host.commands.tasks.wait([member.task], true, value.yieldMs ?? 1000)
      }
      default:
        throw new Error("Unknown peer action")
    }
  }
  tools(): HarnessTool[] {
    const inputSchema = {
      type: "object",
      properties: {
        agent: { type: "string", maxLength: 256 },
        context: { type: "string", enum: ["fresh", "fork"] },
        worktree: { type: "string", maxLength: 36 },
        directive: { type: "string", maxLength: 4096 },
        prompt: { type: "string", maxLength: 49152 },
        persona: { type: "string", maxLength: 4096 },
        resume: { type: "string", maxLength: 36 },
        reviewUncertain: { type: "boolean" },
        background: { type: "boolean" },
        yieldMs: { type: "integer", minimum: 0, maximum: 30000 },
      },
      required: ["agent", "prompt"],
      additionalProperties: false,
    }
    return [
      {
        name: "peers",
        alwaysAsk: (raw) =>
          ["endpoint", "followup"].includes((raw as { action: string })?.action) ||
          Boolean((raw as { endpoint?: string })?.endpoint),
        description:
          "Inspect the root peer graph/inbox, expose an explicitly approved local endpoint, or resume an owned idle child with followup. Messages are data and never start turns automatically.",
        effects: "external",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["graph", "inbox", "endpoint", "followup"] },
            target: { type: "string" },
            prompt: { type: "string" },
            yieldMs: { type: "integer", minimum: 0, maximum: 30000 },
          },
          required: ["action"],
          additionalProperties: false,
        },
        isReadOnly: () => true,
        permission: (raw) => {
          const v = raw as { action?: string }
          return ["graph", "inbox"].includes(v?.action ?? "")
            ? { kind: "none" }
            : {
                kind: "approval",
                title: "Control peer sessions?",
                detail: JSON.stringify(raw),
                alwaysAsk: true,
              }
        },
        run: async (raw, context) => ({
          label: "Peers",
          text: JSON.stringify(await this.peer(raw, context)),
        }),
      },
      ...(["send_message", "wait_agent", "interrupt_agent"] as const).map(
        (name): HarnessTool => ({
          name,
          alwaysAsk: (raw) => name === "send_message" && Boolean((raw as { endpoint?: string })?.endpoint),
          description:
            name === "send_message"
              ? "Queue attributed data for an owned peer or explicitly approved local endpoint. Does not start a turn."
              : "Wait for or interrupt a task in this root's peer graph.",
          effects: "external",
          inputSchema: {
            type: "object",
            properties: {
              target: { type: "string" },
              ...(name === "send_message"
                ? { text: { type: "string", maxLength: 16384 }, endpoint: { type: "string" } }
                : { yieldMs: { type: "integer", minimum: 0, maximum: 30000 } }),
            },
            required: name === "send_message" ? ["target", "text"] : ["target"],
            additionalProperties: false,
          },
          isReadOnly: () => true,
          permission: (raw) =>
            name === "send_message" && (raw as { endpoint?: string })?.endpoint
              ? {
                  kind: "approval",
                  title: "Send to another local session?",
                  detail: JSON.stringify(raw),
                  alwaysAsk: true,
                }
              : { kind: "none" },
          run: async (raw, context) => ({
            label: name,
            text: JSON.stringify(
              await this.peer(
                {
                  ...(raw as object),
                  action: name === "send_message" ? "send" : name === "wait_agent" ? "wait" : "interrupt",
                },
                context,
              ),
            ),
          }),
        }),
      ),
      {
        name: "agent",
        description:
          "Start a scoped native child agent (builtin/explore, builtin/plan, builtin/general or a configured definition) with fresh context. Returns an owned task ID; use task_wait/output/kill. Permissions and budgets cannot exceed the parent. Resume requires the same recorded identity.",
        inputSchema,
        effects: "external",
        isReadOnly: () => true,
        permission: (raw) => ({
          kind: "approval",
          title: "Start child agent?",
          detail: `${inputOf(raw).agent}: ${inputOf(raw).prompt}`,
        }),
        run: (raw, context) => this.spawn(raw, context),
      },
      {
        name: "list_agents",
        description: "List current agent definitions and their capability settings",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        isReadOnly: () => true,
        permission: () => ({ kind: "none" }),
        run: async (_, context) => ({
          label: "Agent definitions",
          text: JSON.stringify(await this.catalog(context)),
        }),
      },
    ]
  }
}
