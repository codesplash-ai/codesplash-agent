import { timingSafeEqual } from "node:crypto"
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  refreshAuthorization,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client"
import type { SandboxProfile } from "../sandbox/contracts.ts"
import { boundedJson } from "./bounds.ts"
import { McpOAuthIndex } from "./oauth-index.ts"
import { openMcpOAuthNetwork } from "./oauth-network.ts"
import { McpOAuthStore, type ProtectedCredentialStore, withMcpOAuthLock } from "./oauth-store.ts"
import type { McpReview } from "./trust.ts"

function expiry(tokens: StoredOAuthTokens): number {
  const seconds = tokens.expires_in ?? 300
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 31_536_000)
    throw new Error("Invalid OAuth token lifetime")
  return Date.now() + seconds * 1000
}
function matchesState(actual: string | null, expected: string): boolean {
  return (
    actual !== null &&
    Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  )
}

async function waitForAuthorization(authorize: () => Promise<URL>, signal: AbortSignal): Promise<URL> {
  signal.throwIfAborted()
  let cancel: () => void = () => {}
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(new Error("MCP authorization cancelled or timed out"))
    signal.addEventListener("abort", cancel, { once: true })
  })
  try {
    return await Promise.race([authorize(), cancelled])
  } finally {
    signal.removeEventListener("abort", cancel)
  }
}

/** Explicit login plus serialized refresh; no transport-triggered consent or tool repost. */
export class McpOAuth {
  readonly store: McpOAuthStore
  readonly index: McpOAuthIndex
  constructor(
    readonly options: {
      review: McpReview
      profile: SandboxProfile
      dataDir: string
      store?: ProtectedCredentialStore
    },
  ) {
    if (!options.review.config.oauth || !options.review.config.url)
      throw new Error("MCP server has no OAuth configuration")
    this.store = new McpOAuthStore(options.review.fingerprint, options.store)
    this.index = new McpOAuthIndex(options.dataDir, options.review.cwd, options.review.serverId)
  }
  login(
    redirectUrl: URL,
    authorize: (url: URL, signal: AbortSignal) => Promise<URL>,
    signal: AbortSignal,
  ): Promise<void> {
    return withMcpOAuthLock(this.options.dataDir, this.index.identity, async () => {
      signal.throwIfAborted()
      if (
        redirectUrl.protocol !== "http:" ||
        redirectUrl.hostname !== "127.0.0.1" ||
        !redirectUrl.port ||
        redirectUrl.search ||
        redirectUrl.hash ||
        redirectUrl.username ||
        redirectUrl.password
      )
        throw new Error("OAuth callback must be an exact loopback HTTP URL")
      await this.store.probe()
      const { review, profile } = this.options
      const serverUrl = new URL(review.config.url ?? "")
      const network = await openMcpOAuthNetwork(profile, review.config, signal)
      let discovery: OAuthDiscoveryState | undefined,
        client: StoredOAuthClientInformation | undefined,
        tokens: StoredOAuthTokens | undefined
      let verifier: string | undefined, authorization: URL | undefined, resource: string | undefined
      const state = crypto.randomUUID() + crypto.randomUUID()
      const provider: OAuthClientProvider = {
        redirectUrl,
        clientMetadata: {
          client_name: "CodeSplash Agent",
          redirect_uris: [redirectUrl.href],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: review.config.oauth?.scopes.join(" ") ?? "",
        },
        state: () => state,
        clientInformation(context) {
          if (client && (!context || client.issuer === context.issuer)) return client
          const clientId = review.config.oauth?.clientId
          if (clientId && context?.issuer) {
            client = { client_id: clientId, issuer: context.issuer }
            return client
          }
          return undefined
        },
        saveClientInformation(value, context) {
          value = JSON.parse(boundedJson(value, 128 * 1024, 5000, true)) as typeof value
          if (!context?.issuer || value.issuer !== context.issuer)
            throw new Error("OAuth client issuer mismatch")
          client = value
        },
        tokens: () => undefined,
        saveTokens(value, context) {
          value = JSON.parse(boundedJson(value, 128 * 1024, 5000, true)) as typeof value
          if (!context?.issuer || value.issuer !== context.issuer)
            throw new Error("OAuth token issuer mismatch")
          tokens = value
        },
        redirectToAuthorization(url) {
          network.check(url)
          if (
            url.searchParams.get("state") !== state ||
            url.searchParams.get("redirect_uri") !== redirectUrl.href ||
            url.searchParams.get("code_challenge_method") !== "S256"
          )
            throw new Error("OAuth authorization request omitted required bindings")
          authorization = url
        },
        saveCodeVerifier(value) {
          if (value.length < 43 || value.length > 128) throw new Error("Invalid PKCE verifier")
          verifier = value
        },
        codeVerifier() {
          if (!verifier) throw new Error("Missing PKCE verifier")
          return verifier
        },
        saveDiscoveryState(value) {
          value = JSON.parse(boundedJson(value, 128 * 1024, 5000, true)) as typeof value
          if (!value.authorizationServerMetadata?.issuer)
            throw new Error("OAuth server must publish issuer metadata")
          if (
            discovery &&
            value.authorizationServerMetadata.issuer !== discovery.authorizationServerMetadata?.issuer
          )
            throw new Error("OAuth issuer changed during login")
          discovery = value
        },
        discoveryState: () => discovery,
        async validateResourceURL(_server, advertised) {
          const url = new URL(advertised ?? serverUrl.href)
          if (
            url.origin !== serverUrl.origin ||
            url.search ||
            url.hash ||
            url.username ||
            url.password ||
            !(
              url.pathname === serverUrl.pathname ||
              serverUrl.pathname.startsWith(url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`)
            )
          )
            throw new Error("OAuth resource does not cover the reviewed MCP endpoint")
          resource = url.href
          return url
        },
      }
      try {
        const result = await auth(provider, {
          serverUrl,
          fetchFn: network.fetch,
          scope: review.config.oauth?.scopes.join(" "),
          forceReauthorization: true,
        })
        if (result !== "REDIRECT" || !authorization)
          throw new Error("OAuth server did not provide a consent redirect")
        const redirect = authorization
        const callback = await waitForAuthorization(() => authorize(redirect, signal), signal)
        signal.throwIfAborted()
        if (
          callback.origin !== redirectUrl.origin ||
          callback.pathname !== redirectUrl.pathname ||
          callback.hash ||
          callback.href.length > 16_384 ||
          !matchesState(callback.searchParams.get("state"), state) ||
          callback.searchParams.getAll("state").length !== 1 ||
          callback.searchParams.getAll("code").length !== 1 ||
          callback.searchParams.getAll("iss").length > 1 ||
          callback.searchParams.has("error")
        )
          throw new Error("OAuth callback failed state or redirect validation")
        const code = callback.searchParams.get("code")
        if (!code || code.length > 8192) throw new Error("OAuth callback omitted a valid code")
        const completed = await auth(provider, {
          serverUrl,
          authorizationCode: code,
          ...(callback.searchParams.has("iss") ? { iss: callback.searchParams.get("iss") ?? "" } : {}),
          fetchFn: network.fetch,
        })
        if (completed !== "AUTHORIZED" || !tokens || !client || !discovery || !resource)
          throw new Error("OAuth login did not produce a bound credential set")
        const issuer = discovery.authorizationServerMetadata?.issuer
        if (!issuer || tokens.issuer !== issuer || client.issuer !== issuer)
          throw new Error("OAuth issuer changed during login")
        this.index.record(this.store.identity)
        await this.store.write({
          version: 1,
          identity: this.store.identity,
          resource,
          issuer,
          client,
          tokens,
          discovery,
          expiresAt: expiry(tokens),
        })
      } catch (error) {
        throw new Error("MCP OAuth login failed; no new credentials were activated", { cause: error })
      } finally {
        verifier = undefined
        tokens = undefined
        await network.close()
      }
    })
  }
  token(signal: AbortSignal): Promise<string> {
    return withMcpOAuthLock(this.options.dataDir, this.index.identity, async () => {
      signal.throwIfAborted()
      const credentials = await this.store.read()
      if (!credentials || credentials.refreshBlocked) throw new Error("MCP OAuth login is required")
      if (credentials.expiresAt > Date.now() + 30_000) return credentials.tokens.access_token
      if (!credentials.tokens.refresh_token) throw new Error("MCP OAuth token expired; log in again")
      const network = await openMcpOAuthNetwork(this.options.profile, this.options.review.config, signal)
      try {
        // A crash/network failure after sending a rotating refresh must not trigger another automatic exchange.
        await this.store.write({ ...credentials, refreshBlocked: true })
        const refreshed = await refreshAuthorization(credentials.discovery.authorizationServerUrl, {
          metadata: credentials.discovery.authorizationServerMetadata,
          clientInformation: credentials.client,
          refreshToken: credentials.tokens.refresh_token,
          resource: new URL(credentials.resource),
          fetchFn: network.fetch,
        })
        const tokens = {
          ...refreshed,
          refresh_token: refreshed.refresh_token ?? credentials.tokens.refresh_token,
          issuer: credentials.issuer,
        }
        await this.store.write({ ...credentials, tokens, expiresAt: expiry(tokens), refreshBlocked: false })
        return tokens.access_token
      } catch (error) {
        throw new Error("MCP OAuth refresh failed or is uncertain; explicit login is required", {
          cause: error,
        })
      } finally {
        await network.close()
      }
    })
  }
  logout(): Promise<void> {
    return this.index.logout(this.store.backend, this.store.identity)
  }
}
