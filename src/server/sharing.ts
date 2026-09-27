import { randomBytes } from "node:crypto"
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { networkFetch } from "../core/network.ts"
import { atomic, bytes, directory } from "../core/session/files.ts"
import { type PortableSession, renderPortable, validatePortable } from "../core/session/portable.ts"
import type { AgentSession } from "../sdk/types.ts"
import type { Hub } from "./hub.ts"

type Share = { threadId: string; created: string; bundle: PortableSession }
export class ShareStore {
  #timer?: ReturnType<typeof setInterval>
  #tail: Promise<unknown> = Promise.resolve()
  constructor(
    readonly root: string,
    readonly mode: "manual" | "auto" | "disabled",
  ) {}
  enabled() {
    return (
      this.mode !== "disabled" &&
      process.env.CODESPLASH_DISABLE_SHARING !== "1" &&
      !existsSync(join(this.root, "disabled"))
    )
  }
  async create(threadId: string, session: AgentSession, base: string) {
    if (!this.enabled()) throw new Error("Sharing is disabled by the operator")
    const bundle = await session.exportHistory({ redact: true, images: false })
    validatePortable(bundle)
    if (!bundle.payload.redacted) throw new Error("Only redacted exports may be shared")
    const id = randomBytes(32).toString("base64url")
    directory(this.root, true)
    const retained = readdirSync(this.root).filter((name) => /^[\w-]{43}\.json$/.test(name))
    if (
      retained.length >= 1000 ||
      retained.reduce((sum, name) => sum + statSync(join(this.root, name)).size, 0) > 256 * 1024 * 1024
    )
      throw new Error("Share storage quota reached; revoke old shares")
    if (!this.enabled()) throw new Error("Sharing was disabled during export")
    atomic(
      join(this.root, `${id}.json`),
      JSON.stringify({ threadId, created: new Date().toISOString(), bundle }),
    )
    return {
      shareId: id,
      url: new URL(`share/${id}`, base).toString(),
      importUrl: new URL(`share/${id}/bundle`, base).toString(),
      redacted: true,
      omissions: bundle.payload.omissions,
    }
  }
  async revoke(threadId: string, id: string) {
    if (!/^[\w-]{43}$/.test(id)) throw new Error("Invalid share ID")
    const path = join(this.root, `${id}.json`)
    if (!existsSync(path)) return { revoked: true }
    const value = JSON.parse(bytes(path, 64 * 1024 * 1024).toString()) as Share
    if (value.threadId !== threadId) throw new Error("Share belongs to another thread")
    unlinkSync(path)
    return { revoked: true }
  }
  async route(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname
    if (!path.startsWith("/share/")) return undefined
    const match = /^\/share\/([\w-]{43})(\/bundle)?$/.exec(path)
    const headers = {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
    }
    if (
      !this.enabled() ||
      request.method !== "GET" ||
      !match ||
      !existsSync(join(this.root, `${match[1]}.json`))
    )
      return new Response("Share unavailable", { status: 404, headers })
    const value = JSON.parse(bytes(join(this.root, `${match[1]}.json`), 64 * 1024 * 1024).toString()) as Share
    validatePortable(value.bundle)
    if (!value.bundle.payload.redacted) return new Response("Share unavailable", { status: 404, headers })
    return match[2]
      ? Response.json(value.bundle, { headers })
      : new Response(renderPortable(value.bundle, "html"), {
          headers: {
            ...headers,
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy":
              "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
          },
        })
  }
  auto(hub: Hub, base: string) {
    const cursors = new Map(
      [...hub.threads.values()].map((t) => [
        t.id,
        t.events.findLast((e) => e.kind === "turn.completed")?.sequence ?? -1,
      ]),
    )
    this.#timer = setInterval(() => {
      if (!this.enabled()) return
      for (const thread of hub.threads.values()) {
        const turn = thread.events.findLast((e) => e.kind === "turn.completed")
        if (!thread.session || !turn || (cursors.get(thread.id) ?? -1) >= turn.sequence) continue
        cursors.set(thread.id, turn.sequence)
        const session = thread.session
        this.#tail = this.#tail.then(async () => {
          try {
            const share = await this.create(thread.id, session, base)
            hub.notice("share/created", { threadId: thread.id, ...share })
          } catch {
            hub.notice("share/error", {
              threadId: thread.id,
              message: "Automatic sharing failed or was disabled",
            })
          }
        })
      }
    }, 1000)
    this.#timer.unref()
  }
  async close() {
    clearInterval(this.#timer)
    await this.#tail
  }
}
export async function fetchShare(source: string): Promise<PortableSession> {
  const url = new URL(source)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))
    ) ||
    !/^\/share\/[\w-]{43}(\/bundle)?$/.test(url.pathname)
  )
    throw new Error("Expected an HTTPS or loopback daemon share URL")
  if (!url.pathname.endsWith("/bundle")) url.pathname += "/bundle"
  const response = await networkFetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: { Accept: "application/json" },
  })
  if (!response.ok || !response.body) throw new Error("Share is unavailable or revoked")
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > 64 * 1024 * 1024) throw new Error("Share exceeds import limit")
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const bundle = JSON.parse(Buffer.concat(chunks).toString()) as PortableSession
  validatePortable(bundle)
  if (!bundle.payload.redacted) throw new Error("Remote sharing requires a redacted bundle")
  return bundle
}
