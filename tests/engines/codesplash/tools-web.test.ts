import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { SessionPolicy } from "../../../src/core/index.ts"
import { type ToolContext, ToolInputError } from "../../../src/engines/codesplash/contracts.ts"
import { builtinTools } from "../../../src/engines/codesplash/tools/registry.ts"
import {
  blockedAddressClass,
  CACHE_TTL_MS,
  createWebFetchTool,
  DEFAULT_TIMEOUT_SECONDS,
  htmlToMarkdown,
  MAX_REDIRECT_HOPS,
  MAX_RESPONSE_BYTES,
  type ResolveAddresses,
  UNTRUSTED_CONTENT_NOTICE,
} from "../../../src/engines/codesplash/tools/web-fetch.ts"
import {
  createWebSearchTool,
  DEFAULT_RESULT_COUNT,
  DEFAULT_SEARCH_ENDPOINT,
  MAX_RESULT_COUNT,
  parseSearchResults,
  SEARCH_UNAVAILABLE_MESSAGE,
  UNTRUSTED_RESULTS_NOTICE,
} from "../../../src/engines/codesplash/tools/web-search.ts"

/* --------------------------------- fixtures --------------------------------- */

const PUBLIC_ADDRESS = "93.184.216.34"

let server: ReturnType<typeof Bun.serve>
const hitCounts = new Map<string, number>()
let lastSearchQuery: string | undefined

const PAGE_HTML = `<html><head><title>Fixture</title><style>body { color: red }</style></head>
<body><script>var secret = "dropped";</script><noscript>enable js</noscript>
<h1>Main Title</h1>
<p>Intro &amp; overview.</p>
<h2>Details</h2>
<ul><li>First item</li><li>Second item</li></ul>
<blockquote>Quoted wisdom</blockquote>
<p>See <a href="https://example.com/docs">the docs</a> for more.</p>
<pre><code>const x = 1;
if (x &lt; 2) run();</code></pre>
<p>Inline <code>call()</code> reference.</p>
</body></html>`

function ddgHtml(resultCount: number): string {
  const parts: string[] = ["<html><body><div class='serp'>"]
  parts.push(
    `<h2 class="result__title"><a rel="nofollow" class="result__a" ` +
      `href="//duckduckgo.com/y.js?ad_domain=ads.example&amp;u3=abc">Sponsored thing</a></h2>`,
  )
  for (let index = 1; index <= resultCount; index += 1) {
    const target = encodeURIComponent(`https://example.com/page-${index}?ref=1`)
    parts.push(`<div class="result results_links">
      <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${target}&amp;rut=deadbeef">Result <b>${index}</b> title</a></h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=${target}">Snippet ${index} text &amp; more.</a>
    </div>`)
  }
  parts.push("</div></body></html>")
  return parts.join("\n")
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const text = (body: string, type = "text/plain") =>
        new Response(body, { headers: { "content-type": type } })
      switch (url.pathname) {
        case "/page.html":
          return text(PAGE_HTML, "text/html; charset=utf-8")
        case "/plain.txt":
          return text("hello plain\n")
        case "/data.json":
          return text('{"ok":true}', "application/json")
        case "/binary":
          return new Response(new Uint8Array([1, 2, 3, 4]), {
            headers: { "content-type": "application/octet-stream" },
          })
        case "/empty":
          return text("")
        case "/big":
          return text("x".repeat(MAX_RESPONSE_BYTES + 1024 * 1024))
        case "/huge-text":
          return text(
            Array.from({ length: 3000 }, (_, index) => `line-${index} ${"y".repeat(20)}`).join("\n"),
          )
        case "/slow":
          await Bun.sleep(1500)
          return text("finally")
        case "/counted": {
          const key = url.search
          const count = (hitCounts.get(key) ?? 0) + 1
          hitCounts.set(key, count)
          const status = Number(url.searchParams.get("status") ?? "200")
          return new Response(`count:${count}`, { status, headers: { "content-type": "text/plain" } })
        }
        case "/error404":
          return new Response("nope", { status: 404, headers: { "content-type": "text/plain" } })
        case "/redirect/a":
          return new Response("", { status: 302, headers: { location: "/redirect/b" } })
        case "/redirect/b":
          return new Response("", { status: 302, headers: { location: "http://fixture.test/page.html" } })
        case "/redirect/loop":
          return new Response("", { status: 302, headers: { location: "/redirect/loop" } })
        case "/redirect/no-location":
          return new Response("", { status: 302 })
        case "/redirect/private":
          return new Response("", { status: 302, headers: { location: "http://private.test/secret" } })
        case "/ddg":
          lastSearchQuery = url.searchParams.get("q") ?? undefined
          return text(ddgHtml(12), "text/html")
        case "/ddg-empty":
          return text("<html><body><div>No results.</div></body></html>", "text/html")
        case "/ddg-503":
          return new Response("blocked", { status: 503 })
        default:
          return new Response("not found", { status: 404 })
      }
    },
  })
})

afterAll(() => {
  server.stop(true)
})

const onRequest: SessionPolicy = { sandbox: "workspace-write", approvalPolicy: "on-request" }
const untrusted: SessionPolicy = { sandbox: "workspace-write", approvalPolicy: "untrusted" }
const readOnlyUntrusted: SessionPolicy = { sandbox: "read-only", approvalPolicy: "untrusted" }
const fullAccess: SessionPolicy = { sandbox: "danger-full-access", approvalPolicy: "untrusted" }

function contextFor(policy: SessionPolicy = onRequest, signal?: AbortSignal): ToolContext {
  return { cwd: "/anywhere", policy, signal: signal ?? new AbortController().signal }
}

function abortedContext(): ToolContext {
  const controller = new AbortController()
  controller.abort()
  return contextFor(onRequest, controller.signal)
}

type FetchHarness = {
  tool: ReturnType<typeof createWebFetchTool>
  resolverCalls: string[]
  fetchCalls: string[]
  fetchHeaders: Array<Record<string, string>>
}

/**
 * Builds a web_fetch tool whose guard resolver answers from a table (never real DNS) and whose
 * fetch rewrites every host to the local Bun.serve fixture, so hostname URLs like
 * http://fixture.test/... exercise the full network path against the fixture.
 */
function makeFetchHarness(
  options: { addresses?: Record<string, string[]>; cacheTtlMs?: number } = {},
): FetchHarness {
  const resolverCalls: string[] = []
  const fetchCalls: string[] = []
  const fetchHeaders: Array<Record<string, string>> = []
  const resolveAddresses: ResolveAddresses = async (hostname) => {
    resolverCalls.push(hostname)
    const found = options.addresses?.[hostname]
    if (found !== undefined) return found
    return [PUBLIC_ADDRESS]
  }
  const fetchImpl: typeof fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const original = new URL(input instanceof Request ? input.url : input.toString())
    fetchCalls.push(original.href)
    fetchHeaders.push({ ...((init?.headers ?? {}) as Record<string, string>) })
    const target = new URL(original.pathname + original.search, `http://127.0.0.1:${server.port}`)
    // The Host header would point Bun's real fetch at the wrong virtual host; drop it here.
    const { host: _host, ...headers } = (init?.headers ?? {}) as Record<string, string>
    return fetch(target.href, { ...init, headers })
  }) as typeof fetch
  const tool = createWebFetchTool({ resolveAddresses, fetchImpl, cacheTtlMs: options.cacheTtlMs })
  return { tool, resolverCalls, fetchCalls, fetchHeaders }
}

/* ---------------------------------- web_fetch ---------------------------------- */

describe("web_fetch metadata and permissions", () => {
  test("is read-only with the documented caps", () => {
    const tool = createWebFetchTool()
    expect(tool.name).toBe("web_fetch")
    expect(tool.isReadOnly({ url: "https://example.com/" })).toBe(true)
    expect(DEFAULT_TIMEOUT_SECONDS).toBe(10)
    expect(MAX_REDIRECT_HOPS).toBe(5)
    expect(MAX_RESPONSE_BYTES).toBe(5 * 1024 * 1024)
    expect(CACHE_TTL_MS).toBe(15 * 60 * 1000)
  })

  test("permission is none under on-request and danger-full-access, approval under untrusted", () => {
    const tool = createWebFetchTool()
    const input = { url: "https://fixture.test/page.html" }
    expect(tool.permission(input, contextFor(onRequest))).toEqual({ kind: "none" })
    expect(tool.permission(input, contextFor(fullAccess))).toEqual({ kind: "none" })
    expect(
      tool.permission(input, contextFor({ sandbox: "read-only", approvalPolicy: "on-request" })),
    ).toEqual({ kind: "none" })
    const approval = tool.permission(input, contextFor(untrusted))
    expect(approval).toEqual({
      kind: "approval",
      title: "Fetch URL?",
      detail: "https://fixture.test/page.html",
      sessionKey: "web:fixture.test",
    })
    expect(tool.permission(input, contextFor(readOnlyUntrusted))).toEqual(approval)
  })

  test("timeoutSeconds above the max is clamped, not rejected", () => {
    const tool = createWebFetchTool()
    expect(tool.permission({ url: "https://fixture.test/", timeoutSeconds: 500 }, contextFor())).toEqual({
      kind: "none",
    })
  })

  test("rejects bad input with ToolInputError", async () => {
    const tool = createWebFetchTool()
    const context = contextFor()
    await expect(tool.run("nope", context)).rejects.toThrow(ToolInputError)
    await expect(tool.run({}, context)).rejects.toThrow(ToolInputError)
    await expect(tool.run({ url: "" }, context)).rejects.toThrow(ToolInputError)
    await expect(tool.run({ url: "not a url" }, context)).rejects.toThrow(ToolInputError)
    await expect(tool.run({ url: "ftp://example.com/file" }, context)).rejects.toThrow(ToolInputError)
    await expect(tool.run({ url: "https://user:pass@example.com/" }, context)).rejects.toThrow(ToolInputError)
    await expect(tool.run({ url: "https://example.com/", timeoutSeconds: 0 }, context)).rejects.toThrow(
      ToolInputError,
    )
    await expect(tool.run({ url: "https://example.com/", timeoutSeconds: "5" }, context)).rejects.toThrow(
      ToolInputError,
    )
  })
})

describe("web_fetch SSRF guard", () => {
  const literalCases: Array<[string, string]> = [
    ["http://127.0.0.1:9/", "loopback"],
    ["http://10.1.2.3/", "private-range"],
    ["http://172.16.0.1/x", "private-range"],
    ["http://172.31.255.255/", "private-range"],
    ["http://192.168.1.1/", "private-range"],
    ["http://169.254.10.10/", "link-local"],
    ["http://0.0.0.0/", "unspecified"],
    ["http://[::1]:9/", "loopback"],
    ["http://[::]/", "unspecified"],
    ["http://[fe80::1]/", "link-local"],
    ["http://[fd00::1]/", "unique-local"],
    ["http://[::ffff:127.0.0.1]/", "loopback"],
  ]

  test.each(literalCases)("refuses literal IP host %s without DNS", async (url, blockedClass) => {
    const { tool, resolverCalls, fetchCalls } = makeFetchHarness()
    const outcome = await tool.run({ url }, contextFor())
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain(blockedClass)
    expect(resolverCalls).toHaveLength(0)
    expect(fetchCalls).toHaveLength(0)
  })

  test("refuses a hostname resolving to a private address, never echoing the address", async () => {
    const { tool, fetchCalls } = makeFetchHarness({ addresses: { "private.test": ["10.0.0.5"] } })
    const outcome = await tool.run({ url: "http://private.test/" }, contextFor())
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain("private-range")
    expect(outcome.text).not.toContain("10.0.0.5")
    expect(fetchCalls).toHaveLength(0)
  })

  test("refuses when ANY resolved address is blocked", async () => {
    const { tool, fetchCalls } = makeFetchHarness({
      addresses: { "mixed.test": [PUBLIC_ADDRESS, "192.168.0.7"] },
    })
    const outcome = await tool.run({ url: "http://mixed.test/" }, contextFor())
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain("private-range")
    expect(outcome.text).not.toContain("192.168.0.7")
    expect(fetchCalls).toHaveLength(0)
  })

  test("resolution failure is an isError result, not a throw", async () => {
    const resolveAddresses: ResolveAddresses = async () => {
      throw new Error("ENOTFOUND")
    }
    const tool = createWebFetchTool({ resolveAddresses })
    const outcome = await tool.run({ url: "http://unresolvable.test/" }, contextFor())
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain("could not be resolved")
  })

  test("http fetches connect to the vetted IP with the hostname pinned in the Host header", async () => {
    // DNS-rebinding regression: the request must go to the exact address the guard approved —
    // a second, independent resolution inside fetch could land on an internal host.
    const { tool, fetchCalls, fetchHeaders } = makeFetchHarness()
    const outcome = await tool.run({ url: "http://rebind.test:8080/plain.txt?x=1" }, contextFor())
    expect(outcome.isError).toBeUndefined()
    expect(fetchCalls).toEqual([`http://${PUBLIC_ADDRESS}:8080/plain.txt?x=1`])
    expect(fetchHeaders[0]?.host).toBe("rebind.test:8080")
    // The result still speaks in terms of the URL the model asked for.
    expect(outcome.label).toBe("http://rebind.test:8080/plain.txt?x=1")
  })

  test("every http redirect hop is re-pinned to its own vetted address", async () => {
    const { tool, fetchCalls, fetchHeaders } = makeFetchHarness()
    const outcome = await tool.run({ url: "http://fixture.test/redirect/a" }, contextFor())
    expect(outcome.isError).toBeUndefined()
    expect(fetchCalls).toEqual([
      `http://${PUBLIC_ADDRESS}/redirect/a`,
      `http://${PUBLIC_ADDRESS}/redirect/b`,
      `http://${PUBLIC_ADDRESS}/page.html`,
    ])
    for (const headers of fetchHeaders) expect(headers.host).toBe("fixture.test")
  })

  test("https fetches keep the hostname (TLS validates the peer) and literal IPs need no pin", async () => {
    const { tool, fetchCalls, fetchHeaders } = makeFetchHarness()
    await tool.run({ url: "https://fixture.test/plain.txt" }, contextFor())
    expect(fetchCalls).toEqual(["https://fixture.test/plain.txt"])
    expect(fetchHeaders[0]?.host).toBeUndefined()

    const literal = makeFetchHarness()
    await literal.tool.run({ url: `http://${PUBLIC_ADDRESS}/plain.txt` }, contextFor())
    expect(literal.fetchCalls).toEqual([`http://${PUBLIC_ADDRESS}/plain.txt`])
    expect(literal.fetchHeaders[0]?.host).toBeUndefined()
  })

  test("blockedAddressClass allows public addresses and handles zones", () => {
    expect(blockedAddressClass("8.8.8.8")).toBeUndefined()
    expect(blockedAddressClass("172.32.0.1")).toBeUndefined()
    expect(blockedAddressClass(PUBLIC_ADDRESS)).toBeUndefined()
    expect(blockedAddressClass("2600::1")).toBeUndefined()
    expect(blockedAddressClass("fe80::1%en0")).toBe("a link-local address")
    expect(blockedAddressClass("fc00::1")).toBe("a unique-local address")
    expect(blockedAddressClass("::ffff:10.0.0.1")).toBe("a private-range address")
    expect(blockedAddressClass("0:0:0:0:0:0:0:1")).toBe("a loopback address")
  })
})

describe("web_fetch responses", () => {
  test("converts text/html to markdown", async () => {
    const { tool } = makeFetchHarness()
    const url = "http://fixture.test/page.html"
    const outcome = await tool.run({ url }, contextFor())
    expect(outcome.isError).toBeUndefined()
    expect(outcome.label).toBe(url)
    // Page content is externally controlled: it arrives behind the untrusted-content notice.
    expect(outcome.text.startsWith(`[${url}] ${UNTRUSTED_CONTENT_NOTICE}`)).toBe(true)
    expect(outcome.text).toContain("# Main Title")
    expect(outcome.text).toContain("## Details")
    expect(outcome.text).toContain("Intro & overview.")
    expect(outcome.text).toContain("- First item")
    expect(outcome.text).toContain("> Quoted wisdom")
    expect(outcome.text).toContain("the docs (https://example.com/docs)")
    expect(outcome.text).toContain("```\nconst x = 1;\nif (x < 2) run();\n```")
    expect(outcome.text).toContain("`call()`")
    expect(outcome.text).not.toContain("secret")
    expect(outcome.text).not.toContain("color: red")
    expect(outcome.text).not.toContain("enable js")
    expect(outcome.text).not.toContain("<h1>")
  })

  test("passes text/plain and JSON through raw behind the untrusted-content notice", async () => {
    const { tool } = makeFetchHarness()
    const plain = await tool.run({ url: "http://fixture.test/plain.txt" }, contextFor())
    expect(plain.text.endsWith("\n\nhello plain\n")).toBe(true)
    expect(plain.text).toContain(UNTRUSTED_CONTENT_NOTICE)
    expect(plain.isError).toBeUndefined()
    const json = await tool.run({ url: "http://fixture.test/data.json" }, contextFor())
    expect(json.text.endsWith('\n\n{"ok":true}')).toBe(true)
    expect(json.isError).toBeUndefined()
  })

  test("refuses non-text content types by name", async () => {
    const { tool } = makeFetchHarness()
    const outcome = await tool.run({ url: "http://fixture.test/binary" }, contextFor())
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain("application/octet-stream")
  })

  test("reports an empty 2xx body without an error", async () => {
    const { tool } = makeFetchHarness()
    const outcome = await tool.run({ url: "http://fixture.test/empty" }, contextFor())
    expect(outcome.isError).toBeUndefined()
    expect(outcome.text).toContain("was empty")
  })

  test("non-2xx responses are isError with the status and body", async () => {
    const { tool } = makeFetchHarness()
    const outcome = await tool.run({ url: "http://fixture.test/error404" }, contextFor())
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain("HTTP 404")
    expect(outcome.text).toContain("nope")
  })

  test("aborts past the 5MB cap", async () => {
    const { tool } = makeFetchHarness()
    const outcome = await tool.run({ url: "http://fixture.test/big" }, contextFor())
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain("5MB")
  })

  test("truncates long text output head+tail to 2000 lines / 50KB", async () => {
    const { tool } = makeFetchHarness()
    const outcome = await tool.run({ url: "http://fixture.test/huge-text" }, contextFor())
    expect(outcome.isError).toBeUndefined()
    expect(new TextEncoder().encode(outcome.text).byteLength).toBeLessThanOrEqual(50 * 1024)
    expect(outcome.text).toContain("[... output truncated:")
    // Head+tail truncation keeps the leading untrusted-content notice and the content head.
    expect(outcome.text.split("\n")[0]).toContain(UNTRUSTED_CONTENT_NOTICE)
    expect(outcome.text).toContain("line-0 ")
  })

  test("times out via timeoutSeconds", async () => {
    const { tool } = makeFetchHarness()
    const outcome = await tool.run({ url: "http://fixture.test/slow", timeoutSeconds: 0.25 }, contextFor())
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain("timed out")
  })

  test("an interrupted call is an isError result", async () => {
    const { tool } = makeFetchHarness()
    const outcome = await tool.run({ url: "http://fixture.test/plain.txt" }, abortedContext())
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain("interrupted")
  })
})

describe("web_fetch redirects", () => {
  test("follows a redirect chain, re-validating every hop", async () => {
    const { tool, resolverCalls } = makeFetchHarness()
    const outcome = await tool.run({ url: "http://fixture.test/redirect/a" }, contextFor())
    expect(outcome.isError).toBeUndefined()
    expect(outcome.text).toContain("# Main Title")
    expect(outcome.label).toBe("http://fixture.test/redirect/a")
    expect(resolverCalls).toEqual(["fixture.test", "fixture.test", "fixture.test"])
  })

  test("refuses a redirect hop into a private host without fetching it", async () => {
    const { tool, fetchCalls } = makeFetchHarness({ addresses: { "private.test": ["10.0.0.5"] } })
    const outcome = await tool.run({ url: "http://fixture.test/redirect/private" }, contextFor())
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain("private-range")
    expect(outcome.text).not.toContain("10.0.0.5")
    expect(fetchCalls.some((call) => call.startsWith("http://private.test"))).toBe(false)
  })

  test("stops after 5 redirect hops", async () => {
    const { tool, fetchCalls } = makeFetchHarness()
    const outcome = await tool.run({ url: "http://fixture.test/redirect/loop" }, contextFor())
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain("redirects")
    expect(fetchCalls).toHaveLength(1 + MAX_REDIRECT_HOPS)
  })

  test("a redirect without a Location header is an isError result", async () => {
    const { tool } = makeFetchHarness()
    const outcome = await tool.run({ url: "http://fixture.test/redirect/no-location" }, contextFor())
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain("Location")
  })
})

describe("web_fetch cache", () => {
  test("serves repeat 2xx fetches from the per-instance cache", async () => {
    const { tool } = makeFetchHarness()
    const url = "http://fixture.test/counted?k=hit"
    const first = await tool.run({ url }, contextFor())
    const second = await tool.run({ url }, contextFor())
    expect(first.text).toContain("count:1")
    expect(second.text).toContain("count:1")
    expect(hitCounts.get("?k=hit")).toBe(1)
    const fresh = makeFetchHarness()
    const third = await fresh.tool.run({ url }, contextFor())
    expect(third.text).toContain("count:2")
  })

  test("entries expire after the TTL", async () => {
    const { tool } = makeFetchHarness({ cacheTtlMs: 40 })
    const url = "http://fixture.test/counted?k=ttl"
    expect((await tool.run({ url }, contextFor())).text).toContain("count:1")
    await Bun.sleep(60)
    expect((await tool.run({ url }, contextFor())).text).toContain("count:2")
  })

  test("non-2xx results are not cached", async () => {
    const { tool } = makeFetchHarness()
    const url = "http://fixture.test/counted?k=nc&status=404"
    const first = await tool.run({ url }, contextFor())
    const second = await tool.run({ url }, contextFor())
    expect(first.isError).toBe(true)
    expect(first.text).toContain("count:1")
    expect(second.text).toContain("count:2")
  })
})

describe("htmlToMarkdown", () => {
  test("decodes entities exactly once", () => {
    expect(htmlToMarkdown("A &amp; B &lt;tag&gt; &#65; &#x42; &amp;lt;")).toBe("A & B <tag> A B &lt;")
  })

  test("drops head, script, style, noscript, and comments", () => {
    expect(
      htmlToMarkdown(
        "<head><title>t</title></head><script>x()</script><style>.a{}</style>" +
          "<noscript>no</noscript><!-- hidden -->kept",
      ),
    ).toBe("kept")
  })

  test("anchors without a usable href keep only their text", () => {
    expect(htmlToMarkdown('<a name="x">plain</a>')).toBe("plain")
    expect(htmlToMarkdown('<a href="#frag">frag</a>')).toBe("frag")
    expect(htmlToMarkdown('<a href="javascript:alert(1)">js</a>')).toBe("js")
    expect(htmlToMarkdown('<a href="https://a.test/">go</a>')).toBe("go (https://a.test/)")
  })

  test("collapses whitespace and blank runs", () => {
    expect(htmlToMarkdown("<p>one</p>\n\n\n\n<p>two   three</p>")).toBe("one\n\ntwo three")
  })

  test("preserves fenced pre content verbatim", () => {
    const markdown = htmlToMarkdown("<p>before</p><pre>  indented\n    lines</pre>")
    expect(markdown).toBe("before\n\n```\n  indented\n    lines\n```")
  })

  test("strips the placeholder delimiter so restoration cannot be spoofed", () => {
    expect(htmlToMarkdown("a\uE0000\uE000b<pre>code</pre>")).toBe("a0b\n\n```\ncode\n```")
  })
})

/* ---------------------------------- web_search ---------------------------------- */

function makeSearchTool(fetchImpl?: typeof fetch) {
  return createWebSearchTool({
    endpoint: `http://127.0.0.1:${server.port}/ddg`,
    fetchImpl,
  })
}

describe("web_search", () => {
  test("is read-only; permission mirrors web_fetch with the web-search session key", () => {
    const tool = createWebSearchTool()
    expect(tool.name).toBe("web_search")
    expect(tool.isReadOnly({ query: "x" })).toBe(true)
    expect(DEFAULT_SEARCH_ENDPOINT).toBe("https://html.duckduckgo.com/html/")
    const input = { query: "bun test runner" }
    expect(tool.permission(input, contextFor(onRequest))).toEqual({ kind: "none" })
    expect(tool.permission(input, contextFor(fullAccess))).toEqual({ kind: "none" })
    expect(tool.permission(input, contextFor(untrusted))).toEqual({
      kind: "approval",
      title: "Search the web?",
      detail: "bun test runner",
      sessionKey: "web-search",
    })
  })

  test("rejects bad input with ToolInputError", async () => {
    const tool = createWebSearchTool()
    const context = contextFor()
    await expect(tool.run("nope", context)).rejects.toThrow(ToolInputError)
    await expect(tool.run({}, context)).rejects.toThrow(ToolInputError)
    await expect(tool.run({ query: "  " }, context)).rejects.toThrow(ToolInputError)
    await expect(tool.run({ query: "x", count: 0 }, context)).rejects.toThrow(ToolInputError)
    await expect(tool.run({ query: "x", count: 1.5 }, context)).rejects.toThrow(ToolInputError)
    await expect(tool.run({ query: "x", count: "3" }, context)).rejects.toThrow(ToolInputError)
  })

  test("returns numbered title — url lines with indented snippets, skipping ads", async () => {
    const tool = makeSearchTool()
    const outcome = await tool.run({ query: "example query" }, contextFor())
    expect(outcome.isError).toBeUndefined()
    expect(outcome.label).toBe("web_search example query")
    expect(lastSearchQuery).toBe("example query")
    const lines = outcome.text.split("\n")
    // Result text is externally controlled, so the list opens with the untrusted notice.
    expect(lines[0]).toBe(UNTRUSTED_RESULTS_NOTICE)
    expect(lines[1]).toBe("")
    expect(lines[2]).toBe("1. Result 1 title — https://example.com/page-1?ref=1")
    expect(lines[3]).toBe("   Snippet 1 text & more.")
    expect(lines).toHaveLength(2 + DEFAULT_RESULT_COUNT * 2)
    expect(outcome.text).not.toContain("Sponsored")
  })

  test("count is honored and clamped at 10", async () => {
    const tool = makeSearchTool()
    const three = await tool.run({ query: "q", count: 3 }, contextFor())
    expect(three.text.split("\n").filter((line) => /^\d+\./.test(line))).toHaveLength(3)
    const clamped = await tool.run({ query: "q", count: 25 }, contextFor())
    const numbered = clamped.text.split("\n").filter((line) => /^\d+\./.test(line))
    expect(numbered).toHaveLength(MAX_RESULT_COUNT)
    expect(numbered[MAX_RESULT_COUNT - 1]).toStartWith("10. Result 10 title")
  })

  test("zero parsed results degrade to the unavailable message", async () => {
    const tool = createWebSearchTool({ endpoint: `http://127.0.0.1:${server.port}/ddg-empty` })
    const outcome = await tool.run({ query: "anything" }, contextFor())
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toBe(SEARCH_UNAVAILABLE_MESSAGE)
  })

  test("non-200 responses degrade to the unavailable message", async () => {
    const tool = createWebSearchTool({ endpoint: `http://127.0.0.1:${server.port}/ddg-503` })
    const outcome = await tool.run({ query: "anything" }, contextFor())
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toBe(SEARCH_UNAVAILABLE_MESSAGE)
  })

  test("network failures degrade to the unavailable message, never a throw", async () => {
    const failingFetch = (() => {
      return Promise.reject(new TypeError("fetch failed"))
    }) as unknown as typeof fetch
    const tool = createWebSearchTool({ fetchImpl: failingFetch })
    const outcome = await tool.run({ query: "anything" }, contextFor())
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toBe(SEARCH_UNAVAILABLE_MESSAGE)
  })

  test("an interrupted search is an isError result", async () => {
    const tool = makeSearchTool()
    const outcome = await tool.run({ query: "anything" }, abortedContext())
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain("interrupted")
  })

  test("parseSearchResults handles direct hrefs, div snippets, and attribute order", () => {
    const html = `
      <h2><a href="https://direct.example/path" class="result__a">Direct Hit</a></h2>
      <div class="result__snippet">A <b>div</b> snippet</div>
      <a class="result__a" href="ftp://bad.example/">Bad protocol</a>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://uddg.example/x?a=1")}&amp;rut=r">Via uddg</a>
    `
    expect(parseSearchResults(html)).toEqual([
      { title: "Direct Hit", url: "https://direct.example/path", snippet: "A div snippet" },
      { title: "Via uddg", url: "https://uddg.example/x?a=1" },
    ])
  })
})

/* ---------------------------------- registry ---------------------------------- */

describe("registry integration", () => {
  test("builtinTools lists web_fetch then web_search right after grep", () => {
    const names = builtinTools().map((tool) => tool.name)
    const grepIndex = names.indexOf("grep")
    expect(grepIndex).toBeGreaterThanOrEqual(0)
    expect(names[grepIndex + 1]).toBe("web_fetch")
    expect(names[grepIndex + 2]).toBe("web_search")
  })

  test("each builtinTools() call creates fresh web tool instances (per-instance cache)", () => {
    const first = builtinTools().find((tool) => tool.name === "web_fetch")
    const second = builtinTools().find((tool) => tool.name === "web_fetch")
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first).not.toBe(second)
  })
})
