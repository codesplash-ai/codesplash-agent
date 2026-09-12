import { timingSafeEqual } from "node:crypto"
import { chmodSync, lstatSync, unlinkSync } from "node:fs"
import { createConnection, createServer, type Socket } from "node:net"
import { dirname, join } from "node:path"
import { atomic, directory, hostPath, json, lease } from "../session/files.ts"
import type { PeerMailbox } from "./peers.ts"

type Descriptor = { version: 1; id: string; root: string; socket: string; token: string }
const base = () => hostPath(join("/tmp", `cs-peers-${process.getuid?.() ?? "user"}`))
function owned(path: string, socket = false) {
  directory(dirname(path))
  const info = lstatSync(path)
  if (
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    info.isSymbolicLink() ||
    (socket ? !info.isSocket() : !info.isFile() || info.nlink !== 1)
  )
    throw new Error("Peer endpoint must be a private owned file/socket")
  return info
}
function descriptor(path: string): Descriptor {
  if (dirname(path) !== base() || !/^[a-f0-9-]{36}\.json$/.test(path.slice(dirname(path).length + 1)))
    throw new Error("Peer endpoint must use the native private registry")
  owned(path)
  const value = json<Descriptor>(path, 4096)
  if (
    value.version !== 1 ||
    path !== join(base(), `${value.id}.json`) ||
    value.socket !== join(base(), `${value.id}.sock`) ||
    !/^[a-f0-9]{64}$/.test(value.token) ||
    typeof value.root !== "string" ||
    value.root.length > 128
  )
    throw new Error("Invalid peer endpoint descriptor")
  owned(value.socket, true)
  return value
}
export class PeerEndpoint {
  readonly id = crypto.randomUUID()
  readonly path = join(base(), `${this.id}.json`)
  #server?: ReturnType<typeof createServer>
  #release?: () => void
  readonly #connections = new Set<Socket>()
  #socketIdentity?: { ino: number; dev: number }
  #fileIdentity?: { ino: number; dev: number }
  constructor(
    readonly mailbox: PeerMailbox,
    readonly view?: (team: string) => unknown,
  ) {}
  async open() {
    if (this.#server) return { endpoint: this.path, root: this.mailbox.root }
    directory(base(), true)
    const info = lstatSync(base())
    if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
      throw new Error("Peer registry is not private")
    this.#release = lease(base(), `${this.id}.lease`)
    const token = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`
    const socketPath = join(base(), `${this.id}.sock`)
    this.#server = createServer((socket) => {
      if (this.#connections.size >= 16) {
        socket.destroy()
        return
      }
      this.#connections.add(socket)
      const expires = setTimeout(() => socket.destroy(), 5000)
      socket.once("close", () => clearTimeout(expires))
      socket.on("error", () => {})
      socket.once("close", () => this.#connections.delete(socket))
      let buffer = Buffer.alloc(0),
        handled = false
      socket.on("data", (data) => {
        if (handled) return socket.destroy()
        if (buffer.length + data.length > 65536) return socket.destroy()
        buffer = Buffer.concat([buffer, data])
        const end = buffer.indexOf(10)
        if (end < 0) return
        handled = true
        try {
          if (end !== buffer.length - 1) throw new Error("Invalid framing")
          const message = JSON.parse(buffer.subarray(0, end).toString()) as {
            version: number
            token: string
            target: string
            text: string
            query?: string
          }
          if (
            message.version !== 1 ||
            typeof message.token !== "string" ||
            !/^[a-f0-9]{64}$/.test(message.token) ||
            !timingSafeEqual(Buffer.from(token), Buffer.from(message.token))
          )
            throw new Error("Authentication failed")
          if (this.view) {
            if (
              typeof message.query !== "string" ||
              message.query.length > 128 ||
              message.target !== undefined ||
              message.text !== undefined
            )
              throw new Error("Read-only endpoint")
            const reply = JSON.stringify({ ok: true, view: this.view(message.query) })
            if (Buffer.byteLength(reply) > 65535) throw new Error("View exceeds frame limit")
            socket.end(`${reply}\n`)
          } else {
            if (message.query !== undefined) throw new Error("Message endpoint has no view")
            const result = this.mailbox.send("external capability holder", message.target, message.text, true)
            socket.end(`${JSON.stringify({ ok: true, ...result })}\n`)
          }
        } catch {
          socket.end('{"ok":false,"error":"Peer message rejected"}\n')
        }
      })
    })
    this.#server.on("error", () => {
      for (const socket of this.#connections) socket.destroy()
    })
    try {
      await new Promise<void>((resolve, reject) => {
        this.#server!.once("error", reject)
        this.#server!.listen(socketPath, () => {
          this.#server!.off("error", reject)
          resolve()
        })
      })
      chmodSync(socketPath, 0o600)
      this.#socketIdentity = owned(socketPath, true)
      atomic(
        this.path,
        JSON.stringify({
          version: 1,
          id: this.id,
          root: this.mailbox.root,
          socket: socketPath,
          token,
        } satisfies Descriptor),
      )
      this.#fileIdentity = owned(this.path)
      return { endpoint: this.path, root: this.mailbox.root }
    } catch (error) {
      await this.close()
      throw error
    }
  }
  async close() {
    for (const socket of this.#connections) socket.destroy()
    if (this.#server?.listening) await new Promise<void>((resolve) => this.#server!.close(() => resolve()))
    this.#server = undefined
    for (const [path, identity] of [
      [this.path, this.#fileIdentity],
      [join(base(), `${this.id}.sock`), this.#socketIdentity],
    ] as const) {
      try {
        const info = lstatSync(path)
        if (identity && info.ino === identity.ino && info.dev === identity.dev) unlinkSync(path)
      } catch {}
    }
    this.#release?.()
    this.#release = undefined
    try {
      const lock = join(base(), `.${this.id}.lease.sqlite`)
      owned(lock)
      unlinkSync(lock)
    } catch {}
  }
}
export async function sendPeerEndpoint(path: string, target: string, text: string): Promise<unknown> {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text) > 16384 ||
    typeof target !== "string" ||
    target.length > 128
  )
    throw new Error("Invalid peer message")
  return requestPeer(path, { target, text }, 4096)
}
export async function queryPeerEndpoint(path: string, team: string): Promise<unknown> {
  if (typeof team !== "string" || team.length > 128) throw new Error("Invalid view request")
  const value = (await requestPeer(path, { query: team }, 65536)) as { view: unknown }
  return value.view
}
async function requestPeer(path: string, fields: object, limit: number): Promise<unknown> {
  const peer = descriptor(path)
  return new Promise((resolve, reject) => {
    const socket = createConnection(peer.socket)
    const timer = setTimeout(() => socket.destroy(new Error("Peer endpoint timed out")), 5000)
    let buffer = Buffer.alloc(0),
      settled = false
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      error ? reject(error) : resolve(value)
    }
    socket.once("error", (error) => finish(error))
    socket.once("close", () => {
      if (!settled) finish(new Error("Peer closed before acknowledgement; delivery may be uncertain"))
    })
    socket.once("connect", () =>
      socket.write(`${JSON.stringify({ version: 1, token: peer.token, ...fields })}\n`),
    )
    socket.on("data", (data) => {
      if (buffer.length + data.length > limit) return finish(new Error("Peer acknowledgement exceeds limit"))
      buffer = Buffer.concat([buffer, data])
      if (!buffer.includes(10)) return
      try {
        const value = JSON.parse(buffer.toString())
        if (value.ok !== true) throw new Error("Peer message rejected")
        finish(undefined, value)
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Invalid peer acknowledgement"))
      }
    })
  })
}
