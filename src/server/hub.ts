import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import type { AgentEvent } from "../core/events.ts"
import { atomic, bytes, digest, directory } from "../core/session/files.ts"
import { SENSITIVE_NAME, SecretSanitizer } from "../engines/codesplash/sandbox/env-policy.ts"
import { create } from "../sdk/runtime.ts"
import type { AgentSession, CreateAgentSessionOptions, SessionRequest } from "../sdk/types.ts"
import { clean, params, publicEvent, RpcError, type RpcResponse, request, WIRE_VERSION } from "./protocol.ts"

export type Notice = { jsonrpc: "2.0"; method: string; params: unknown }
export type Connection = {
  id: string
  initialized: boolean
  retainedBytes: number
  experimental: Set<string>
  notify: (message: Notice) => void
  seen: Map<string, { fingerprint: string; result: Promise<RpcResponse | undefined> }>
}
type Lease = { id: string; connection: string; mode: "shared" | "exclusive"; expires: number }
type Thread = {
  id: string
  cwd: string
  session?: AgentSession
  events: AgentEvent[]
  cursor: number
  pending: Map<string, SessionRequest>
  leases: Map<string, Lease>
  dispose?: () => void
}
export type HubOptions = {
  root: string
  workspaces: string[]
  trustedWorkspace?: (cwd: string) => Promise<boolean>
  config?: CreateAgentSessionOptions["config"]
  createSession?: typeof create
  now?: () => number
  onError?: (error: unknown) => void
  onShare?: (
    action: "create" | "revoke",
    thread: { id: string; session: AgentSession },
    shareId?: string,
  ) => Promise<unknown>
}
export class Hub {
  readonly connections = new Map<string, Connection>()
  readonly threads = new Map<string, Thread>()
  #redactors = new Map<string, SecretSanitizer>()
  #tail: Promise<unknown> = Promise.resolve()
  #closed = false
  #roots: string[] = []
  #timer?: ReturnType<typeof setInterval>
  private constructor(readonly options: HubOptions) {}
  static async open(options: HubOptions) {
    const hub = new Hub(options)
    directory(options.root, true)
    hub.#roots = await Promise.all(options.workspaces.map((p) => realpath(p)))
    const file = join(options.root, "threads.json")
    if (existsSync(file)) {
      const entries = JSON.parse(bytes(file).toString()) as Array<{ id: string; cwd: string }>
      if (!Array.isArray(entries) || entries.length > 1000) throw new Error("Invalid daemon thread index")
      for (const entry of entries) {
        if (!/^[a-f0-9-]{36}$/.test(entry.id) || typeof entry.cwd !== "string")
          throw new Error("Invalid daemon thread index")
        await hub.workspace(entry.cwd)
        const log = join(options.root, `${entry.id}.events.json`)
        const events = existsSync(log)
          ? (JSON.parse(bytes(log, 16 * 1024 * 1024).toString()) as AgentEvent[])
          : []
        hub.threads.set(entry.id, {
          ...entry,
          events,
          cursor: events.at(-1)?.sequence ?? -1,
          pending: new Map(),
          leases: new Map(),
        })
      }
    }
    hub.#timer = setInterval(() => {
      void hub.serial(() => hub.expire()).catch(() => {})
    }, 1000)
    hub.#timer.unref()
    return hub
  }
  async workspace(cwd: string) {
    const canonical = await realpath(cwd)
    if (
      !this.#roots.some((root) => {
        const path = relative(root, canonical)
        return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../"))
      })
    )
      throw new RpcError(-32003, "Workspace is outside daemon roots")
    return canonical
  }
  connect(notify: Connection["notify"]): Connection {
    if (this.#closed || this.connections.size >= 64) throw new RpcError(-32000, "Daemon connection limit")
    const client: Connection = {
      id: randomUUID(),
      initialized: false,
      retainedBytes: 0,
      experimental: new Set(),
      notify,
      seen: new Map(),
    }
    this.connections.set(client.id, client)
    return client
  }
  serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation)
    this.#tail = next.catch(() => {})
    return next
  }
  async disconnect(client: Connection) {
    return this.serial(async () => {
      this.connections.delete(client.id)
      for (const t of this.threads.values()) {
        let removed = false
        for (const [id, lease] of t.leases)
          if (lease.connection === client.id) {
            t.leases.delete(id)
            removed = true
          }
        if (removed && !t.leases.size) await this.orphan(t)
      }
    })
  }
  async expire() {
    for (const t of this.threads.values()) {
      let removed = false
      for (const [id, lease] of t.leases)
        if (lease.expires <= this.now()) {
          t.leases.delete(id)
          removed = true
        }
      if (removed && !t.leases.size) await this.orphan(t)
    }
  }
  now() {
    return (this.options.now ?? Date.now)()
  }
  async orphan(t: Thread) {
    for (const r of t.pending.values())
      await t.session?.resolveRequest(r.id, { choice: r.requestKind === "approval" ? "decline" : "cancel" })
    t.pending.clear()
    await t.session?.interrupt()
  }
  dispatch(client: Connection, raw: unknown): Promise<RpcResponse | undefined> {
    let r: ReturnType<typeof request>
    try {
      r = request(raw)
    } catch (e) {
      return Promise.resolve(this.error(null, e))
    }
    const key = r.id === undefined ? undefined : `${typeof r.id}:${r.id}`
    const content = JSON.stringify([r.method, r.params]),
      fingerprint = digest(content)
    const prior = key && client.seen.get(key)
    if (prior)
      return prior.fingerprint === fingerprint
        ? prior.result
        : Promise.resolve(
            this.error(r.id ?? null, new RpcError(-32600, "Request ID reused with different content")),
          )
    if (client.seen.size >= 4096 || client.retainedBytes + Buffer.byteLength(content) > 16 * 1024 * 1024)
      return Promise.resolve(
        this.error(
          r.id ?? null,
          new RpcError(-32000, "Request cache limit reached; reconnect and resnapshot"),
        ),
      )
    const result = this.serial(async () => {
      try {
        if (!this.connections.has(client.id) || this.#closed) throw new RpcError(-32000, "Connection closed")
        if (client.retainedBytes > 16 * 1024 * 1024)
          throw new RpcError(-32000, "Request cache limit reached; reconnect and resnapshot")
        const p = params(r.method, r.params)
        if (r.id === undefined) throw new RpcError(-32600, "Native operations require request IDs")
        if (r.method !== "initialize" && !client.initialized) throw new RpcError(-32002, "Initialize first")
        await this.expire()
        const response = {
          jsonrpc: "2.0" as const,
          id: r.id,
          result: structuredClone(await this.invoke(client, r.method, p)),
        }
        client.retainedBytes += Buffer.byteLength(JSON.stringify(response))
        return response
      } catch (e) {
        return r.id === undefined ? undefined : this.error(r.id, e)
      }
    })
    if (key) {
      client.retainedBytes += Buffer.byteLength(content)
      client.seen.set(key, { fingerprint, result })
    }
    return result
  }
  error(id: string | number | null, error: unknown): RpcResponse {
    if (!(error instanceof RpcError)) this.options.onError?.(error)
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: error instanceof RpcError ? error.code : -32603,
        message: error instanceof RpcError ? error.message : "Operation failed",
        ...(error instanceof RpcError && error.data ? { data: clean(error.data) } : {}),
      },
    }
  }
  save() {
    atomic(
      join(this.options.root, "threads.json"),
      JSON.stringify([...this.threads.values()].map(({ id, cwd }) => ({ id, cwd }))),
    )
  }
  notice(method: string, data: unknown) {
    for (const client of this.connections.values())
      if (client.initialized) {
        try {
          client.notify({ jsonrpc: "2.0", method, params: data })
        } catch {
          /* transport owns overflow disposal */
        }
      }
  }
  record(t: Thread, event: AgentEvent) {
    if (!t.session && !this.threads.has(t.id)) t.id = event.localSessionId
    t.cursor = Math.max(t.cursor, event.sequence)
    if (event.kind === "request.opened") t.pending.set(event.payload.id, event.payload)
    if (event.kind === "request.resolved") t.pending.delete(event.payload.id)
    if (event.kind === "message.delta") {
      const key = `${t.id}:${event.payload.id}`
      let redactor = this.#redactors.get(key)
      if (!redactor) {
        if (this.#redactors.size >= 256) return
        redactor = new SecretSanitizer(
          Object.entries(process.env)
            .filter(([name, value]) => SENSITIVE_NAME.test(name) && value && value.length <= 65536)
            .map(([, value]) => value as string),
          true,
        )
        this.#redactors.set(key, redactor)
      }
      event = { ...event, payload: { ...event.payload, text: redactor.push(event.payload.text) } }
    }
    if (event.kind === "message.completed") this.#redactors.delete(`${t.id}:${event.payload.id}`)
    const projected = publicEvent(event)
    if (!projected) return
    t.events.push(projected)
    while (t.events.length > 2000 || Buffer.byteLength(JSON.stringify(t.events)) > 8 * 1024 * 1024)
      t.events.shift()
    this.notice("thread/event", { threadId: t.id, event: projected })
    if (["turn.completed", "session.status", "request.opened"].includes(event.kind))
      atomic(join(this.options.root, `${t.id}.events.json`), JSON.stringify(t.events))
  }
  async openThread(t: Thread, model?: string, resume = true) {
    const session = await (this.options.createSession ?? create)({
      cwd: t.cwd,
      model,
      config: this.options.config,
      persistence: { root: join(this.options.root, "sessions"), ...(resume ? { resume: t.id } : {}) },
      workspaceTrusted: (await this.options.trustedWorkspace?.(t.cwd)) === true,
      respond: "manual",
      resumeQueuedInput: false,
      onEvent: (event) => this.record(t, event),
    })
    t.session = session
    t.id = session.id
    return session
  }
  thread(p: Record<string, unknown>) {
    const t = this.threads.get(p.threadId as string)
    if (!t) throw new RpcError(-32004, "Unknown thread")
    return t
  }
  writer(client: Connection, t: Thread, p: Record<string, unknown>) {
    const lease = t.leases.get(p.lease as string)
    if (!lease || lease.connection !== client.id || lease.expires <= this.now())
      throw new RpcError(-32003, "Current writer lease required")
    return lease
  }
  async invoke(client: Connection, method: string, p: Record<string, unknown>): Promise<unknown> {
    if (method === "initialize") {
      if (client.initialized) throw new RpcError(-32600, "Already initialized")
      const experimental = p.experimental as string[] | undefined
      if (experimental?.some((v) => !["tui-control", "sharing"].includes(v)))
        throw new RpcError(-32602, "Unsupported experimental capability")
      client.experimental = new Set(experimental)
      client.initialized = true
      return {
        version: WIRE_VERSION,
        connectionId: client.id,
        capabilities: {
          replay: true,
          leases: ["shared", "exclusive"],
          approvals: true,
          experimental: [...client.experimental],
        },
        leaseMs: 60000,
      }
    }
    if (method === "thread/list")
      return [...this.threads.values()].map((t) => ({
        id: t.id,
        cwd: t.cwd,
        live: !!t.session,
        cursor: t.cursor,
      }))
    if (method === "thread/create") {
      if (this.threads.size >= 1000) throw new RpcError(-32000, "Thread limit reached")
      const t: Thread = {
        id: randomUUID(),
        cwd: await this.workspace(p.cwd as string),
        events: [],
        cursor: -1,
        pending: new Map(),
        leases: new Map(),
      }
      await this.openThread(t, p.model as string | undefined, false)
      this.threads.set(t.id, t)
      this.save()
      return { threadId: t.id, inputEpoch: t.session?.queue.epoch }
    }
    const t = this.thread(p)
    if (method === "thread/snapshot")
      return {
        threadId: t.id,
        cwd: t.cwd,
        inputEpoch: t.session?.queue.epoch,
        cursor: t.cursor,
        live: !!t.session,
        events: t.events.filter((e) => e.kind !== "request.opened" || t.pending.has(e.payload.id)),
        pending: clean([...t.pending.values()]),
        leases: [...t.leases.values()].map((l) => ({
          mode: l.mode,
          expires: l.expires,
          yours: l.connection === client.id,
        })),
      }
    if (method === "thread/replay") {
      const after = (p.after as number | undefined) ?? -1
      return {
        events: t.events.filter((e) => e.sequence > after).slice(0, (p.limit as number | undefined) ?? 1000),
        cursor: t.cursor,
        truncated: after < (t.events[0]?.sequence ?? 0) - 1,
      }
    }
    if (method === "thread/resume") {
      if (!t.session) await this.openThread(t)
      return { threadId: t.id, inputEpoch: t.session?.queue.epoch }
    }
    if (method === "lease/acquire") {
      if (p.steal) {
        await this.orphan(t)
        t.leases.clear()
        this.notice("lease/revoked", { threadId: t.id })
      }
      const mode = p.mode as Lease["mode"]
      if ([...t.leases.values()].some((l) => l.mode === "exclusive" || mode === "exclusive"))
        throw new RpcError(-32009, "Writer lease conflict; explicit steal required")
      if (t.leases.size >= 16) throw new RpcError(-32000, "Writer limit reached")
      const lease: Lease = { id: randomUUID(), connection: client.id, mode, expires: this.now() + 60000 }
      t.leases.set(lease.id, lease)
      return { lease: lease.id, expires: lease.expires }
    }
    if (method === "fuzzyFileSearch")
      return this.search(t, p.query as string, (p.limit as number | undefined) ?? 40)
    const lease = this.writer(client, t, p)
    if (method === "lease/renew") {
      lease.expires = this.now() + 60000
      return { expires: lease.expires }
    }
    if (method === "lease/release") {
      t.leases.delete(lease.id)
      if (!t.leases.size) await this.orphan(t)
      return {}
    }
    if (!t.session) throw new RpcError(-32004, "Resume thread before writing")
    if (method === "turn/start")
      return t.session.submit(
        { text: p.text as string, literal: p.literal as boolean | undefined },
        "follow-up",
        p.submissionId as string,
      )
    if (method === "turn/interrupt") {
      await t.session.interrupt()
      return {}
    }
    if (method === "request/respond") {
      const r = t.pending.get(p.requestId as string)
      if (!r || !r.choices.includes(p.choice as string))
        throw new RpcError(-32602, "Request is stale or choice invalid")
      await t.session.resolveRequest(r.id, { choice: p.choice as string, data: p.data })
      t.pending.delete(r.id)
      return {}
    }
    if (method === "thread/close") {
      await t.session.close()
      t.session = undefined
      t.pending.clear()
      t.leases.clear()
      return {}
    }
    if (method === "tui/control") {
      if (!client.experimental.has("tui-control")) throw new RpcError(-32003, "Negotiate tui-control first")
      this.notice("tui/control", clean({ threadId: t.id, action: p.action, text: p.text }))
      return { delivered: true }
    }
    if (method.startsWith("share/")) {
      if (!client.experimental.has("sharing") || !this.options.onShare)
        throw new RpcError(-32003, "Sharing is disabled")
      return this.options.onShare(
        method === "share/create" ? "create" : "revoke",
        { id: t.id, session: t.session },
        p.shareId as string | undefined,
      )
    }
    throw new RpcError(-32601, "Unknown method")
  }
  async search(t: Thread, query: string, limit: number) {
    const result: Array<{ path: string; score: number }> = []
    let count = 0
    const q = query.toLowerCase()
    for await (const path of new Bun.Glob("**/*").scan({
      cwd: t.cwd,
      onlyFiles: true,
      followSymlinks: false,
      dot: false,
    })) {
      if (++count > 50000) break
      if (path.split("/").some((v) => ["node_modules", "dist", "vendor"].includes(v))) continue
      let cursor = 0
      for (const c of path.toLowerCase()) if (c === q[cursor]) cursor++
      if (cursor === q.length)
        result.push({ path, score: path.length + (path.toLowerCase().includes(q) ? 0 : 1000) })
    }
    return result.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path)).slice(0, limit)
  }
  async close() {
    this.#closed = true
    clearInterval(this.#timer)
    await this.#tail
    for (const t of this.threads.values()) {
      await t.session?.close()
      atomic(join(this.options.root, `${t.id}.events.json`), JSON.stringify(t.events))
    }
    this.connections.clear()
    this.#redactors.clear()
  }
}
