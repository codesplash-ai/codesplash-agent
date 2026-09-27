import { timingSafeEqual } from "node:crypto"
import { unlinkSync } from "node:fs"
import { join } from "node:path"
import { configDirectory } from "../core/config.ts"
import { assertIdentityAllowed } from "../core/identity/policy.ts"
import { networkFetch } from "../core/network.ts"
import { atomic, json } from "../core/session/files.ts"
import { SecretSanitizer } from "../engines/codesplash/sandbox/env-policy.ts"
import { NamedSecrets } from "../engines/codesplash/secrets.ts"

type ProxyConfig = { version: 1; provider: "anthropic" | "openai"; secret: string; origin: string }
export async function startKeyProxy(
  config: ProxyConfig,
  resolveSecret: (name: string) => Promise<string> = (name) => new NamedSecrets().get(name),
) {
  if (
    config.version !== 1 ||
    !["anthropic", "openai"].includes(config.provider) ||
    !/^[A-Z][A-Z0-9_]{0,63}$/.test(config.secret)
  )
    throw new Error("Invalid key proxy configuration")
  const upstream = new URL(config.origin)
  if (
    upstream.protocol !== "https:" ||
    upstream.origin !== config.origin ||
    upstream.username ||
    upstream.password
  )
    throw new Error("Key proxy requires an exact HTTPS origin")
  assertIdentityAllowed("api-key", undefined, config.provider)
  const token = crypto.randomUUID() + crypto.randomUUID(),
    key = await resolveSecret(config.secret)
  if (!key || key.length > 65536 || /\s/.test(key)) throw new Error("Invalid proxy credential")
  const routes =
    config.provider === "anthropic"
      ? ["/v1/messages"]
      : ["/v1/responses", "/v1/chat/completions", "/v1/embeddings"]
  let active = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 8 * 1024 * 1024,
    idleTimeout: 120,
    async fetch(request) {
      const supplied = request.headers.get("authorization") ?? "",
        expected = `Bearer ${token}`,
        url = new URL(request.url)
      if (
        Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
      )
        return new Response("Unauthorized", { status: 401 })
      if (
        request.headers.has("origin") ||
        request.method !== "POST" ||
        !routes.includes(url.pathname) ||
        url.search
      )
        return new Response("Denied", { status: 403 })
      if (active >= 4) return new Response("Busy", { status: 429 })
      active++
      let handedOff = false
      try {
        assertIdentityAllowed("api-key", undefined, config.provider)
        const headers: Record<string, string> = {
          "content-type": "application/json",
          accept: "text/event-stream",
        }
        if (config.provider === "anthropic") {
          headers["x-api-key"] = key
          headers["anthropic-version"] = "2023-06-01"
        } else headers.authorization = `Bearer ${key}`
        const body = await request.arrayBuffer()
        if (body.byteLength > 8 * 1024 * 1024) return new Response("Too large", { status: 413 })
        const result = await networkFetch(new URL(url.pathname, upstream), {
          method: "POST",
          headers,
          body,
          signal: request.signal,
        })
        if (!result.ok || !result.body) {
          await result.body?.cancel()
          return new Response(`Upstream HTTP ${result.status}`, { status: result.ok ? 502 : result.status })
        }
        const sanitizer = new SecretSanitizer([key]),
          decoder = new TextDecoder(),
          reader = result.body.getReader()
        let released = false
        const release = () => {
          if (!released) {
            released = true
            active--
          }
        }
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await reader.read()
              if (next.done) {
                controller.enqueue(Buffer.from(sanitizer.push(decoder.decode(), true)))
                controller.close()
                release()
                reader.releaseLock()
              } else
                controller.enqueue(Buffer.from(sanitizer.push(decoder.decode(next.value, { stream: true }))))
            } catch {
              release()
              controller.error(new Error("Upstream stream failed"))
              await reader.cancel().catch(() => {})
            }
          },
          async cancel() {
            release()
            await reader.cancel().catch(() => {})
          },
        })
        handedOff = true
        return new Response(stream, {
          headers: {
            "content-type": result.headers.get("content-type") ?? "application/json",
            "cache-control": "no-store",
          },
        })
      } catch {
        return new Response("Upstream request failed", { status: 502 })
      } finally {
        if (!handedOff) active--
      }
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, token, close: () => server.stop(true) }
}
export async function runKeyProxyCommand(args: string[]): Promise<number> {
  if (args.length !== 2 || args[0] !== "--config")
    throw new Error(
      "Use key-proxy --config FILE; configuration names an OS-keyring secret and exact HTTPS origin",
    )
  const proxy = await startKeyProxy(json<ProxyConfig>(args[1]!, 8192))
  const path = join(configDirectory(), `key-proxy-${crypto.randomUUID()}.json`)
  atomic(path, JSON.stringify({ version: 1, url: proxy.url, token: proxy.token }))
  process.stdout.write(`Key proxy connection file: ${path}\n`)
  try {
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.removeListener("SIGINT", stop)
        process.removeListener("SIGTERM", stop)
        resolve()
      }
      process.once("SIGINT", stop)
      process.once("SIGTERM", stop)
    })
  } finally {
    proxy.close()
    unlinkSync(path)
  }
  return 0
}
