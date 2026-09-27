/** Explicit registered public-client OAuth (RFC 8252 / S256 PKCE). No vendor CLI credentials. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { configDirectory } from "../config.ts"
import { networkFetch, responseBytes } from "../network.ts"
import { digest, directory, lease } from "../session/files.ts"
import { keyringDelete, keyringGet, keyringSet, type SecretStore } from "./keyring.ts"
import { assertIdentityAllowed } from "./policy.ts"
export type BrowserIdentity = {
  clientId: string
  authorizationUrl: string
  tokenUrl: string
  scope: string
  resourceOrigin: string
  revocationUrl?: string
}
export function browserIdentity(raw: unknown): BrowserIdentity {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid browser identity")
  const p = raw as Record<string, unknown>
  for (const [key, value] of Object.entries(p))
    if (
      !["clientId", "authorizationUrl", "tokenUrl", "scope", "resourceOrigin", "revocationUrl"].includes(
        key,
      ) ||
      typeof value !== "string" ||
      !value ||
      value.length > 2048 ||
      /[\p{Cc}\p{Cf}]/u.test(value)
    )
      throw new Error("Invalid browser identity field")
  if (
    !["clientId", "authorizationUrl", "tokenUrl", "scope", "resourceOrigin"].every(
      (key) => typeof p[key] === "string",
    )
  )
    throw new Error("Incomplete browser identity")
  const auth = new URL(p.authorizationUrl as string)
  for (const value of [p.authorizationUrl, p.tokenUrl, p.revocationUrl].filter(Boolean)) {
    const url = new URL(value as string)
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      url.origin !== auth.origin
    )
      throw new Error("OAuth endpoints require explicit same-issuer HTTPS URLs without queries")
  }
  const resource = new URL(p.resourceOrigin as string)
  if (resource.protocol !== "https:" || resource.origin !== p.resourceOrigin)
    throw new Error("Browser identity requires an exact HTTPS resource origin")
  if (
    !/^[A-Za-z0-9._:/-]+$/.test(p.clientId as string) ||
    (p.scope as string).split(" ").some((s) => !s || /["\\]/.test(s))
  )
    throw new Error("Invalid OAuth client id or scope")
  return {
    clientId: p.clientId as string,
    authorizationUrl: p.authorizationUrl as string,
    tokenUrl: p.tokenUrl as string,
    scope: p.scope as string,
    resourceOrigin: p.resourceOrigin as string,
    ...(p.revocationUrl ? { revocationUrl: p.revocationUrl as string } : {}),
  }
}
function account(identity: BrowserIdentity): string {
  return `browser:${digest(JSON.stringify(browserIdentity(identity)))}`
}
function allowed(identity: BrowserIdentity) {
  assertIdentityAllowed("browser-pkce", new URL(identity.authorizationUrl).origin)
}
type Options = { root?: string; store?: SecretStore; signal?: AbortSignal }
async function post(
  url: string,
  fields: Record<string, string>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await networkFetch(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
      redirect: "error",
      signal,
    },
    { timeoutMs: 30000 },
  )
  const data = await responseBytes(new Response(response.body), 128 * 1024)
  if (!response.ok)
    throw new Error(`Browser identity exchange failed (HTTP ${response.status}); log in again explicitly`)
  try {
    const result = JSON.parse(data.toString())
    if (!result || typeof result !== "object" || Array.isArray(result)) throw 0
    return result
  } catch {
    throw new Error("Invalid browser identity response")
  }
}
type Tokens = { access: string; refresh?: string; expiresAt: number }
function tokens(raw: Record<string, unknown>, previousRefresh?: string): Tokens {
  if (
    typeof raw.access_token !== "string" ||
    !raw.access_token ||
    raw.access_token.length > 65536 ||
    /\s/.test(raw.access_token) ||
    String(raw.token_type).toLowerCase() !== "bearer" ||
    typeof raw.expires_in !== "number" ||
    !Number.isFinite(raw.expires_in) ||
    raw.expires_in < 10 ||
    raw.expires_in > 86400 ||
    (raw.refresh_token !== undefined &&
      (typeof raw.refresh_token !== "string" ||
        !raw.refresh_token ||
        raw.refresh_token.length > 65536 ||
        /\s/.test(raw.refresh_token)))
  )
    throw new Error("Invalid browser identity token")
  return {
    access: raw.access_token,
    expiresAt: Date.now() + raw.expires_in * 1000,
    refresh: (raw.refresh_token as string | undefined) ?? previousRefresh,
  }
}
export async function browserLogin(
  raw: BrowserIdentity,
  show: (url: string) => void | Promise<void>,
  options: Options = {},
): Promise<void> {
  const identity = browserIdentity(raw)
  allowed(identity)
  const root = options.root ?? configDirectory(),
    store = options.store ?? Bun.secrets,
    key = account(identity)
  await keyringGet(key, root, store)
  directory(root, true)
  const release = lease(root, `${key.replace(":", "-")}.lease`)
  const signal = AbortSignal.any([
    options.signal ?? new AbortController().signal,
    AbortSignal.timeout(300000),
  ])
  const verifier = randomBytes(32).toString("base64url"),
    state = randomBytes(32).toString("base64url")
  let finish: (code: string) => void = () => {},
    reject: (error: Error) => void = () => {},
    accepted = false
  const code = new Promise<string>((resolve, fail) => {
    finish = resolve
    reject = fail
  })
  // Own rejection immediately, including failures before show() returns.
  void code.catch(() => {})
  let server: ReturnType<typeof Bun.serve> | undefined
  const abort = () => reject(new Error("Browser login cancelled or timed out"))
  try {
    signal.throwIfAborted()
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        const response = (text: string, status: number) =>
          new Response(text, {
            status,
            headers: {
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
              "content-security-policy": "default-src 'none'",
            },
          })
        if (
          request.method !== "GET" ||
          request.headers.get("host") !== `127.0.0.1:${server!.port}` ||
          url.pathname !== "/oauth/callback" ||
          request.headers.has("origin")
        )
          return response("Invalid callback", 400)
        const candidate = url.searchParams.get("state") ?? ""
        if (
          !/^[A-Za-z0-9_-]{43}$/.test(candidate) ||
          !timingSafeEqual(Buffer.from(candidate), Buffer.from(state)) ||
          url.searchParams.getAll("state").length !== 1 ||
          accepted
        )
          return response("Invalid callback state", 400)
        if (url.searchParams.has("error")) {
          accepted = true
          reject(new Error("Browser authorization was denied"))
          return response("Authorization denied. Return to the terminal.", 400)
        }
        const value = url.searchParams.get("code")
        if (!value || value.length > 8192 || /\s/.test(value) || url.searchParams.getAll("code").length !== 1)
          return response("Invalid authorization code", 400)
        accepted = true
        finish(value)
        return response("Authorization received. Return to the terminal.", 200)
      },
    })
    const redirect = `http://127.0.0.1:${server.port}/oauth/callback`,
      url = new URL(identity.authorizationUrl)
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: identity.clientId,
      scope: identity.scope,
      redirect_uri: redirect,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }))
      url.searchParams.set(key, value)
    signal.addEventListener("abort", abort, { once: true })
    await show(url.href)
    const value = await code
    allowed(identity)
    signal.throwIfAborted()
    const result = tokens(
      await post(
        identity.tokenUrl,
        {
          grant_type: "authorization_code",
          client_id: identity.clientId,
          code: value,
          redirect_uri: redirect,
          code_verifier: verifier,
        },
        signal,
      ),
    )
    signal.throwIfAborted()
    await keyringSet(key, JSON.stringify(result), root, store)
  } finally {
    signal.removeEventListener("abort", abort)
    await server?.stop(true)
    release()
  }
}
export async function browserToken(raw: BrowserIdentity, options: Options = {}): Promise<string> {
  const identity = browserIdentity(raw)
  allowed(identity)
  const root = options.root ?? configDirectory(),
    store = options.store ?? Bun.secrets,
    key = account(identity)
  directory(root, true)
  const release = lease(root, `${key.replace(":", "-")}.lease`)
  try {
    const saved = await keyringGet(key, root, store)
    if (!saved) throw new Error("Browser identity is not logged in")
    const token = JSON.parse(saved) as Tokens
    if (!token.access || typeof token.access !== "string" || !Number.isFinite(token.expiresAt))
      throw new Error("Invalid stored browser identity; log in again")
    if (token.expiresAt > Date.now() + 60000) return token.access
    if (!token.refresh) throw new Error("Browser identity expired; log in again")
    const result = tokens(
      await post(
        identity.tokenUrl,
        { grant_type: "refresh_token", client_id: identity.clientId, refresh_token: token.refresh },
        options.signal,
      ),
      token.refresh,
    )
    await keyringSet(key, JSON.stringify(result), root, store)
    return result.access
  } finally {
    release()
  }
}
export async function browserLogout(raw: BrowserIdentity, options: Options = {}): Promise<void> {
  const identity = browserIdentity(raw),
    root = options.root ?? configDirectory(),
    store = options.store ?? Bun.secrets,
    key = account(identity)
  directory(root, true)
  const release = lease(root, `${key.replace(":", "-")}.lease`)
  try {
    const saved = await keyringGet(key, root, store)
    try {
      if (saved && identity.revocationUrl) {
        allowed(identity)
        const token = JSON.parse(saved) as Tokens
        const response = await networkFetch(
          identity.revocationUrl,
          {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: identity.clientId,
              token: token.refresh ?? token.access,
              token_type_hint: token.refresh ? "refresh_token" : "access_token",
            }),
            redirect: "error",
            signal: options.signal,
          },
          { timeoutMs: 30000 },
        )
        await response.body?.cancel()
        if (!response.ok) throw new Error("Remote revocation failed; local credentials were removed")
      }
    } finally {
      await keyringDelete(key, root, store)
    }
  } finally {
    release()
  }
}
