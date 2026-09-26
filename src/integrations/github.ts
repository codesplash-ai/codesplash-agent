import { createHmac, createPublicKey, sign, timingSafeEqual, verify } from "node:crypto"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { atomic, bytes, digest } from "../core/session/files.ts"
import type { ChatBridge } from "./bridge.ts"

export type GithubPolicy = {
  repository: string
  repositoryId: string
  ref: string
  workflowRef: string
  workflowSha: string
  audience: string
  installationId: number
  allowedActors: string[]
}
export async function verifyGithubOidc(
  token: string,
  policy: GithubPolicy,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  if (token.length > 16384) throw new Error("OIDC token exceeds limit")
  const parts = token.split(".")
  if (parts.length !== 3) throw new Error("Invalid OIDC token")
  const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString()),
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString())
  if (header.alg !== "RS256" || typeof header.kid !== "string" || header.jku || header.x5u)
    throw new Error("Unsupported OIDC signing key")
  const response = await fetcher("https://token.actions.githubusercontent.com/.well-known/jwks", {
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error("GitHub signing keys unavailable")
  const jwks = await response.json(),
    jwk = jwks.keys?.find(
      (key: { kid: string; kty: string; alg: string; use: string }) =>
        key.kid === header.kid && key.kty === "RSA" && key.alg === "RS256" && key.use === "sig",
    )
  if (
    !jwk ||
    !verify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key: jwk, format: "jwk" }),
      Buffer.from(parts[2]!, "base64url"),
    )
  )
    throw new Error("Invalid OIDC signature")
  const seconds = now / 1000
  if (
    claims.iss !== "https://token.actions.githubusercontent.com" ||
    claims.aud !== policy.audience ||
    claims.repository !== policy.repository ||
    claims.repository_id !== policy.repositoryId ||
    claims.ref !== policy.ref ||
    claims.job_workflow_ref !== policy.workflowRef ||
    claims.job_workflow_sha !== policy.workflowSha ||
    claims.event_name === "pull_request_target" ||
    claims.event_name === "pull_request" ||
    !policy.allowedActors.includes(claims.actor) ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= seconds ||
    claims.exp > seconds + 600 ||
    !Number.isFinite(claims.iat) ||
    claims.iat > seconds + 30 ||
    claims.iat < seconds - 600 ||
    (claims.nbf !== undefined && claims.nbf > seconds + 30) ||
    typeof claims.jti !== "string"
  )
    throw new Error("OIDC claims do not match the pinned workflow policy")
  return { jti: claims.jti as string, expires: claims.exp as number }
}
export function verifyGithubWebhook(body: string, signature: string, secret: string) {
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
  return (
    /^sha256=[a-f0-9]{64}$/.test(signature) && timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  )
}
export function appJwt(appId: string, privateKey: string, now = Date.now()) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
    payload = Buffer.from(
      JSON.stringify({ iat: Math.floor(now / 1000) - 30, exp: Math.floor(now / 1000) + 540, iss: appId }),
    ).toString("base64url")
  const content = `${header}.${payload}`
  return `${content}.${sign("RSA-SHA256", Buffer.from(content), privateKey).toString("base64url")}`
}
export async function installationToken(
  policy: GithubPolicy,
  appId: string,
  key: string,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(
    `https://api.github.com/app/installations/${policy.installationId}/access_tokens`,
    {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${appJwt(appId, key)}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        repository_ids: [Number(policy.repositoryId)],
        permissions: { issues: "write", pull_requests: "write", contents: "read" },
      }),
    },
  )
  if (!response.ok) throw new Error("GitHub App installation token exchange failed")
  const value = await response.json()
  if (typeof value.token !== "string") throw new Error("Invalid installation token response")
  return { token: value.token as string, expiresAt: value.expires_at as string }
}
export class GithubApp {
  #used = new Map<string, number>()
  constructor(
    readonly options: {
      policy: GithubPolicy
      appId: string
      privateKey: string
      webhookSecret: string
      bridge: ChatBridge
      fetcher?: typeof fetch
    },
  ) {
    const path = join(dirname(options.bridge.path), "github-oidc-used.json")
    if (existsSync(path)) this.#used = new Map(JSON.parse(bytes(path, 2 * 1024 * 1024).toString()))
  }
  async route(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== "POST" || !["/github/oidc", "/github/webhook"].includes(url.pathname))
      return new Response("Not found", { status: 404 })
    if (Number(request.headers.get("content-length")) > 1024 * 1024)
      return new Response("Too large", { status: 413 })
    const body = await request.text()
    if (Buffer.byteLength(body) > 1024 * 1024) return new Response("Too large", { status: 413 })
    try {
      if (url.pathname === "/github/oidc") {
        const { token } = JSON.parse(body)
        if (typeof token !== "string") throw new Error("Token required")
        const verified = await verifyGithubOidc(token, this.options.policy, this.options.fetcher)
        for (const [id, expires] of this.#used) if (expires < Date.now() / 1000) this.#used.delete(id)
        const key = digest(verified.jti)
        if (this.#used.has(key) || this.#used.size >= 10000) throw new Error("OIDC token replay")
        this.#used.set(key, verified.expires)
        atomic(
          join(dirname(this.options.bridge.path), "github-oidc-used.json"),
          JSON.stringify([...this.#used]),
        )
        return Response.json(
          await installationToken(
            this.options.policy,
            this.options.appId,
            this.options.privateKey,
            this.options.fetcher,
          ),
          { headers: { "Cache-Control": "no-store" } },
        )
      }
      if (
        !verifyGithubWebhook(
          body,
          request.headers.get("x-hub-signature-256") ?? "",
          this.options.webhookSecret,
        )
      )
        return new Response("Unauthorized", { status: 401 })
      const event = JSON.parse(body),
        delivery = request.headers.get("x-github-delivery")
      if (
        request.headers.get("x-github-event") !== "issue_comment" ||
        event.action !== "created" ||
        event.repository?.full_name !== this.options.policy.repository ||
        String(event.repository?.id) !== this.options.policy.repositoryId ||
        !this.options.policy.allowedActors.includes(event.sender?.login) ||
        event.sender?.type === "Bot" ||
        typeof event.comment?.body !== "string" ||
        !/(^|\s)@codesplash\b/i.test(event.comment.body) ||
        !Number.isSafeInteger(event.issue?.number) ||
        !delivery
      )
        return Response.json({ ignored: true })
      const issue = event.issue.number as number
      void this.options.bridge
        .deliver(
          {
            delivery: `github:${delivery}`,
            conversation: `github:${this.options.policy.repository}:${issue}`,
            text: event.comment.body,
            provenance: `GitHub ${this.options.policy.repository}#${issue} (${event.sender.login})`,
          },
          async (text) => {
            const credentials = await installationToken(
              this.options.policy,
              this.options.appId,
              this.options.privateKey,
              this.options.fetcher,
            )
            const response = await (this.options.fetcher ?? fetch)(
              `https://api.github.com/repos/${this.options.policy.repository}/issues/${issue}/comments`,
              {
                method: "POST",
                redirect: "error",
                headers: {
                  authorization: `Bearer ${credentials.token}`,
                  accept: "application/vnd.github+json",
                  "content-type": "application/json",
                },
                body: JSON.stringify({ body: text }),
              },
            )
            if (!response.ok) throw new Error("GitHub reply failed")
          },
        )
        .catch(() => {})
      return Response.json({ accepted: true }, { status: 202 })
    } catch {
      return new Response("Request rejected", { status: 403 })
    }
  }
}
