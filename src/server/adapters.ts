import { randomUUID } from "node:crypto"
import type { AgentEvent } from "../core/events.ts"
import type { SessionRequest } from "../sdk/types.ts"
import type { Connection, Hub, Notice } from "./hub.ts"
import { clean, MAX_FRAME, RpcError, request } from "./protocol.ts"
import { ndjson } from "./transport.ts"

/** Dialect translation only: native Hub remains the session, lease and approval owner. */
export class Adapter {
  readonly client: Connection
  #initialized = false
  #ready = false
  #elicitation = false
  #toolCalls = new Set<string>()
  #sequence = 0
  #leases = new Map<string, string>()
  #epochs = new Map<string, string>()
  #callbacks = new Map<string, { resolve: (value: unknown) => void; timer: ReturnType<typeof setTimeout> }>()
  #inflight = new Map<string | number, string>()
  #seen = new Map<string, { fingerprint: string; response: Promise<unknown> }>()
  #renew: ReturnType<typeof setInterval>
  constructor(
    readonly hub: Hub,
    readonly dialect: "acp" | "mcp",
    readonly send: (value: unknown) => void,
    readonly cwd: string,
  ) {
    this.client = hub.connect((n) => this.notice(n))
    this.#renew = setInterval(() => {
      for (const [threadId, lease] of this.#leases)
        void this.rpc("lease/renew", { threadId, lease }).catch(() => this.#leases.delete(threadId))
    }, 20000)
    this.#renew.unref()
  }
  async rpc(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const response = await this.hub.dispatch(this.client, {
      jsonrpc: "2.0",
      id: ++this.#sequence,
      method,
      params,
    })
    if (!response || "error" in response)
      throw new RpcError(
        response && "error" in response ? response.error.code : -32603,
        response && "error" in response ? response.error.message : "No response",
      )
    return response.result as Record<string, unknown>
  }
  callback(method: string, params: unknown): Promise<unknown> {
    if (this.#callbacks.size >= 32) return Promise.resolve(undefined)
    const id = `server:${randomUUID()}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#callbacks.delete(id)
        resolve(undefined)
      }, 60000)
      this.#callbacks.set(id, { resolve, timer })
      this.send({ jsonrpc: "2.0", id, method, params })
    })
  }
  notice(notice: Notice) {
    if (notice.method !== "thread/event") return
    const { threadId, event } = notice.params as { threadId: string; event: AgentEvent }
    if (!this.#leases.has(threadId)) return
    if (event.kind === "request.opened") {
      void this.approve(threadId, event.payload).catch(() => {})
      return
    }
    if (this.dialect !== "acp") return
    const update =
      event.kind === "message.delta"
        ? { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.payload.text } }
        : event.kind === "item.updated"
          ? {
              sessionUpdate: this.#toolCalls.has(event.payload.id) ? "tool_call_update" : "tool_call",
              toolCallId: event.payload.id,
              title: event.payload.label,
              status: event.payload.status === "running" ? "in_progress" : event.payload.status,
              content: event.payload.output
                ? [{ type: "content", content: { type: "text", text: event.payload.output } }]
                : [],
            }
          : event.kind === "plan.updated"
            ? {
                sessionUpdate: "plan",
                entries: event.payload.steps.map((s) => ({
                  content: s.text,
                  priority: "medium",
                  status: s.completed ? "completed" : "pending",
                })),
              }
            : undefined
    if (event.kind === "item.updated") {
      if (this.#toolCalls.size > 4096) this.#toolCalls.clear()
      this.#toolCalls.add(event.payload.id)
    }
    if (update)
      this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: threadId, update } })
  }
  async approve(threadId: string, r: SessionRequest) {
    let choice = r.requestKind === "approval" ? "decline" : "cancel"
    const choices = r.choices.filter((choice) =>
      ["accept", "approve", "decline", "deny", "cancel"].includes(choice),
    )
    // User-input forms need native form semantics; never misrepresent them as boolean approvals.
    if (r.requestKind === "approval") {
      if (this.dialect === "acp") {
        const response = (await this.callback("session/request_permission", {
          sessionId: threadId,
          toolCall: {
            toolCallId: r.id,
            title: r.title,
            status: "pending",
            kind: "other",
            content: [{ type: "content", content: { type: "text", text: r.detail } }],
          },
          options: choices.map((c) => ({
            optionId: c,
            name: c,
            kind: ["accept", "approve"].includes(c) ? "allow_once" : "reject_once",
          })),
        })) as { outcome?: { outcome?: string; optionId?: string } } | undefined
        if (response?.outcome?.outcome === "selected" && choices.includes(response.outcome.optionId ?? ""))
          choice = response.outcome.optionId as string
      } else if (this.#elicitation) {
        const response = (await this.callback("elicitation/create", {
          mode: "form",
          message: `${r.title}\n${r.detail}`,
          requestedSchema: {
            type: "object",
            properties: {
              choice: { type: "string", enum: choices },
            },
            required: ["choice"],
          },
        })) as { action?: string; content?: { choice?: string } } | undefined
        if (response?.action === "accept" && choices.includes(response.content?.choice ?? ""))
          choice = response.content?.choice as string
      }
    }
    const lease = this.#leases.get(threadId)
    if (lease) await this.rpc("request/respond", { threadId, lease, requestId: r.id, choice })
  }
  async handle(raw: unknown) {
    if (!raw || typeof raw !== "object") {
      this.send(this.hub.error(null, new RpcError(-32600, "Invalid request")))
      return
    }
    const value = raw as Record<string, unknown>
    if (!value.method && value.jsonrpc === "2.0" && typeof value.id === "string") {
      const pending = this.#callbacks.get(value.id)
      if (pending) {
        clearTimeout(pending.timer)
        this.#callbacks.delete(value.id)
        pending.resolve(value.result)
      }
      return
    }
    let r: ReturnType<typeof request>
    try {
      r = request(value)
    } catch (e) {
      this.send(this.hub.error(null, e))
      return
    }
    if (r.method === "notifications/initialized") {
      if (this.#initialized) this.#ready = true
      return
    }
    const p =
      r.params && typeof r.params === "object" && !Array.isArray(r.params)
        ? (r.params as Record<string, unknown>)
        : {}
    if (r.method === "session/cancel" || r.method === "notifications/cancelled") {
      const id = this.dialect === "acp" ? p.sessionId : this.#inflight.get(p.requestId as string | number)
      if (typeof id === "string" && this.#leases.has(id))
        await this.rpc("turn/interrupt", { threadId: id, lease: this.#leases.get(id) })
      return
    }
    if (r.id === undefined) return
    const key = `${typeof r.id}:${r.id}`,
      fingerprint = JSON.stringify([r.method, p]),
      prior = this.#seen.get(key)
    if (prior) {
      this.send(
        prior.fingerprint === fingerprint
          ? await prior.response
          : this.hub.error(r.id, new RpcError(-32600, "Request ID reused")),
      )
      return
    }
    if (this.#seen.size >= 2048 || this.#inflight.size >= 16) {
      this.send(this.hub.error(r.id, new RpcError(-32000, "Adapter request limit")))
      return
    }
    const id = r.id
    const response = (async () => {
      try {
        return { jsonrpc: "2.0", id, result: await this.invoke(r.method, p, id) }
      } catch (e) {
        return this.hub.error(id, e)
      }
    })()
    this.#seen.set(key, { fingerprint, response })
    this.send(await response)
  }
  async own(threadId: string) {
    if (!this.#leases.has(threadId))
      this.#leases.set(
        threadId,
        (await this.rpc("lease/acquire", { threadId, mode: "exclusive" })).lease as string,
      )
    this.#epochs.set(threadId, (await this.rpc("thread/snapshot", { threadId })).inputEpoch as string)
    return threadId
  }
  async invoke(method: string, p: Record<string, unknown>, id: string | number): Promise<unknown> {
    if (method === "initialize") {
      if (this.#initialized) throw new RpcError(-32600, "Already initialized")
      if (this.dialect === "acp" && p.protocolVersion !== 1)
        throw new RpcError(-32602, "ACP protocol version 1 required")
      await this.rpc("initialize", { version: 1, client: this.dialect })
      this.#initialized = true
      this.#ready = this.dialect === "acp"
      const capabilities = p.capabilities as { elicitation?: { form?: unknown } } | undefined
      this.#elicitation =
        !!capabilities?.elicitation &&
        (capabilities.elicitation.form !== undefined || !Object.keys(capabilities.elicitation).length)
      return this.dialect === "acp"
        ? {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } },
            agentInfo: { name: "codesplash", version: "0.1.4" },
            authMethods: [],
          }
        : {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "codesplash", version: "0.1.4" },
            instructions:
              "Native permissions apply. Without form elicitation, approval requests are declined.",
          }
    }
    if (!this.#ready) throw new RpcError(-32002, "Initialize first")
    if (method === "ping") return {}
    if (this.dialect === "acp" && ["session/new", "session/load"].includes(method)) {
      if (
        typeof p.cwd !== "string" ||
        (p.mcpServers !== undefined && (!Array.isArray(p.mcpServers) || p.mcpServers.length))
      )
        throw new RpcError(-32602, "cwd required; client-supplied MCP servers are not supported")
      const cwd = await this.hub.workspace(p.cwd)
      if (
        method === "session/load" &&
        (await this.rpc("thread/snapshot", { threadId: p.sessionId })).cwd !== cwd
      )
        throw new RpcError(-32602, "Session workspace does not match cwd")
      const t =
        method === "session/new"
          ? await this.rpc("thread/create", { cwd: p.cwd })
          : await this.rpc("thread/resume", { threadId: p.sessionId })
      const sessionId = await this.own(t.threadId as string)
      if (method === "session/load") {
        const snapshot = await this.rpc("thread/snapshot", { threadId: sessionId })
        for (const event of snapshot.events as AgentEvent[])
          if (event.kind === "user.message" || event.kind === "message.completed")
            this.send({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId,
                update: {
                  sessionUpdate: event.kind === "user.message" ? "user_message_chunk" : "agent_message_chunk",
                  content: { type: "text", text: event.payload.text ?? "" },
                },
              },
            })
      }
      return method === "session/new" ? { sessionId } : {}
    }
    if (this.dialect === "mcp" && method === "tools/list")
      return {
        tools: [
          {
            name: "codesplash",
            description: "Start a native coding session in an operator-authorized workspace",
            inputSchema: {
              type: "object",
              properties: { prompt: { type: "string" }, cwd: { type: "string" } },
              required: ["prompt"],
              additionalProperties: false,
            },
          },
          {
            name: "codesplash-reply",
            description: "Continue an existing native coding session",
            inputSchema: {
              type: "object",
              properties: { prompt: { type: "string" }, sessionId: { type: "string" } },
              required: ["prompt", "sessionId"],
              additionalProperties: false,
            },
          },
        ],
      }
    let threadId: string, text: string
    if (this.dialect === "acp" && method === "session/prompt") {
      if (
        typeof p.sessionId !== "string" ||
        !this.#leases.has(p.sessionId) ||
        !Array.isArray(p.prompt) ||
        p.prompt.length > 128
      )
        throw new RpcError(-32602, "Invalid session or prompt")
      threadId = p.sessionId
      text = p.prompt
        .map((block: Record<string, unknown>) => {
          if (block?.type === "text" && typeof block.text === "string") return block.text
          if (block?.type === "resource_link" && typeof block.uri === "string")
            return `Referenced resource (untrusted): ${block.uri}`
          if (
            block?.type === "resource" &&
            block.resource &&
            typeof (block.resource as Record<string, unknown>).text === "string"
          )
            return `Embedded resource (untrusted):\n${(block.resource as Record<string, unknown>).text}`
          throw new RpcError(-32602, "Unsupported prompt content")
        })
        .join("\n")
    } else if (this.dialect === "mcp" && method === "tools/call") {
      const a = p.arguments as Record<string, unknown> | undefined
      if (
        !a ||
        typeof a.prompt !== "string" ||
        !["codesplash", "codesplash-reply"].includes(p.name as string) ||
        Object.keys(a).some((k) => !["prompt", "cwd", "sessionId"].includes(k))
      )
        throw new RpcError(-32602, "Invalid tool arguments")
      text = a.prompt
      if (p.name === "codesplash")
        threadId = await this.own(
          (await this.rpc("thread/create", { cwd: a.cwd ?? this.cwd })).threadId as string,
        )
      else {
        if (typeof a.sessionId !== "string" || !this.#leases.has(a.sessionId))
          throw new RpcError(-32602, "Session is not owned by this client")
        threadId = a.sessionId
      }
    } else throw new RpcError(-32601, "Unsupported method")
    this.#inflight.set(id, threadId)
    try {
      const snapshot = await this.rpc("thread/snapshot", { threadId }),
        after = snapshot.cursor as number
      const ack = await this.rpc("turn/start", {
        threadId,
        lease: this.#leases.get(threadId),
        text,
        submissionId: `${this.#epochs.get(threadId)}.${randomUUID()}`,
        literal: true,
      })
      const result = await this.hub.threads.get(threadId)!.session!.waitForInput(ack.id as string)
      if (this.dialect === "acp")
        return {
          stopReason:
            result.status === "completed"
              ? "end_turn"
              : result.status === "cancelled"
                ? "cancelled"
                : "refusal",
        }
      const replay = await this.rpc("thread/replay", { threadId, after })
      const output = (replay.events as AgentEvent[])
        .filter((e) => e.kind === "message.completed")
        .map((e) => (e.kind === "message.completed" ? (e.payload.text ?? "") : ""))
        .join("\n")
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ sessionId: threadId, status: result.status, text: output }),
          },
        ],
        isError: result.status !== "completed",
      }
    } finally {
      this.#inflight.delete(id)
    }
  }
  async close() {
    clearInterval(this.#renew)
    for (const p of this.#callbacks.values()) {
      clearTimeout(p.timer)
      p.resolve(undefined)
    }
    this.#callbacks.clear()
    await this.hub.disconnect(this.client)
  }
}
export async function adapterStdio(hub: Hub, dialect: "acp" | "mcp", cwd: string) {
  let tail = Promise.resolve(),
    queued = 0
  const send = (value: unknown) => {
    const line = `${JSON.stringify(clean(value))}\n`
    queued += Buffer.byteLength(line)
    if (queued > 8 * MAX_FRAME) {
      process.stdin.destroy(new Error("Adapter output overflow"))
      return
    }
    tail = tail.then(
      () =>
        new Promise<void>((resolve, reject) =>
          process.stdout.write(line, (e) => {
            queued -= Buffer.byteLength(line)
            e ? reject(e) : resolve()
          }),
        ),
    )
    void tail.catch((e) => process.stdin.destroy(e))
  }
  const adapter = new Adapter(hub, dialect, send, cwd),
    active = new Set<Promise<void>>()
  try {
    for await (const frame of ndjson(process.stdin)) {
      if (active.size >= 32) throw new Error("Too many outstanding adapter requests")
      const work = adapter.handle(frame)
      active.add(work)
      void work.finally(() => active.delete(work)).catch(() => {})
    }
  } finally {
    await adapter.close()
    await Promise.allSettled(active)
    await tail
    await hub.close()
  }
}
