import type { McpOAuth } from "../engines/codesplash/mcp/oauth.ts"

/** The explicit login command owns its callback listener and never opens a browser automatically. */
export async function runMcpLogin(
  oauth: Pick<McpOAuth, "login">,
  output: (text: string) => void,
): Promise<void> {
  const abort = new AbortController()
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(300_000)])
  const interrupt = () => abort.abort(new Error("MCP login cancelled"))
  process.once("SIGINT", interrupt)
  let expectedState: string | undefined, expectedOrigin: string | undefined
  let deliver: ((url: URL) => void) | undefined
  let settled = false
  const callback = new Promise<URL>((resolve, reject) => {
    deliver = (url) => {
      if (!settled) {
        settled = true
        resolve(url)
      }
    }
    signal.addEventListener(
      "abort",
      () => {
        if (!settled) {
          settled = true
          reject(new Error("MCP login cancelled or timed out"))
        }
      },
      { once: true },
    )
  })
  void callback.catch(() => {})
  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (
          settled ||
          request.method !== "GET" ||
          url.origin !== expectedOrigin ||
          url.pathname !== "/oauth/callback" ||
          !expectedState ||
          url.searchParams.get("state") !== expectedState ||
          url.href.length > 16_384
        )
          return new Response("Invalid OAuth callback.", { status: 400 })
        deliver?.(url)
        return new Response(
          "Authorization response received. Return to the terminal to check login status.",
          { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } },
        )
      },
    })
    const redirect = new URL(`http://127.0.0.1:${server.port}/oauth/callback`)
    expectedOrigin = redirect.origin
    await oauth.login(
      redirect,
      async (url) => {
        expectedState = url.searchParams.get("state") ?? undefined
        output(
          `Open this URL to authorize the MCP server:\n${url.href}\nWaiting for the local callback (up to five minutes).\n`,
        )
        return callback
      },
      signal,
    )
  } finally {
    interrupt()
    process.removeListener("SIGINT", interrupt)
    await server?.stop(true)
  }
}
