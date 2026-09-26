import { randomUUID } from "node:crypto"
import type { EngineSession } from "../core/engine.ts"
import type { AgentEvent } from "../core/events.ts"
import { EventFeed } from "../sdk/event-feed.ts"
import type { Notice } from "./hub.ts"
import type { Method } from "./protocol.ts"

export class DaemonClient {
  connection?: string
  #id = 0
  constructor(
    readonly url: string,
    readonly token: string,
  ) {
    const parsed = new URL(url)
    if (
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/" ||
      !(
        parsed.protocol === "https:" ||
        (parsed.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(parsed.hostname))
      )
    )
      throw new Error("Daemon URL must be HTTPS or loopback HTTP, without credentials or path")
  }
  headers() {
    return {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
      ...(this.connection ? { "x-codesplash-connection": this.connection } : {}),
    }
  }
  async rpc<T = Record<string, unknown>>(method: Method, params = {}, signal?: AbortSignal): Promise<T> {
    const response = await fetch(new URL("rpc", this.url), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.#id, method, params }),
      signal,
    })
    if (!response.ok) throw new Error(`Daemon HTTP ${response.status}`)
    const value = await response.json()
    if (value.error) throw new Error(value.error.message)
    if (method === "initialize") this.connection = value.result.connectionId
    return value.result as T
  }
  async initialize(experimental: string[] = []) {
    return this.rpc("initialize", { version: 1, client: "codesplash", experimental })
  }
  async *events(signal: AbortSignal): AsyncGenerator<Notice> {
    const response = await fetch(new URL("events", this.url), { headers: this.headers(), signal })
    if (!response.ok || !response.body) throw new Error(`Daemon stream HTTP ${response.status}`)
    const reader = response.body.getReader(),
      decoder = new TextDecoder()
    let pending = ""
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) throw new Error("Daemon stream disconnected; reconnect and replay")
        pending += decoder.decode(next.value, { stream: true })
        if (pending.length > 8 * 1024 * 1024) throw new Error("Daemon stream frame overflow")
        let end = pending.indexOf("\n\n")
        while (end >= 0) {
          const frame = pending.slice(0, end)
          pending = pending.slice(end + 2)
          if (frame.startsWith("data: ")) yield JSON.parse(frame.slice(6)) as Notice
          end = pending.indexOf("\n\n")
        }
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
  }
  async close() {
    if (this.connection)
      await fetch(new URL("connection", this.url), { method: "DELETE", headers: this.headers() }).catch(
        () => {},
      )
    this.connection = undefined
  }
}
export async function attachSession(
  client: DaemonClient,
  threadId: string,
  mode: "reader" | "shared" | "exclusive" = "shared",
  steal = false,
): Promise<EngineSession> {
  await client.initialize(["tui-control", "sharing"])
  if (mode !== "reader") await client.rpc("thread/resume", { threadId })
  let lease: string | undefined
  if (mode !== "reader")
    lease = (await client.rpc("lease/acquire", { threadId, mode, steal })).lease as string
  const lifetime = new AbortController(),
    feed = new EventFeed(() => {})
  let composer: ((text: string) => boolean) | undefined,
    localSequence = 0,
    epoch = "",
    closing = false
  const pending: AgentEvent[] = [],
    seen = new Set<number>()
  let buffering = true
  const emit = (event: AgentEvent) => {
    if (seen.has(event.sequence)) return
    seen.add(event.sequence)
    if (seen.size > 4096) seen.delete(seen.values().next().value!)
    feed.push({ ...event, sequence: localSequence++ })
  }
  const control = (text: string) =>
    feed.push({
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      engine: "codesplash",
      localSessionId: threadId,
      sequence: localSequence++,
      kind: "warning",
      payload: { message: text },
    })
  let ready: () => void = () => {},
    failReady: (e: unknown) => void = () => {}
  const connected = new Promise<void>((resolve, reject) => {
    ready = resolve
    failReady = reject
  })
  const pump = (async () => {
    try {
      for await (const notice of client.events(lifetime.signal)) {
        const p = notice.params as { threadId?: string; event?: AgentEvent; action?: string; text?: string }
        if (notice.method === "stream/ready") ready()
        if (p.threadId !== threadId) continue
        if (notice.method === "thread/event" && p.event) {
          if (buffering) pending.push(p.event)
          else emit(p.event)
        }
        if (notice.method === "lease/revoked") {
          lease = undefined
          control("Writer lease revoked. Reattach to request a new lease.")
        }
        if (notice.method === "tui/control") {
          if (p.action === "prompt") composer?.(p.text ?? "")
          else control(p.text ?? "")
        }
      }
    } catch (e) {
      failReady(e)
      if (!closing) {
        control("Connection lost; reattach to replay. No actions are resubmitted.")
        feed.finish(e instanceof Error ? e : new Error(String(e)))
      }
    }
  })()
  try {
    await connected
    const snapshot = await client.rpc<{ events: AgentEvent[]; inputEpoch: string }>("thread/snapshot", {
      threadId,
    })
    epoch = snapshot.inputEpoch
    for (const event of [...snapshot.events, ...pending].sort((a, b) => a.sequence - b.sequence)) emit(event)
    pending.length = 0
    buffering = false
  } catch (e) {
    closing = true
    lifetime.abort()
    await client.close()
    await pump
    throw e
  }
  const writer = () => {
    if (!lease) throw new Error("A writer lease is required; reattach with --shared or --exclusive")
    return { threadId, lease }
  }
  const renew = setInterval(() => {
    if (lease)
      void client.rpc("lease/renew", { threadId, lease }).catch(() => {
        lease = undefined
        control("Writer lease expired")
      })
  }, 20000)
  renew.unref()
  return {
    localSessionId: threadId,
    nativeSessionId: threadId,
    capabilities: {
      nativeTranscript: false,
      approvals: mode !== "reader",
      interrupt: mode !== "reader",
      resume: true,
      usage: "estimated-cost",
      surface: "native",
    },
    events: feed,
    async send(input) {
      if (input.images?.length || input.files?.length)
        throw new Error("Attach currently accepts text and explicit editor context")
      await client.rpc("turn/start", {
        ...writer(),
        text: input.text,
        literal: input.literal,
        submissionId: `${epoch}.${randomUUID()}`,
      })
    },
    async resolveRequest(requestId, decision) {
      await client.rpc("request/respond", { ...writer(), requestId, ...decision })
    },
    async interrupt() {
      await client.rpc("turn/interrupt", writer())
    },
    async completeFileMention(query) {
      return (await client.rpc<Array<{ path: string }>>("fuzzyFileSearch", { threadId, query })).map(
        (v) => v.path,
      )
    },
    setExtensionComposer(callback) {
      composer = callback
    },
    async runCommand(command) {
      if (command === "/share") return client.rpc("share/create", writer())
      if (command.startsWith("/unshare "))
        return client.rpc("share/revoke", { ...writer(), shareId: command.slice(9).trim() })
      throw new Error("This command is unavailable over attach")
    },
    async close() {
      if (closing) return
      closing = true
      clearInterval(renew)
      lifetime.abort()
      await client.close()
      await pump
      feed.finish()
      seen.clear()
    },
  }
}
