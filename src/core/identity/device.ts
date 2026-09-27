import { setTimeout as delay } from "node:timers/promises"
import { configDirectory } from "../config.ts"
import { networkFetch, responseBytes } from "../network.ts"
import { digest, lease } from "../session/files.ts"
import type { CloudIdentity, ExpiringToken } from "./credentials.ts"
import { keyringDelete, keyringGet, keyringSet, type SecretStore } from "./keyring.ts"
import { assertIdentityAllowed } from "./policy.ts"

const scope = "https://ai.azure.com/.default offline_access"
const account = (i: CloudIdentity) => `azure:${i.tenant}:${i.clientId}`
function endpoint(i: CloudIdentity): string {
  if (
    i.kind !== "azure" ||
    !i.tenant ||
    !i.clientId ||
    !/^[a-zA-Z0-9.-]+$/.test(i.tenant) ||
    ["common", "organizations", "consumers"].includes(i.tenant) ||
    !/^[a-zA-Z0-9-]+$/.test(i.clientId)
  )
    throw new Error("Device login requires an explicit Azure tenant and registered public client")
  assertIdentityAllowed("azure-device", i.tenant)
  return `https://login.microsoftonline.com/${i.tenant}/oauth2/v2.0`
}
async function post(
  url: string,
  fields: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const r = await networkFetch(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
      signal,
    },
    { timeoutMs: 30000 },
  )
  // Bounded read even for protocol errors; return only structured fields, never diagnostics from the server.
  const source = await responseBytes(new Response(r.body, { status: 200 }), 128 * 1024)
  try {
    const data: unknown = JSON.parse(source.toString())
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid shape")
    return { ok: r.ok, data: data as Record<string, unknown> }
  } catch {
    throw new Error("Invalid identity response")
  }
}
function token(data: Record<string, unknown>): ExpiringToken {
  if (
    typeof data.access_token !== "string" ||
    !data.access_token ||
    data.access_token.length > 65536 ||
    /\s/.test(data.access_token) ||
    String(data.token_type).toLowerCase() !== "bearer" ||
    typeof data.expires_in !== "number" ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in < 10 ||
    data.expires_in > 86400
  )
    throw new Error("Invalid device token response")
  return { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 }
}
async function save(
  i: CloudIdentity,
  data: Record<string, unknown>,
  root: string,
  store: SecretStore,
  required: boolean,
): Promise<void> {
  if (data.refresh_token === undefined && !required) return
  if (
    typeof data.refresh_token !== "string" ||
    !data.refresh_token ||
    /\s/.test(data.refresh_token) ||
    data.refresh_token.length > 65536
  )
    throw new Error("Device login did not return a valid refresh token")
  await keyringSet(account(i), data.refresh_token, root, store)
}
export async function deviceLogin(
  i: CloudIdentity,
  show: (uri: string, code: string) => void,
  options: {
    signal?: AbortSignal
    root?: string
    store?: SecretStore
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  } = {},
): Promise<void> {
  const base = endpoint(i),
    root = options.root ?? configDirectory(),
    store = options.store ?? Bun.secrets
  // Establish that the OS store is usable before asking the user to authorize.
  await keyringGet(account(i), root, store)
  const initial = await post(`${base}/devicecode`, { client_id: i.clientId!, scope }, options.signal)
  const d = initial.data
  if (
    !initial.ok ||
    typeof d.device_code !== "string" ||
    !d.device_code ||
    d.device_code.length > 65536 ||
    typeof d.user_code !== "string" ||
    !/^[A-Z0-9-]{4,32}$/.test(d.user_code) ||
    typeof d.verification_uri !== "string" ||
    typeof d.expires_in !== "number" ||
    d.expires_in < 1 ||
    d.expires_in > 1800 ||
    typeof d.interval !== "number" ||
    d.interval < 1 ||
    d.interval > 60
  )
    throw new Error("Invalid device authorization response")
  const uri = new URL(d.verification_uri)
  if (
    uri.protocol !== "https:" ||
    uri.username ||
    uri.password ||
    !["microsoft.com", "www.microsoft.com", "login.microsoftonline.com"].includes(uri.hostname) ||
    uri.hash ||
    uri.search
  )
    throw new Error("Untrusted device verification page")
  const signal = AbortSignal.any([
    AbortSignal.timeout(d.expires_in * 1000),
    ...(options.signal ? [options.signal] : []),
  ])
  show(uri.href, d.user_code)
  let interval = d.interval * 1000
  for (;;) {
    await (options.sleep ?? ((ms, s) => delay(ms, undefined, { signal: s })))(interval, signal)
    signal.throwIfAborted()
    endpoint(i)
    const next = await post(
      `${base}/token`,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: i.clientId!,
        device_code: d.device_code,
      },
      signal,
    )
    if (next.ok) {
      token(next.data)
      await serialized(i, root, () => save(i, next.data, root, store, true))
      return
    }
    if (next.data.error === "authorization_pending") continue
    if (next.data.error === "slow_down") {
      interval = Math.min(interval + 5000, 60000)
      continue
    }
    throw new Error("Device authorization was denied, expired or invalid; log in again explicitly")
  }
}
// Only lock ownership metadata is written to disk; credentials remain in the OS store.
async function serialized<T>(i: CloudIdentity, root: string, operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 35000
  let release: (() => void) | undefined
  while (!release) {
    try {
      release = lease(root, `identity-${digest(account(i)).slice(0, 24)}.lease`)
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "Session is active or owned by another host" ||
        Date.now() >= deadline
      )
        throw new Error("Identity credential operation is unavailable or busy")
      await delay(100)
    }
  }
  try {
    return await operation()
  } finally {
    release()
  }
}
const refreshes = new WeakMap<SecretStore, Map<string, Promise<ExpiringToken>>>()
export async function deviceRefresh(
  i: CloudIdentity,
  root = configDirectory(),
  store: SecretStore = Bun.secrets,
): Promise<ExpiringToken> {
  endpoint(i)
  let pending = refreshes.get(store)
  if (!pending) {
    pending = new Map()
    refreshes.set(store, pending)
  }
  const id = JSON.stringify([root, account(i)])
  const existing = pending.get(id)
  if (existing) return existing
  const operation = serialized(i, root, async () => {
    const base = endpoint(i),
      refresh = await keyringGet(account(i), root, store)
    if (!refresh) throw new Error("Device identity is not logged in")
    const result = await post(`${base}/token`, {
      grant_type: "refresh_token",
      client_id: i.clientId!,
      refresh_token: refresh,
      scope,
    })
    if (!result.ok) throw new Error("Device identity refresh failed; log in again explicitly")
    const access = token(result.data)
    await save(i, result.data, root, store, false)
    return access
  }).finally(() => {
    pending.delete(id)
  })
  pending.set(id, operation)
  return operation
}
export async function deviceLogout(
  i: CloudIdentity,
  root = configDirectory(),
  store: SecretStore = Bun.secrets,
): Promise<void> {
  // Serialize with refresh so a late rotation cannot resurrect a logged-out credential.
  await serialized(i, root, async () => {
    await keyringDelete(account(i), root, store)
  })
}
