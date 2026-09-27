import { X509Certificate } from "node:crypto"
import { rootCertificates } from "node:tls"
import { configDirectory } from "./config.ts"
import { readFleetSources } from "./distribution/fleet.ts"
import { bytes } from "./session/files.ts"

type NetworkOptions = {
  /** Refresh may enforce an expired policy while retrieving its replacement. */
  policyRecovery?: boolean
  env?: NodeJS.ProcessEnv
  upload?: boolean
  timeoutMs?: number
  fetcher?: typeof fetch
  diagnostic?: (message: string) => void
}
const failures = new Map<string, { count: number; until: number }>()
const warned = new Set<string>()
function duration(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < 100 || number > 300000)
    throw new Error("Network timeout must be 100–300000 milliseconds")
  return number
}
export function networkTLS(
  env: NodeJS.ProcessEnv,
  diagnostic: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
): { rejectUnauthorized: true; ca?: string[] } {
  const path = env.CODESPLASH_EXTRA_CA
  if (!path) {
    if (env.CODESPLASH_REQUIRE_EXTRA_CA === "1") throw new Error("Required additional CA bundle is missing")
    return { rejectUnauthorized: true }
  }
  try {
    const source = bytes(path, 1024 * 1024).toString()
    const certs = source.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)
    if (
      !certs?.length ||
      certs.length > 128 ||
      source.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim()
    )
      throw new Error("Invalid CA bundle")
    for (const cert of certs)
      if (!new X509Certificate(cert).ca) throw new Error("Additional certificate is not a CA")
    return { rejectUnauthorized: true, ca: [...rootCertificates, ...certs] }
  } catch {
    if (env.CODESPLASH_REQUIRE_EXTRA_CA === "1") throw new Error("Required additional CA bundle is invalid")
    if (!warned.has(path)) {
      if (warned.size >= 128) warned.clear()
      warned.add(path)
      diagnostic("Optional additional CA bundle is invalid; using platform trust")
    }
    return { rejectUnauthorized: true }
  }
}
/** Shared host HTTP policy. The native broker remains an additional boundary for model tools. */
export async function networkFetch(
  input: string | URL | Request,
  init?: RequestInit & { proxy?: string },
  options: NetworkOptions = {},
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input)
  const env = networkEnvironment(url, options.env ?? process.env, options.policyRecovery)
  const state = failures.get(url.origin)
  if (options.upload && state && state.until > Date.now())
    throw new Error("Upload circuit is open; retry later explicitly")
  const timeout = duration(env.CODESPLASH_HTTP_TIMEOUT_MS, options.timeoutMs ?? 120000)
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeout),
    ...((init?.signal ?? (input instanceof Request ? input.signal : undefined))
      ? ([init?.signal ?? (input as Request).signal] as AbortSignal[])
      : []),
  ])
  const failed = () => {
    if (!options.upload) return
    if (failures.size >= 128 && !failures.has(url.origin)) failures.delete(failures.keys().next().value!)
    const count = (failures.get(url.origin)?.count ?? 0) + 1
    failures.set(url.origin, { count, until: count >= 3 ? Date.now() + 30000 : 0 })
  }
  try {
    const response = await (options.fetcher ?? fetch)(input, {
      ...init,
      redirect: init?.redirect === "manual" ? "manual" : "error",
      signal,
      tls: networkTLS(env, options.diagnostic),
      ...(init?.proxy ? {} : env.CODESPLASH_PROXY ? { proxy: env.CODESPLASH_PROXY } : {}),
    } as RequestInit)
    if (response.status === 429 || response.status >= 500) failed()
    else if (options.upload) failures.delete(url.origin)
    return response
  } catch (error) {
    failed()
    throw error
  }
}
export async function responseBytes(response: Response, max: number): Promise<Buffer> {
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(`Network response failed (${response.status})`)
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks)
      size += value.byteLength
      if (size > max) throw new Error("Network response exceeds its limit")
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Exact host:port ceilings are checked again for every broker connection and explicit redirect. */
export function networkEnvironment(
  url: URL | undefined,
  input: NodeJS.ProcessEnv = process.env,
  historical = false,
): NodeJS.ProcessEnv {
  if (url && (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || url.username || url.password))
    throw new Error("Unsupported network destination")
  const env = { ...input }
  const host = url
    ? `${url.hostname.toLowerCase().replace(/\.$/, "")}:${url.port || (["https:", "wss:"].includes(url.protocol) ? "443" : "80")}`
    : undefined
  const policies = readFleetSources(configDirectory(input), undefined, false, historical)
    .map((s) => s.payload.settings?.network)
    .filter((n) => n !== undefined)
  const proxies = new Set(policies.map((n) => n.proxy).filter(Boolean)),
    cas = new Set(policies.map((n) => n.extraCA).filter(Boolean))
  if (proxies.size > 1 || cas.size > 1) throw new Error("Conflicting managed network settings")
  for (const policy of policies) {
    if (policy.offline) env.CODESPLASH_OFFLINE = "1"
    if (host && policy.allowedHosts && !policy.allowedHosts.includes(host))
      throw new Error("Destination refused by managed network policy")
    if (policy.proxy) env.CODESPLASH_PROXY = policy.proxy
    if (policy.extraCA) env.CODESPLASH_EXTRA_CA = policy.extraCA
    if (policy.requireExtraCA) env.CODESPLASH_REQUIRE_EXTRA_CA = "1"
    if (policy.timeoutMs)
      env.CODESPLASH_HTTP_TIMEOUT_MS = String(
        Math.min(duration(env.CODESPLASH_HTTP_TIMEOUT_MS, 300000), policy.timeoutMs),
      )
  }
  if (url && env.CODESPLASH_OFFLINE === "1") throw new Error("Network request refused in offline mode")
  if (env.CODESPLASH_PROXY) {
    let proxy: URL
    try {
      proxy = new URL(env.CODESPLASH_PROXY)
    } catch {
      throw new Error("Invalid network proxy")
    }
    if (!["http:", "https:"].includes(proxy.protocol) || proxy.pathname !== "/" || proxy.hash || proxy.search)
      throw new Error("Invalid network proxy")
  }
  return env
}
export function networkSocketOptions(url: URL): { tls: ReturnType<typeof networkTLS>; proxy?: string } {
  const env = networkEnvironment(url)
  return { tls: networkTLS(env), ...(env.CODESPLASH_PROXY ? { proxy: env.CODESPLASH_PROXY } : {}) }
}

/** Private supervisor envelope only; these routing values never become model command variables. */
export function supervisorNetworkEnvironment(env = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { CODESPLASH_AGENT_CONFIG_DIR: configDirectory(env) }
  for (const name of [
    "CODESPLASH_OFFLINE",
    "CODESPLASH_PROXY",
    "CODESPLASH_EXTRA_CA",
    "CODESPLASH_REQUIRE_EXTRA_CA",
    "CODESPLASH_HTTP_TIMEOUT_MS",
  ])
    if (env[name] !== undefined) out[name] = env[name]
  return out
}
