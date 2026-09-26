import { randomBytes, timingSafeEqual } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { atomic, bytes, directory, lease as lock } from "../core/session/files.ts"
import { type Connection, Hub, type HubOptions, type Notice } from "./hub.ts"
import { MAX_FRAME } from "./protocol.ts"

/** Incremental bounded framing; pulling the next line is the producer backpressure boundary. */
export async function* ndjson(
  input: AsyncIterable<Uint8Array | string>,
  max = MAX_FRAME,
): AsyncGenerator<unknown> {
  let pending = Buffer.alloc(0)
  for await (const chunk of input) {
    const data = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk)
    let offset = 0
    while (offset < data.length) {
      const newline = data.indexOf(10, offset)
      const end = newline < 0 ? data.length : newline
      if (pending.length + end - offset > max) throw new Error("JSON line exceeds frame limit")
      pending = Buffer.concat([pending, data.subarray(offset, end)])
      offset = end + (newline < 0 ? 0 : 1)
      if (newline >= 0) {
        if (pending.toString().trim()) yield JSON.parse(pending.toString())
        pending = Buffer.alloc(0)
      }
    }
  }
  if (pending.toString().trim()) yield JSON.parse(pending.toString())
}
export async function stdio(hub: Hub, input = process.stdin, output = process.stdout) {
  let tail = Promise.resolve(),
    queued = 0,
    failure: Error | undefined
  const write = (message: unknown) => {
    const line = `${JSON.stringify(message)}\n`
    queued += Buffer.byteLength(line)
    if (queued > 8 * MAX_FRAME) {
      failure = new Error("Output overflow; reconnect and replay")
      input.destroy(failure)
      return
    }
    tail = tail
      .then(
        () =>
          new Promise<void>((resolve, reject) =>
            output.write(line, (error) => {
              queued -= Buffer.byteLength(line)
              if (error) reject(error)
              else resolve()
            }),
          ),
      )
      .catch((error) => {
        failure = error
        input.destroy(error)
      })
  }
  const client = hub.connect(write)
  try {
    for await (const frame of ndjson(input)) {
      if (failure) throw failure
      const response = await hub.dispatch(client, frame)
      if (response) write(response)
      await tail
    }
  } finally {
    await hub.disconnect(client)
    await tail
    await hub.close()
  }
}
const secret = () => randomBytes(32).toString("base64url")
const equal = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))
type Stream = { controller: ReadableStreamDefaultController<Uint8Array>; close: () => void }
export type DaemonOptions = HubOptions & {
  hostname?: string
  tls?: { cert: string; key: string }
  port?: number
  token?: string
  web?: string
  publicRoute?: (request: Request) => Promise<Response | undefined>
}
export async function serve(options: DaemonOptions) {
  directory(options.root, true)
  const unlock = lock(options.root, "daemon.lease")
  let hub: Hub
  try {
    hub = await Hub.open(options)
  } catch (e) {
    unlock()
    throw e
  }
  const tokenPath = join(options.root, "token")
  let token: string
  try {
    token = options.token ?? (existsSync(tokenPath) ? bytes(tokenPath, 128).toString() : secret())
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error("Invalid daemon token")
    if (!options.token) atomic(tokenPath, token)
  } catch (error) {
    try {
      await hub.close()
    } finally {
      unlock()
    }
    throw error
  }
  const cookies = new Map<string, number>(),
    streams = new Map<string, Set<Stream>>()
  const clients = new Map<string, { client: Connection; touched: number }>()
  const pairs = new Map<string, number>()
  let closing = false
  const encode = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)
  const publish = (id: string, message: Notice) => {
    for (const stream of streams.get(id) ?? []) {
      if ((stream.controller.desiredSize ?? 0) <= 0) {
        stream.close()
        continue
      }
      stream.controller.enqueue(encode(message))
    }
  }
  const connect = () => {
    const client = hub.connect((message) => publish(client.id, message))
    clients.set(client.id, { client, touched: Date.now() })
    return client
  }
  const json = (value: unknown, status = 200, headers: HeadersInit = {}) =>
    Response.json(value, {
      status,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
    })
  const body = async (r: Request) => {
    if (!r.headers.get("content-type")?.startsWith("application/json")) throw new Error("JSON required")
    const reader = r.body?.getReader()
    if (!reader) throw new Error("Body required")
    const parts: Uint8Array[] = []
    let total = 0,
      expired = false
    const timer = setTimeout(() => {
      expired = true
      void reader.cancel().catch(() => {})
    }, 10000)
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        total += next.value.length
        if (total > MAX_FRAME) throw new Error("Body exceeds limit")
        parts.push(next.value)
      }
      if (expired) throw new Error("Body read timed out")
      return JSON.parse(Buffer.concat(parts).toString())
    } finally {
      clearTimeout(timer)
      await reader.cancel().catch(() => {})
    }
  }
  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      hostname: options.hostname ?? "127.0.0.1",
      port: options.port ?? 4096,
      maxRequestBodySize: MAX_FRAME,
      idleTimeout: 30,
      ...(options.tls ? { tls: options.tls } : {}),
      async fetch(r) {
        try {
          const url = new URL(r.url)
          const host = `${server.hostname?.includes(":") ? `[${server.hostname}]` : server.hostname}:${server.port}`
          if (
            r.headers.get("host") !== host ||
            (r.headers.has("origin") &&
              r.headers.get("origin") !== `${options.tls ? "https" : "http"}://${host}`)
          )
            return json({ error: "Host or Origin rejected" }, 403)
          if (url.search && url.pathname !== "/events")
            return json({ error: "Query parameters are not accepted" }, 400)
          if (options.publicRoute) {
            const response = await options.publicRoute(r)
            if (response) return response
          }
          if (r.method === "GET" && url.pathname === "/" && options.web)
            return new Response(options.web, {
              headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
                "Content-Security-Policy":
                  "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
              },
            })
          if (r.method === "POST" && url.pathname === "/auth") {
            const value = await body(r)
            const candidate = typeof value?.token === "string" ? value.token : ""
            const paired = pairs.get(candidate)
            if (!equal(candidate, token) && !(paired && paired > Date.now()))
              return json({ error: "Invalid credential" }, 401)
            pairs.delete(candidate)
            if (cookies.size >= 128) return json({ error: "Session limit" }, 429)
            const cookie = secret()
            cookies.set(cookie, Date.now() + 8 * 3600000)
            return json({ authenticated: true }, 200, {
              "Set-Cookie": `codesplash=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${options.tls ? "; Secure" : ""}`,
            })
          }
          const auth = r.headers.get("authorization") ?? ""
          let credential = auth.startsWith("Bearer ") ? auth.slice(7) : ""
          if (auth.startsWith("Basic ")) {
            const decoded = Buffer.from(auth.slice(6), "base64").toString()
            if (decoded.startsWith("codesplash:")) credential = decoded.slice(11)
          }
          const cookie = r.headers
            .get("cookie")
            ?.split(";")
            .map((v) => v.trim())
            .find((v) => v.startsWith("codesplash="))
            ?.slice(11)
          if (!equal(credential, token) && !(cookie && (cookies.get(cookie) ?? 0) > Date.now()))
            return json({ error: "Authentication required" }, 401)
          if (r.method === "POST" && url.pathname === "/pair") {
            if (pairs.size >= 128) return json({ error: "Pairing limit" }, 429)
            const code = secret()
            pairs.set(code, Date.now() + 120000)
            return json({ code, expiresIn: 120 })
          }
          if (r.method === "POST" && url.pathname === "/rpc") {
            const frame = await body(r)
            const id = r.headers.get("x-codesplash-connection")
            const entry = id ? clients.get(id) : undefined
            if (id && !entry) return json({ error: "Connection expired; initialize again" }, 409)
            if (!entry && frame?.method !== "initialize") return json({ error: "Initialize first" }, 409)
            const client = entry?.client ?? connect()
            clients.get(client.id)!.touched = Date.now()
            const response = await hub.dispatch(client, frame)
            return response ? json(response) : new Response(null, { status: 204 })
          }
          if (r.method === "POST" && /^\/tui\/(prompt|dialog|toast)$/.test(url.pathname)) {
            const entry = clients.get(r.headers.get("x-codesplash-connection") ?? "")
            if (!entry) return json({ error: "Initialize first" }, 409)
            entry.touched = Date.now()
            const value = await body(r)
            if (!value || typeof value !== "object" || typeof value.requestId !== "string")
              return json({ error: "requestId required" }, 400)
            const { requestId, ...parameters } = value
            return json(
              await hub.dispatch(entry.client, {
                jsonrpc: "2.0",
                id: requestId,
                method: "tui/control",
                params: { ...parameters, action: url.pathname.slice(5) },
              }),
            )
          }
          if (r.method === "GET" && url.pathname === "/events") {
            if ([...url.searchParams.keys()].some((k) => k !== "connection"))
              return json({ error: "Invalid stream query" }, 400)
            const id = url.searchParams.get("connection") ?? r.headers.get("x-codesplash-connection") ?? ""
            const entry = clients.get(id)
            if (!entry?.client.initialized) return json({ error: "Unknown connection" }, 409)
            const set = streams.get(id) ?? new Set<Stream>()
            streams.set(id, set)
            if (set.size >= 2) return json({ error: "Stream limit" }, 429)
            let stream: Stream
            const response = new ReadableStream<Uint8Array>(
              {
                start(controller) {
                  stream = {
                    controller,
                    close() {
                      set.delete(stream)
                      try {
                        controller.close()
                      } catch {}
                    },
                  }
                  set.add(stream)
                  controller.enqueue(
                    encode({ jsonrpc: "2.0", method: "stream/ready", params: { replayRequired: true } }),
                  )
                },
                cancel() {
                  set.delete(stream)
                },
              },
              { highWaterMark: 2 * MAX_FRAME, size: (chunk) => chunk?.byteLength ?? 0 },
            )
            r.signal.addEventListener("abort", () => stream.close(), { once: true })
            return new Response(response, {
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-store",
                Connection: "keep-alive",
              },
            })
          }
          if (r.method === "DELETE" && url.pathname === "/connection") {
            const id = r.headers.get("x-codesplash-connection") ?? "",
              entry = clients.get(id)
            if (entry) {
              for (const stream of streams.get(id) ?? []) stream.close()
              clients.delete(id)
              streams.delete(id)
              await hub.disconnect(entry.client)
            }
            return json({ disconnected: true })
          }
          return json({ error: "Not found" }, 404)
        } catch {
          return json({ error: "Invalid request or unavailable operation" }, 400)
        }
      },
    })
  } catch (e) {
    await hub.close()
    unlock()
    throw e
  }
  const interval = setInterval(() => {
    for (const [id, entry] of clients) {
      for (const stream of streams.get(id) ?? []) {
        if ((stream.controller.desiredSize ?? 0) <= 0) stream.close()
        else stream.controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"))
      }
      if (!streams.get(id)?.size && Date.now() - entry.touched > 120000) {
        clients.delete(id)
        streams.delete(id)
        void hub.disconnect(entry.client)
      }
    }
    for (const [code, expires] of pairs) if (expires < Date.now()) pairs.delete(code)
    for (const [code, expires] of cookies) if (expires < Date.now()) cookies.delete(code)
  }, 15000)
  interval.unref()
  try {
    atomic(
      join(options.root, "daemon.json"),
      JSON.stringify({ pid: process.pid, url: server.url.toString(), version: 1 }),
    )
  } catch (error) {
    clearInterval(interval)
    await server.stop(true)
    try {
      await hub.close()
    } finally {
      unlock()
    }
    throw error
  }
  return {
    hub,
    server,
    tokenPath,
    url: server.url.toString(),
    async close() {
      if (closing) return
      closing = true
      clearInterval(interval)
      for (const set of streams.values()) for (const stream of set) stream.close()
      await server.stop(true)
      try {
        await hub.close()
      } finally {
        unlock()
      }
    },
  }
}
