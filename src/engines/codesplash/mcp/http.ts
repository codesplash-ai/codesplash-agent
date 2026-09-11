import {
  type JSONRPCMessage,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Transport,
  type TransportSendOptions,
} from "@modelcontextprotocol/client"
import type { SandboxProfile } from "../sandbox/contracts.ts"
import { startNetworkBroker } from "../sandbox/network-broker.ts"
import { canonicalHost } from "../sandbox/profile.ts"
import { boundedJson, MCP_FRAME_BYTES } from "./bounds.ts"
import type { McpServerConfig } from "./config.ts"

/** SDK framing over an owned, DNS-pinned network path with no automatic effect retries. */
export async function openMcpHttpTransport(options: {
  server: McpServerConfig
  profile: SandboxProfile
  signal: AbortSignal
  bearerToken?: () => Promise<string | undefined>
}): Promise<Transport> {
  options.signal.throwIfAborted()
  const endpoint = new URL(options.server.url ?? "")
  const loopback = options.server.allowLoopback && ["127.0.0.1", "[::1]"].includes(endpoint.hostname)
  if (
    !loopback &&
    !options.profile.allowedHosts.includes(canonicalHost(`${endpoint.hostname}:${endpoint.port || "443"}`))
  )
    throw new Error("MCP endpoint has no fixed sandbox network grant")
  const broker = await startNetworkBroker(options.profile.allowedHosts, {
    ...(loopback ? { loopbackOrigins: [endpoint.origin] } : {}),
  })
  const abort = new AbortController()
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>()
  const fetches = new Set<Promise<unknown>>()
  let active = 0,
    closed = false
  let inner: Transport | undefined
  let closing: Promise<void> | undefined
  const outer: Transport = {
    async start() {
      if (closed || !inner) throw new Error("MCP HTTP transport is closed")
      await inner.start()
    },
    async send(message: JSONRPCMessage, sendOptions?: TransportSendOptions) {
      if (closed || !inner) throw new Error("MCP HTTP transport is closed")
      boundedJson(message)
      await inner.send(message, sendOptions)
    },
    close() {
      closing ??= (async () => {
        closed = true
        options.signal.removeEventListener("abort", cancel)
        abort.abort()
        broker.close()
        await Promise.allSettled([...readers].map((reader) => reader.cancel()))
        await inner?.close().catch(() => {})
        await Promise.allSettled([...fetches])
        outer.onclose?.()
      })()
      return closing
    },
    get hasPerRequestStream() {
      return inner?.hasPerRequestStream ?? false
    },
    setProtocolVersion(version: string) {
      inner?.setProtocolVersion?.(version)
    },
  }
  const fail = () => {
    if (closed) return
    void outer.close().catch(() => {})
    outer.onerror?.(new Error("MCP HTTP connection failed; reconnect explicitly"))
  }
  const cancel = () => {
    void outer.close().catch(() => {})
  }
  options.signal.addEventListener("abort", cancel, { once: true })
  const guardedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const execute = async (): Promise<Response> => {
      if (closed || active >= 32) throw new Error("MCP HTTP transport is closed or at its request limit")
      active++
      let release = true
      try {
        let url = new URL(input instanceof Request ? input.url : input.toString())
        const headers = new Headers(init?.headers)
        headers.delete("authorization")
        headers.delete("cookie")
        const token = await options.bearerToken?.()
        if (token) {
          if (token.length > 16_384 || Array.from(token).some((char) => char.charCodeAt(0) <= 32))
            throw new Error("Invalid MCP bearer credential")
          headers.set("authorization", `Bearer ${token}`)
        }
        const signal = AbortSignal.any([options.signal, abort.signal, ...(init?.signal ? [init.signal] : [])])
        for (let redirect = 0; ; redirect++) {
          if (
            url.origin !== endpoint.origin ||
            url.username ||
            url.password ||
            url.hash ||
            url.href.length > 16_384
          )
            throw new Error("MCP request or redirect left its reviewed origin")
          const timeout = new AbortController()
          const timer = setTimeout(() => timeout.abort(), options.server.requestTimeoutMs)
          let response: Response
          try {
            response = await fetch(url, {
              ...init,
              headers,
              redirect: "manual",
              proxy: broker.url,
              signal: AbortSignal.any([signal, timeout.signal]),
            })
          } finally {
            clearTimeout(timer)
          }
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel()
            // Reposting an operation after a redirect could duplicate external effects.
            if ((init?.method ?? "GET") !== "GET" || redirect >= 4)
              throw new Error("MCP operation redirects require a reviewed endpoint update")
            const location = response.headers.get("location")
            if (!location) throw new Error("MCP redirect omitted its destination")
            url = new URL(location, url)
            continue
          }
          if (!response.body) return response
          const reader = response.body.getReader()
          readers.add(reader)
          const sse = response.headers.get("content-type")?.split(";")[0]?.trim() === "text/event-stream"
          let size = 0,
            line = 0,
            done = false,
            previousCR = false
          const finish = () => {
            if (done) return
            done = true
            readers.delete(reader)
            active--
            reader.releaseLock()
          }
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const chunk = await reader.read()
                if (chunk.done) {
                  finish()
                  controller.close()
                  return
                }
                if (sse) {
                  for (const byte of chunk.value) {
                    if (byte === 10 && previousCR) {
                      previousCR = false
                      continue
                    }
                    previousCR = byte === 13
                    size++
                    if (byte === 10 || byte === 13) {
                      if (line === 0) size = 0
                      line = 0
                    } else line++
                    if (size > MCP_FRAME_BYTES) throw new Error("MCP SSE event exceeds 16 MiB")
                  }
                } else {
                  size += chunk.value.byteLength
                  if (size > MCP_FRAME_BYTES) throw new Error("MCP HTTP response exceeds 16 MiB")
                }
                controller.enqueue(chunk.value)
              } catch {
                await reader.cancel().catch(() => {})
                finish()
                controller.error(new Error("MCP HTTP response failed or exceeded its limit"))
                fail()
              }
            },
            async cancel() {
              await reader.cancel().catch(() => {})
              finish()
            },
          })
          release = false
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        }
      } finally {
        if (release) active--
      }
    }
    const work = execute()
    fetches.add(work)
    try {
      return await work
    } finally {
      fetches.delete(work)
    }
  }
  try {
    inner =
      options.server.transport === "sse"
        ? new SSEClientTransport(endpoint, { fetch: guardedFetch })
        : new StreamableHTTPClientTransport(endpoint, {
            fetch: guardedFetch,
            onInsufficientScope: "throw",
            maxStepUpRetries: 0,
            reconnectionOptions: {
              maxRetries: 0,
              initialReconnectionDelay: 1000,
              maxReconnectionDelay: 1000,
              reconnectionDelayGrowFactor: 1,
            },
          })
    inner.onmessage = (message) => {
      try {
        boundedJson(message)
        outer.onmessage?.(message)
      } catch {
        fail()
      }
    }
    inner.onerror = fail
    inner.onclose = cancel
    if (options.signal.aborted) {
      await outer.close()
      options.signal.throwIfAborted()
    }
    return outer
  } catch (error) {
    await outer.close()
    throw error
  }
}
