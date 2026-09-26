import type { ChatBridge } from "./bridge.ts"
export type SlackPolicy = { team: string; channels: string[]; users: string[] }
export class SlackSocketBridge {
  #socket?: WebSocket
  #closing = false
  constructor(
    readonly options: {
      appToken: string
      botToken: string
      policy: SlackPolicy
      bridge: ChatBridge
      fetcher?: typeof fetch
      socket?: (url: string) => WebSocket
    },
  ) {}
  async envelope(raw: unknown, ack: (value: unknown) => void) {
    const envelope = raw as {
      envelope_id?: string
      type?: string
      payload?: {
        event_id?: string
        team_id?: string
        event?: {
          type?: string
          bot_id?: string
          subtype?: string
          user?: string
          channel?: string
          ts?: string
          thread_ts?: string
          text?: string
        }
      }
    }
    if (!envelope || typeof envelope.envelope_id !== "string" || envelope.envelope_id.length > 256) return
    ack({ envelope_id: envelope.envelope_id })
    const payload = envelope.payload,
      e = payload?.event,
      policy = this.options.policy
    if (
      envelope.type !== "events_api" ||
      payload?.team_id !== policy.team ||
      typeof payload.event_id !== "string" ||
      !e ||
      e.type !== "app_mention" ||
      e.bot_id ||
      e.subtype ||
      !policy.channels.includes(e.channel ?? "") ||
      !policy.users.includes(e.user ?? "") ||
      typeof e.text !== "string" ||
      e.text.length > 30000 ||
      !/^\d+\.\d+$/.test(e.thread_ts ?? e.ts ?? "")
    )
      return
    const thread = e.thread_ts ?? (e.ts as string),
      channel = e.channel as string
    await this.options.bridge.deliver(
      {
        delivery: `slack:${policy.team}:${payload.event_id}`,
        conversation: `slack:${policy.team}:${channel}:${thread}`,
        text: e.text,
        provenance: `Slack ${policy.team}/${channel}/${thread} (${e.user})`,
      },
      async (text) => {
        const response = await (this.options.fetcher ?? fetch)("https://slack.com/api/chat.postMessage", {
          method: "POST",
          redirect: "error",
          headers: { authorization: `Bearer ${this.options.botToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            channel,
            thread_ts: thread,
            text: text.replace(/<([@!][^>]+)>/g, "[$1]"),
            parse: "none",
            link_names: false,
            unfurl_links: false,
            unfurl_media: false,
          }),
        })
        if (!response.ok || !(await response.json()).ok) throw new Error("Slack reply failed")
      },
    )
  }
  async run(signal: AbortSignal) {
    let backoff = 1000
    while (!signal.aborted && !this.#closing) {
      try {
        const response = await (this.options.fetcher ?? fetch)(
          "https://slack.com/api/apps.connections.open",
          {
            method: "POST",
            redirect: "error",
            headers: { authorization: `Bearer ${this.options.appToken}` },
            signal,
          },
        )
        const value = await response.json(),
          url = new URL(value.url)
        if (
          !response.ok ||
          !value.ok ||
          url.protocol !== "wss:" ||
          !url.hostname.endsWith(".slack.com") ||
          url.username ||
          url.password
        )
          throw new Error("Slack Socket Mode connection refused")
        await new Promise<void>((resolve, reject) => {
          const socket = (this.options.socket ?? ((url) => new WebSocket(url)))(url.href)
          this.#socket = socket
          const stop = () => socket.close()
          signal.addEventListener("abort", stop, { once: true })
          socket.addEventListener("open", () => {
            backoff = 1000
          })
          socket.addEventListener("message", (event) => {
            if (typeof event.data !== "string" || Buffer.byteLength(event.data) > 1024 * 1024) {
              socket.close()
              return
            }
            try {
              const value = JSON.parse(event.data)
              if (value.type === "disconnect") socket.close()
              else void this.envelope(value, (ack) => socket.send(JSON.stringify(ack))).catch(() => {})
            } catch {
              socket.close()
            }
          })
          socket.addEventListener(
            "close",
            () => {
              signal.removeEventListener("abort", stop)
              resolve()
            },
            { once: true },
          )
          socket.addEventListener(
            "error",
            () => {
              signal.removeEventListener("abort", stop)
              socket.close()
              reject(new Error("Slack socket failed"))
            },
            { once: true },
          )
        })
      } catch {
        if (signal.aborted || this.#closing) break
      }
      if (signal.aborted || this.#closing) break
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          signal.removeEventListener("abort", done)
          resolve()
        }
        const timer = setTimeout(done, backoff)
        signal.addEventListener("abort", done, { once: true })
      })
      backoff = Math.min(backoff * 2, 30000)
    }
  }
  close() {
    this.#closing = true
    this.#socket?.close()
  }
}
