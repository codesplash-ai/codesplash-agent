import type { SessionUsageSnapshot } from "../engine.ts"
import type { SessionStateAccess } from "../session/control.ts"
import { teamName } from "./teams.ts"

export type PeerMessage = {
  id: string
  sender: string
  recipient: string
  text: string
  created: string
  external?: boolean
}
export type PeerMember = {
  id: string
  task: string
  parent: string
  agent: string
  fork?: string
  team?: string
  member?: string
  usage?: SessionUsageSnapshot
}
type Journal = { version: 1; root: string; members: PeerMember[]; messages: PeerMessage[] }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
export class PeerMailbox {
  constructor(
    readonly root: string,
    readonly state: SessionStateAccess,
  ) {}
  #read(): Journal {
    const raw = this.state.read().state.values.peers as Journal | undefined
    if (!raw) return { version: 1, root: this.root, members: [], messages: [] }
    if (
      raw.version !== 1 ||
      raw.root !== this.root ||
      !Array.isArray(raw.members) ||
      raw.members.length > 128 ||
      !Array.isArray(raw.messages) ||
      raw.messages.length > 512 ||
      Buffer.byteLength(JSON.stringify(raw)) > 768 * 1024 ||
      raw.members.some(
        (m) =>
          !m ||
          !uuid.test(m.id) ||
          !uuid.test(m.task) ||
          typeof m.parent !== "string" ||
          typeof m.agent !== "string" ||
          m.agent.length > 256 ||
          (m.team !== undefined && !uuid.test(m.team)) ||
          (m.member !== undefined && !teamName(m.member)) ||
          (m.usage !== undefined &&
            (!m.usage ||
              typeof m.usage !== "object" ||
              Object.entries(m.usage).some(([k, v]) =>
                k === "hasUnpricedUsage"
                  ? typeof v !== "boolean"
                  : ![
                      "inputTokens",
                      "outputTokens",
                      "cachedInputTokens",
                      "embeddingInputTokens",
                      "estimatedCostUsd",
                    ].includes(k) ||
                    typeof v !== "number" ||
                    !Number.isFinite(v) ||
                    v < 0,
              ))),
      ) ||
      raw.messages.some(
        (m) =>
          !m ||
          !uuid.test(m.id) ||
          typeof m.sender !== "string" ||
          m.sender.length > 256 ||
          typeof m.recipient !== "string" ||
          typeof m.text !== "string" ||
          Buffer.byteLength(m.text) > 16384 ||
          typeof m.created !== "string",
      )
    )
      throw new Error("Corrupt peer mailbox journal")
    return structuredClone(raw)
  }
  #update(change: (value: Journal) => void) {
    const before = this.state.read(),
      value = this.#read()
    change(value)
    if (Buffer.byteLength(JSON.stringify(value)) > 768 * 1024)
      throw new Error("Peer mailbox byte limit reached")
    this.state.update(before.revision, "peers/update", (state) => {
      state.values.peers = value
    })
  }
  register(member: PeerMember) {
    if (![member.id, member.task].every((v) => uuid.test(v))) throw new Error("Invalid peer identity")
    this.#update((value) => {
      const existing = value.members.find((m) => m.id === member.id)
      if (existing) {
        if (existing.team !== member.team || existing.member !== member.member)
          throw new Error("Peer membership cannot change on resume")
        Object.assign(existing, member)
      } else {
        if (value.members.length >= 128) throw new Error("Peer member limit reached")
        if (member.team && value.members.filter((m) => m.team === member.team).length >= 16)
          throw new Error("Team identity limit reached")
        if (member.team && value.members.some((m) => m.team === member.team && m.member === member.member))
          throw new Error("Team member already has an identity")
        value.members.push(member)
      }
    })
  }
  resolve(target: string): string {
    if (target === this.root || target === "root") return this.root
    const member = this.#read().members.find((m) => m.id === target || m.task === target)
    if (!member) throw new Error("Unknown peer recipient under this root")
    return member.id
  }
  visible(sender: string, target: string) {
    const me = this.resolve(sender),
      recipient = this.resolve(target)
    if (me === this.root || recipient === this.root) return true
    const members = this.#read().members
    return members.find((m) => m.id === me)?.team === members.find((m) => m.id === recipient)?.team
  }
  graph(sender = this.root) {
    const members = this.#read().members
    if (sender === this.root || sender === "root") return members
    const me = members.find((m) => m.id === sender || m.task === sender)
    if (!me) throw new Error("Unknown peer recipient under this root")
    return members.filter((m) => m.team === me.team)
  }
  addUsage(id: string, delta: SessionUsageSnapshot) {
    this.#update((v) => {
      const member = v.members.find((m) => m.id === id)
      if (!member) throw new Error("Unknown usage member")
      member.usage ??= {}
      for (const key of [
        "inputTokens",
        "outputTokens",
        "cachedInputTokens",
        "embeddingInputTokens",
        "estimatedCostUsd",
      ] as const) {
        const n = delta[key] ?? 0
        if (!Number.isFinite(n) || n < 0) throw new Error("Invalid peer usage")
        const total = (member.usage[key] ?? 0) + n
        if (!Number.isFinite(total)) throw new Error("Peer usage exceeds numeric limit")
        member.usage[key] = total
      }
      if (delta.hasUnpricedUsage) member.usage.hasUnpricedUsage = true
    })
  }
  send(sender: string, target: string, text: string, external = false) {
    if (typeof text !== "string" || !text.trim() || text.includes("\0") || Buffer.byteLength(text) > 16384)
      throw new Error("Peer messages require 1–16384 bytes without NUL")
    const recipient = this.resolve(target)
    if (!external && !this.visible(sender, recipient)) throw new Error("Peer recipient is outside this team")
    sender = external ? "external capability holder" : this.resolve(sender)
    const message: PeerMessage = {
      id: crypto.randomUUID(),
      sender,
      recipient,
      text,
      created: new Date().toISOString(),
      ...(external ? { external: true } : {}),
    }
    this.#update((value) => {
      if (
        value.messages.length >= 512 ||
        value.messages.filter((m) => m.recipient === recipient).length >= 256
      )
        throw new Error("Peer mailbox is full")
      value.messages.push(message)
    })
    return { queued: message.id, recipient }
  }
  inbox(recipient: string, take = false): PeerMessage[] {
    recipient = this.resolve(recipient)
    const selected = this.#read()
      .messages.filter((m) => m.recipient === recipient)
      .slice(0, 16)
    // Every delivery batch is bounded; remaining messages wait for later boundaries.
    if (take && selected.length)
      this.#update((value) => {
        const ids = new Set(selected.map((m) => m.id))
        value.messages = value.messages.filter((m) => !ids.has(m.id))
      })
    return selected
  }
  forget(task: string) {
    this.#update((value) => {
      const selected = value.members.find((m) => m.task === task)
      if (!selected || value.members.some((m) => m.parent === selected.id)) return
      value.members = value.members.filter((m) => m !== selected)
      value.messages = value.messages.filter((m) => m.recipient !== selected.id)
    })
  }
}

export type PeerRequest =
  | { action: "graph" | "inbox" | "endpoint" }
  | { action: "send"; target: string; text: string; endpoint?: string }
  | { action: "followup"; target: string; prompt: string; yieldMs?: number }
  | { action: "wait" | "interrupt"; target: string; yieldMs?: number }
