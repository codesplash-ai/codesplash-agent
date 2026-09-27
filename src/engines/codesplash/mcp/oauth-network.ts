import type { FetchLike } from "@modelcontextprotocol/client"
import { networkFetch } from "../../../core/network.ts"
import type { SandboxProfile } from "../sandbox/contracts.ts"
import { startNetworkBroker } from "../sandbox/network-broker.ts"
import { canonicalHost } from "../sandbox/profile.ts"
import { boundedJson } from "./bounds.ts"
import type { McpServerConfig } from "./config.ts"

/** OAuth metadata and token exchanges use fixed M3 grants, never ambient host fetch. */
export async function openMcpOAuthNetwork(
  profile: SandboxProfile,
  server: McpServerConfig,
  signal: AbortSignal,
): Promise<{
  fetch: FetchLike
  check(url: URL): void
  close(): Promise<void>
}> {
  signal.throwIfAborted()
  const origin = new URL(server.url ?? "").origin
  const check = (url: URL) => {
    if (url.username || url.password || url.hash || url.href.length > 16_384)
      throw new Error("Invalid OAuth destination")
    if (
      server.allowLoopback &&
      url.origin === origin &&
      ["127.0.0.1", "[::1]"].includes(url.hostname) &&
      url.protocol === "http:"
    )
      return
    if (
      url.protocol !== "https:" ||
      !profile.allowedHosts.includes(canonicalHost(`${url.hostname}:${url.port || "443"}`))
    )
      throw new Error("OAuth destination requires a fixed sandbox network grant")
  }
  const broker = await startNetworkBroker(profile.allowedHosts, {
    ...(server.allowLoopback ? { loopbackOrigins: [origin] } : {}),
  })
  const abort = new AbortController()
  const work = new Set<Promise<Response>>()
  const close = async () => {
    signal.removeEventListener("abort", cancel)
    abort.abort()
    broker.close()
    await Promise.allSettled([...work])
  }
  const cancel = () => {
    void close()
  }
  signal.addEventListener("abort", cancel, { once: true })
  const request: FetchLike = async (input, init) => {
    const run = async () => {
      if (work.size >= 16) throw new Error("OAuth network request limit exceeded")
      let url = new URL(input instanceof Request ? input.url : String(input))
      const method = init?.method ?? "GET"
      if (
        !["GET", "POST"].includes(method) ||
        (init?.body !== undefined &&
          init.body !== null &&
          typeof init.body !== "string" &&
          !(init.body instanceof URLSearchParams))
      )
        throw new Error("Unsupported OAuth request")
      if (init?.body && Buffer.byteLength(String(init.body)) > 128 * 1024)
        throw new Error("OAuth request exceeds 128 KiB")
      const combined = AbortSignal.any([
        signal,
        abort.signal,
        AbortSignal.timeout(server.requestTimeoutMs),
        ...(init?.signal ? [init.signal] : []),
      ])
      for (let redirect = 0; ; redirect++) {
        check(url)
        const response = await networkFetch(url, {
          ...init,
          redirect: "manual",
          proxy: broker.url,
          signal: combined,
        })
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel()
          const location = response.headers.get("location")
          if (method !== "GET" || redirect >= 4 || !location)
            throw new Error("OAuth operation redirect refused")
          const next = new URL(location, url)
          if (next.origin !== url.origin) throw new Error("OAuth redirect changed origin")
          url = next
          continue
        }
        if (!response.body) return response
        const reader = response.body.getReader(),
          chunks: Uint8Array[] = []
        let size = 0
        try {
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            size += chunk.value.length
            if (size > 128 * 1024 || chunks.length >= 8192) throw new Error("OAuth response exceeds 128 KiB")
            chunks.push(chunk.value)
          }
        } finally {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        }
        const body = Buffer.concat(chunks, size)
        if (response.headers.get("content-type")?.includes("json"))
          boundedJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)), 128 * 1024, 5000)
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }
    }
    const pending = run()
    work.add(pending)
    try {
      return await pending
    } finally {
      work.delete(pending)
    }
  }
  if (signal.aborted) {
    await close()
    signal.throwIfAborted()
  }
  return { fetch: request, check, close }
}
