import { lookup } from "node:dns/promises"
import { createServer, type OutgoingHttpHeaders, request } from "node:http"
import { connect, type Socket } from "node:net"
import { blockedAddressClass } from "../tools/web-fetch.ts"
import { canonicalHost } from "./profile.ts"

/** Upstream for the OS runtime's proxies. Every connection uses the exact vetted DNS answer. */
export async function startNetworkBroker(
  allowed: readonly string[],
  options: {
    resolve?: (host: string) => Promise<string[]>
    blocked?: (address: string) => string | undefined
  } = {},
): Promise<{ url: string; close(): void }> {
  const resolve =
    options.resolve ?? (async (host) => (await lookup(host, { all: true })).map((a) => a.address))
  const blocked = options.blocked ?? blockedAddressClass
  const token = Buffer.from(`codesplash:${crypto.randomUUID()}`).toString("base64")
  const sockets = new Set<Socket>()
  async function destination(authority: string) {
    const target = canonicalHost(authority)
    if (!allowed.includes(target)) throw new Error("Host has no sandbox grant")
    const at = target.lastIndexOf(":")
    const host = target.slice(0, at),
      port = Number(target.slice(at + 1))
    const addresses = await Promise.race([
      resolve(host),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("DNS timeout")), 5000)
        timer.unref()
      }),
    ])
    const address = addresses[0]
    if (!address || addresses.some((a) => blocked(a) !== undefined))
      throw new Error("Private or invalid network destination")
    return { host, port, address }
  }
  const server = createServer(async (req, res) => {
    if (req.headers["proxy-authorization"] !== `Basic ${token}`) {
      res.writeHead(407).end()
      return
    }
    try {
      const url = new URL(req.url ?? "")
      if (url.protocol !== "http:" || url.username || url.password) throw new Error("Unsupported proxy URL")
      const dest = await destination(`${url.hostname}:${url.port || "80"}`)
      const headers: OutgoingHttpHeaders = { ...req.headers, host: url.host }
      for (const key of ["proxy-authorization", "proxy-connection", "connection", "upgrade"])
        delete headers[key]
      const upstream = request(
        {
          hostname: dest.address,
          port: dest.port,
          method: req.method,
          path: `${url.pathname}${url.search}`,
          headers,
          timeout: 30_000,
        },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers)
          response.pipe(res)
        },
      )
      upstream.on("timeout", () => upstream.destroy())
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502)
        res.end()
      })
      req.on("aborted", () => upstream.destroy())
      res.on("close", () => upstream.destroy())
      req.pipe(upstream)
    } catch {
      res.writeHead(403).end("Denied by sandbox network policy")
    }
  })
  server.on("connect", async (req, downstream, head) => {
    if (req.headers["proxy-authorization"] !== `Basic ${token}`) {
      downstream.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
      return
    }
    try {
      const dest = await destination(req.url ?? "")
      if (downstream.destroyed) return
      const upstream = connect({ host: dest.address, port: dest.port })
      sockets.add(upstream)
      upstream.setTimeout(60_000, () => upstream.destroy())
      upstream.once("connect", () => {
        downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        if (head.length) upstream.write(head)
        upstream.pipe(downstream)
        downstream.pipe(upstream)
      })
      upstream.on("error", () => downstream.destroy())
      downstream.on("error", () => upstream.destroy())
      downstream.on("close", () => upstream.destroy())
      upstream.on("close", () => {
        sockets.delete(upstream)
        downstream.destroy()
      })
    } catch {
      downstream.end("HTTP/1.1 403 Forbidden\r\n\r\n")
    }
  })
  server.on("connection", (socket) => {
    if (sockets.size >= 128) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.setTimeout(60_000, () => socket.destroy())
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Network broker did not bind")
  return {
    url: `http://${Buffer.from(token, "base64").toString()}@127.0.0.1:${address.port}`,
    close() {
      for (const socket of sockets) socket.destroy()
      server.close()
    },
  }
}
