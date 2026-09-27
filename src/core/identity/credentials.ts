import { createPrivateKey, sign } from "node:crypto"
import { isAbsolute } from "node:path"
import { networkFetch, responseBytes } from "../network.ts"
import { bytes, json } from "../session/files.ts"
import { deviceRefresh } from "./device.ts"
import { assertIdentityAllowed } from "./policy.ts"

/** Explicit credentials only: no subprocesses, CLI credential imports or repository commands. */
export type CloudIdentity = {
  kind: "bedrock" | "vertex" | "azure" | "openai-workload"
  authMode?: "device"
  region?: string
  project?: string
  tenant?: string
  clientId?: string
  clientSecretEnv?: string
  tokenFile?: string
  audience?: string
  identityProviderId?: string
  serviceAccountId?: string
}
export function validateIdentity(value: unknown): CloudIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid provider identity")
  const v = value as Record<string, unknown>
  if (!["bedrock", "vertex", "azure", "openai-workload"].includes(String(v.kind)))
    throw new Error("Unknown identity kind")
  for (const [k, item] of Object.entries(v)) {
    if (
      ![
        "kind",
        "authMode",
        "region",
        "project",
        "tenant",
        "clientId",
        "clientSecretEnv",
        "tokenFile",
        "audience",
        "identityProviderId",
        "serviceAccountId",
      ].includes(k) ||
      typeof item !== "string" ||
      !item ||
      item.length > 2048 ||
      /[\p{Cc}\p{Cf}]/u.test(item)
    )
      throw new Error("Invalid identity field")
  }
  for (const field of ["region", "project", "tenant", "clientId", "identityProviderId", "serviceAccountId"])
    if (v[field] !== undefined && !/^[a-zA-Z0-9._@-]+$/.test(String(v[field])))
      throw new Error("Invalid identity identifier")
  if (v.tokenFile !== undefined && !isAbsolute(String(v.tokenFile)))
    throw new Error("Identity token file must be absolute")
  if (v.clientSecretEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(String(v.clientSecretEnv)))
    throw new Error("Invalid identity environment name")
  if (
    v.authMode !== undefined &&
    (v.authMode !== "device" || v.kind !== "azure" || v.tokenFile || v.clientSecretEnv)
  )
    throw new Error("Invalid identity auth mode")
  const required =
    v.kind === "bedrock"
      ? ["region"]
      : v.kind === "vertex"
        ? ["region", "project"]
        : v.kind === "azure"
          ? ["tenant", "clientId"]
          : ["tokenFile", "identityProviderId", "serviceAccountId"]
  if (required.some((k) => !v[k])) throw new Error("Provider identity is missing required fields")
  return v as CloudIdentity
}
export type ExpiringToken = { value: string; expiresAt: number }
/** One refresh per instance; failed refresh never publishes partial state or reuses expired tokens. */
export function refreshingToken(load: () => Promise<ExpiringToken>, now = Date.now): () => Promise<string> {
  let current: ExpiringToken | undefined, pending: Promise<ExpiringToken> | undefined
  return async () => {
    if (current && current.expiresAt > now() + 60000) return current.value
    pending ??= load()
      .then((token) => {
        if (
          !token.value ||
          token.value.length > 65536 ||
          /\s/.test(token.value) ||
          !Number.isFinite(token.expiresAt) ||
          token.expiresAt <= now() + 5000
        )
          throw new Error("Identity returned an invalid or expired token")
        current = token
        return token
      })
      .finally(() => {
        pending = undefined
      })
    return (await pending).value
  }
}
function subject(path: string | undefined): string {
  if (!path) throw new Error("Identity requires a workload token file")
  const token = bytes(path, 65536).toString().trim()
  if (!token || /\s/.test(token)) throw new Error("Invalid workload token file")
  return token
}
async function exchange(url: string, fields: Record<string, string>, asJson = false): Promise<ExpiringToken> {
  const started = Date.now()
  const r = await networkFetch(
    url,
    {
      method: "POST",
      headers: { "content-type": asJson ? "application/json" : "application/x-www-form-urlencoded" },
      body: asJson ? JSON.stringify(fields) : new URLSearchParams(fields),
    },
    { timeoutMs: 30000 },
  )
  // Authentication errors can echo secrets. Never expose their response body or raw parser errors.
  if (!r.ok) {
    await r.body?.cancel()
    throw new Error(`Identity exchange failed (HTTP ${r.status})`)
  }
  let body: Record<string, unknown>
  try {
    body = JSON.parse((await responseBytes(r, 128 * 1024)).toString())
  } catch {
    throw new Error("Invalid identity response")
  }
  if (
    typeof body.access_token !== "string" ||
    String(body.token_type).toLowerCase() !== "bearer" ||
    typeof body.expires_in !== "number" ||
    body.expires_in <= 0 ||
    body.expires_in > 86400
  )
    throw new Error("Invalid identity response")
  const expiresAt =
    typeof body.expires_at === "number"
      ? Math.min(body.expires_at * 1000, started + body.expires_in * 1000)
      : started + body.expires_in * 1000
  return { value: body.access_token, expiresAt }
}
export function cloudBearer(
  identity: CloudIdentity,
  env: NodeJS.ProcessEnv = process.env,
): () => Promise<string> {
  validateIdentity(identity)
  const cached = refreshingToken(async () => {
    if (identity.kind === "openai-workload")
      return exchange(
        "https://auth.openai.com/oauth/token",
        {
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
          subject_token: subject(identity.tokenFile),
          identity_provider_id: identity.identityProviderId!,
          service_account_id: identity.serviceAccountId!,
        },
        true,
      )
    if (identity.kind === "azure") {
      if (identity.authMode === "device") return deviceRefresh(identity)
      const fields: Record<string, string> = {
        grant_type: "client_credentials",
        client_id: identity.clientId!,
        scope: "https://ai.azure.com/.default",
      }
      if (identity.tokenFile)
        Object.assign(fields, {
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: subject(identity.tokenFile),
        })
      else {
        const secret = env[identity.clientSecretEnv ?? "AZURE_CLIENT_SECRET"]
        if (!secret)
          throw new Error("Azure identity requires a secret environment variable or workload token file")
        fields.client_secret = secret
      }
      return exchange(`https://login.microsoftonline.com/${identity.tenant}/oauth2/v2.0/token`, fields)
    }
    if (identity.kind === "vertex") {
      if (identity.tokenFile) {
        if (!identity.audience?.startsWith("//iam.googleapis.com/projects/"))
          throw new Error("Vertex workload identity requires its configured IAM audience")
        return exchange("https://sts.googleapis.com/v1/token", {
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          audience: identity.audience,
          requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
          subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
          subject_token: subject(identity.tokenFile),
          scope: "https://www.googleapis.com/auth/cloud-platform",
        })
      }
      const path = env.GOOGLE_APPLICATION_CREDENTIALS
      if (!path) throw new Error("Vertex requires GOOGLE_APPLICATION_CREDENTIALS or workload identity")
      const credential = json<Record<string, unknown>>(path, 128 * 1024)
      if (
        credential.type !== "service_account" ||
        typeof credential.client_email !== "string" ||
        typeof credential.private_key !== "string"
      )
        throw new Error(
          "Vertex credential file must contain a service account; use explicit workload fields for OIDC",
        )
      const issued = Math.floor(Date.now() / 1000)
      const encode = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url")
      const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: credential.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: issued, exp: issued + 3600 })}`
      let signature: string
      try {
        const key = createPrivateKey(credential.private_key)
        if (key.asymmetricKeyType !== "rsa") throw new Error()
        signature = sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")
      } catch {
        throw new Error("Invalid service account signing key")
      }
      return exchange("https://oauth2.googleapis.com/token", {
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      })
    }
    throw new Error("Bedrock requires AWS request signing")
  })
  return () => {
    assertIdentityAllowed(
      identity.authMode === "device" ? "azure-device" : identity.kind,
      identity.tenant ?? identity.project,
      undefined,
      env,
    )
    return cached()
  }
}
