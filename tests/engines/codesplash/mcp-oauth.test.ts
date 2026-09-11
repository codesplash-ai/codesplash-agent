import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runMcpLogin } from "../../../src/commands/mcp-login.ts"
import { validateConfig } from "../../../src/core/config.ts"
import { McpOAuth } from "../../../src/engines/codesplash/mcp/oauth.ts"
import type { ProtectedCredentialStore } from "../../../src/engines/codesplash/mcp/oauth-store.ts"
import { reviewMcpServer } from "../../../src/engines/codesplash/mcp/trust.ts"
import { createProfile } from "../../../src/engines/codesplash/sandbox/profile.ts"

async function setup() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "cs-mcp-oauth-")))
  const values = new Map<string, string>()
  const store: ProtectedCredentialStore = {
    get: async (id) => values.get(id) ?? null,
    set: async (id, value) => {
      values.set(id, value)
    },
    delete: async (id) => {
      values.delete(id)
    },
  }
  let requests = 0,
    exchanges = 0,
    refreshes = 0,
    registrations = 0,
    challenge = "",
    failRefresh = false
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      requests++
      const url = new URL(request.url),
        origin = url.origin
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
        return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] })
      if (url.pathname.startsWith("/.well-known/"))
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
          authorization_response_iss_parameter_supported: true,
        })
      if (url.pathname === "/register") {
        registrations++
        return Response.json(
          { ...((await request.json()) as object), client_id: "fixture-client" },
          { status: 201 },
        )
      }
      if (url.pathname === "/token") {
        const form = new URLSearchParams(await request.text())
        if (form.get("grant_type") === "refresh_token") {
          refreshes++
          if (failRefresh) return Response.json({ error: "server_error" }, { status: 500 })
          return Response.json({
            access_token: "refreshed-fixture-token",
            refresh_token: "rotated-fixture-refresh",
            token_type: "Bearer",
            expires_in: 3600,
          })
        }
        exchanges++
        if (
          form.get("code") !== "fixture-code" ||
          createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url") !== challenge ||
          form.get("resource") !== `${origin}/mcp`
        )
          return Response.json({ error: "invalid_grant" }, { status: 400 })
        return Response.json({
          access_token: "fixture-access-token",
          refresh_token: "fixture-refresh-token",
          token_type: "Bearer",
          expires_in: 1,
        })
      }
      return new Response(null, { status: 404 })
    },
  })
  const config = validateConfig(
    {
      mcp: {
        servers: {
          fixture: {
            transport: "http",
            url: `http://127.0.0.1:${server.port}/mcp`,
            allowLoopback: true,
            oauth: { scopes: ["fixture:read"] },
          },
        },
      },
    },
    "fixture",
  )
  const review = await reviewMcpServer(config, "fixture", cwd)
  const make = (backend = store) =>
    new McpOAuth({ review, profile: createProfile(cwd, "read-only"), dataDir: cwd, store: backend })
  const redirect = new URL("http://127.0.0.1:9876/oauth/callback")
  const authorize = async (url: URL) => {
    challenge = url.searchParams.get("code_challenge") ?? ""
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    const callback = new URL(url.searchParams.get("redirect_uri") ?? "")
    callback.searchParams.set("code", "fixture-code")
    callback.searchParams.set("state", url.searchParams.get("state") ?? "")
    callback.searchParams.set("iss", `http://127.0.0.1:${server.port}`)
    return callback
  }
  return {
    make,
    values,
    redirect,
    authorize,
    get requests() {
      return requests
    },
    get exchanges() {
      return exchanges
    },
    get refreshes() {
      return refreshes
    },
    get registrations() {
      return registrations
    },
    failRefresh() {
      failRefresh = true
    },
    async close() {
      await server.stop(true)
      await rm(cwd, { recursive: true, force: true })
    },
  }
}

test("MCP OAuth binds DCR, PKCE, state, issuer and resource, serializes rotation and logs out", async () => {
  const fixture = await setup(),
    oauth = fixture.make()
  try {
    await oauth.login(fixture.redirect, fixture.authorize, AbortSignal.timeout(5000))
    expect(fixture.exchanges).toBe(1)
    expect(fixture.registrations).toBe(1)
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => fixture.make().token(AbortSignal.timeout(5000))),
    )
    expect(new Set(tokens)).toEqual(new Set(["refreshed-fixture-token"]))
    expect(fixture.refreshes).toBe(1)
    await oauth.logout()
    expect(fixture.values.size).toBe(0)
    await expect(oauth.token(AbortSignal.timeout(1000))).rejects.toThrow("login is required")
  } finally {
    await fixture.close()
  }
})

test("MCP OAuth rejects substituted state and issuer before exchanging the code", async () => {
  const fixture = await setup()
  try {
    for (const key of ["state", "iss"]) {
      await expect(
        fixture.make().login(
          fixture.redirect,
          async (url) => {
            const callback = await fixture.authorize(url)
            callback.searchParams.set(key, "substituted")
            return callback
          },
          AbortSignal.timeout(5000),
        ),
      ).rejects.toThrow("login failed")
    }
    expect(fixture.exchanges).toBe(0)
    expect(fixture.values.size).toBe(0)
  } finally {
    await fixture.close()
  }
})

test("unavailable protected storage refuses login before auth network; uncertain refresh requires login", async () => {
  const fixture = await setup()
  try {
    const unavailable: ProtectedCredentialStore = {
      get: async () => null,
      set: async () => {
        throw new Error("store unavailable")
      },
      delete: async () => {},
    }
    await expect(
      fixture.make(unavailable).login(fixture.redirect, fixture.authorize, AbortSignal.timeout(5000)),
    ).rejects.toThrow("store unavailable")
    expect(fixture.requests).toBe(0)
    const oauth = fixture.make()
    await oauth.login(fixture.redirect, fixture.authorize, AbortSignal.timeout(5000))
    fixture.failRefresh()
    await expect(oauth.token(AbortSignal.timeout(5000))).rejects.toThrow("uncertain")
    await expect(fixture.make().token(AbortSignal.timeout(5000))).rejects.toThrow("login is required")
    expect(fixture.refreshes).toBe(1)
  } finally {
    await fixture.close()
  }
})

test("MCP authorization cancellation settles a nonresponsive embedding responder", async () => {
  const fixture = await setup()
  try {
    await expect(
      fixture
        .make()
        .login(fixture.redirect, async () => new Promise<URL>(() => {}), AbortSignal.timeout(100)),
    ).rejects.toThrow("login failed")
    expect(fixture.values.size).toBe(0)
    expect(fixture.exchanges).toBe(0)
  } finally {
    await fixture.close()
  }
})

test("MCP login CLI rejects unrelated callbacks and closes its listener", async () => {
  let endpoint: URL | undefined,
    printed = ""
  await runMcpLogin(
    {
      async login(redirect, authorize, signal) {
        endpoint = redirect
        const url = new URL("https://auth.example.test/authorize?state=fixture-state")
        const callback = authorize(url, signal)
        const wrong = new URL(redirect)
        wrong.searchParams.set("state", "unrelated")
        expect((await fetch(wrong)).status).toBe(400)
        const correct = new URL(redirect)
        correct.searchParams.set("state", "fixture-state")
        correct.searchParams.set("code", "fixture-code")
        expect((await fetch(correct)).status).toBe(200)
        expect((await callback).href).toBe(correct.href)
      },
    },
    (text) => {
      printed += text
    },
  )
  expect(printed).toContain("Open this URL")
  expect(endpoint).toBeDefined()
  await expect(fetch(endpoint as URL)).rejects.toThrow()
})

test("OAuth logout removes previous source generations without reusing their credentials", async () => {
  const fixture = await setup(),
    oauth = fixture.make()
  try {
    await oauth.login(fixture.redirect, fixture.authorize, AbortSignal.timeout(5000))
    const changed = new McpOAuth({
      ...oauth.options,
      review: { ...oauth.options.review, fingerprint: "a".repeat(64) },
    })
    await expect(changed.token(AbortSignal.timeout(1000))).rejects.toThrow("login is required")
    expect(oauth.index.read()).toEqual([oauth.store.identity])
    await changed.logout()
    expect(fixture.values.size).toBe(0)
    expect(oauth.index.read()).toEqual([])
  } finally {
    await fixture.close()
  }
})
