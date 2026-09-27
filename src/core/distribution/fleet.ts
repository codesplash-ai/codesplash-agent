import { existsSync, lstatSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { APP_VERSION } from "../../version.ts"
import { checkConfigBounds, isTable } from "../config/source.ts"
import { networkFetch, responseBytes } from "../network.ts"
import { atomic, bytes, digest, json, lease } from "../session/files.ts"
import { assertRevision, type SignedEnvelope, type SignedPayload, verifyDocument } from "./signed.ts"
import { assertVersion, type VersionPolicy } from "./versions.ts"
import { assertWindowsPolicyACL } from "./windows-policy.ts"

export type FleetPayload = SignedPayload & {
  kind: "fleet"
  constraints?: Record<string, unknown>
  versions?: VersionPolicy
  settings?: {
    network?: {
      offline?: boolean
      allowedHosts?: string[]
      proxy?: string
      extraCA?: string
      requireExtraCA?: boolean
      timeoutMs?: number
    }
    identityKinds?: string[]
    identityTenants?: string[]
    apiKeyProviders?: string[]
    disableFeatures?: string[]
    announcements?: Array<{ id: string; text: string; minimum?: string; maximum?: string }>
    campaign?: { id: string; theme?: "dark" | "light" }
  }
}
export type FleetDescriptor = {
  version: 1
  keys: Record<string, string>
  url?: string
  document?: SignedEnvelope
  required?: boolean
}
export type FleetSource = { path: string; fingerprint: string; payload: FleetPayload }
export function systemFleetPaths(platform = process.platform): string[] {
  return platform === "win32"
    ? ["C:\\ProgramData\\CodeSplash\\fleet.json"]
    : [
        "/etc/codesplash-agent/fleet.json",
        ...(platform === "darwin"
          ? [
              "/Library/Managed Preferences/com.codesplash.agent.fleet.json",
              "/Library/Managed Preferences/com.codesplash.agent.plist",
            ]
          : []),
      ]
}
function policyPath(location: string): string {
  let path = location
  if (systemFleetPaths().includes(location)) {
    if (process.platform === "win32") {
      assertWindowsPolicyACL(location)
      return location
    }
    if (lstatSync(location).isSymbolicLink()) throw new Error("System fleet descriptor cannot be a symlink")
    // Resolve OS aliases such as macOS /etc, then verify every physical parent.
    path = realpathSync(location)
    for (let parent = path; ; parent = dirname(parent)) {
      const info = lstatSync(parent)
      if (info.uid !== 0 || info.mode & 0o022)
        throw new Error("System fleet policy and its parents must be administrator-owned and non-writable")
      if (dirname(parent) === parent) break
    }
  }
  return path
}
function descriptor(path: string): FleetDescriptor {
  let value: FleetDescriptor
  if (path.endsWith(".plist")) {
    if (process.platform !== "darwin") throw new Error("Managed preferences require macOS")
    bytes(path, 2 * 1024 * 1024)
    const result = Bun.spawnSync(["/usr/bin/plutil", "-extract", "Fleet", "raw", "-o", "-", path], {
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024,
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) throw new Error("Could not read managed Fleet preferences")
    try {
      value = JSON.parse(result.stdout.toString())
    } catch {
      throw new Error("Managed Fleet preferences require a JSON trust descriptor string")
    }
  } else value = json<FleetDescriptor>(path, 2 * 1024 * 1024)
  checkConfigBounds(value)
  if (
    !isTable(value) ||
    value.version !== 1 ||
    !isTable(value.keys) ||
    !Object.keys(value.keys).length ||
    Object.keys(value.keys).length > 16 ||
    Object.values(value.keys).some((key) => typeof key !== "string" || key.length > 8192) ||
    (value.required !== undefined && typeof value.required !== "boolean")
  )
    throw new Error("Invalid fleet trust descriptor")
  if (value.url) {
    const url = new URL(value.url)
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error("Fleet URL must use HTTPS without credentials")
  }
  return value
}
function loadDocument(
  path: string,
  trust: FleetDescriptor,
  historical = false,
): { document: SignedEnvelope; revision: number; fingerprint: string } | undefined {
  const cachePath = `${path}.cache.json`
  const cached = existsSync(cachePath)
    ? json<{ document: SignedEnvelope }>(cachePath, 3 * 1024 * 1024)
    : undefined
  const document = cached?.document ?? trust.document
  if (!document) {
    if (trust.required !== false)
      throw new Error("Required fleet policy is missing; refresh its signed document")
    return
  }
  const verified = verifyDocument<FleetPayload>(
    document,
    "fleet",
    trust.keys,
    historical
      ? (JSON.parse(Buffer.from(document.payload, "base64").toString()) as SignedPayload).issuedAt
      : undefined,
  )
  if (cached && trust.document) {
    const stamp = JSON.parse(Buffer.from(trust.document.payload, "base64").toString()) as SignedPayload
    const baseline = verifyDocument<FleetPayload>(trust.document, "fleet", trust.keys, stamp.issuedAt)
    assertRevision(
      { revision: verified.payload.revision, fingerprint: verified.fingerprint },
      { revision: baseline.payload.revision, fingerprint: baseline.fingerprint },
    )
  }
  return { document, revision: verified.payload.revision, fingerprint: verified.fingerprint }
}
export function readFleetSources(
  configDir: string,
  systemPaths = systemFleetPaths(),
  enforceVersion = true,
  historical = false,
): FleetSource[] {
  const result: FleetSource[] = []
  for (const location of [...systemPaths, join(configDir, "fleet.json")]) {
    if (!existsSync(location)) continue
    const path = policyPath(location)
    const trust = descriptor(path),
      accepted = loadDocument(path, trust, historical)
    if (!accepted) continue
    const { payload, fingerprint } = verifyDocument<FleetPayload>(
      accepted.document,
      "fleet",
      trust.keys,
      historical
        ? (JSON.parse(Buffer.from(accepted.document.payload, "base64").toString()) as SignedPayload).issuedAt
        : undefined,
    )
    if (payload.constraints !== undefined && !isTable(payload.constraints))
      throw new Error("Invalid fleet constraints")
    if (payload.versions !== undefined) {
      if (!isTable(payload.versions)) throw new Error("Invalid fleet version policy")
      if (enforceVersion) assertVersion(APP_VERSION, payload.versions)
    }
    validateFleetSettings(payload.settings)
    result.push({ path, fingerprint, payload })
  }
  return result
}
/** Explicit refresh only. A rejected/missing new policy never overwrites the last signed snapshot. */
export async function refreshFleet(
  path: string,
  fetcher?: typeof fetch,
): Promise<{ revision: number; fingerprint: string }> {
  path = policyPath(path)
  const trust = descriptor(path)
  if (!trust.url) throw new Error("Fleet descriptor has no refresh URL")
  const response = await networkFetch(trust.url, {}, { fetcher, timeoutMs: 15000, policyRecovery: true })
  const source = await responseBytes(response, 2 * 1024 * 1024)
  let document: SignedEnvelope
  try {
    document = JSON.parse(source.toString())
  } catch {
    throw new Error("Invalid fleet response")
  }
  const verified = verifyDocument<FleetPayload>(document, "fleet", trust.keys)
  const { managed } = await import("../config/resolver.ts")
  managed(verified.payload.constraints ?? {})
  validateFleetSettings(verified.payload.settings)
  const next = { revision: verified.payload.revision, fingerprint: verified.fingerprint }
  const release = lease(join(path, ".."), "fleet-refresh.lease")
  try {
    // Verify old signatures even if old validity has elapsed; revision history must survive expiry.
    const cachePath = `${path}.cache.json`
    const previous = existsSync(cachePath)
      ? json<{ document: SignedEnvelope; revision: number; fingerprint: string }>(cachePath, 3 * 1024 * 1024)
      : undefined
    if (previous) {
      const oldData = JSON.parse(Buffer.from(previous.document.payload, "base64").toString()) as SignedPayload
      const old = verifyDocument<FleetPayload>(previous.document, "fleet", trust.keys, oldData.issuedAt)
      assertRevision(next, { revision: old.payload.revision, fingerprint: old.fingerprint })
    } else if (trust.document) {
      const oldData = JSON.parse(Buffer.from(trust.document.payload, "base64").toString()) as SignedPayload
      const old = verifyDocument<FleetPayload>(trust.document, "fleet", trust.keys, oldData.issuedAt)
      assertRevision(next, { revision: old.payload.revision, fingerprint: old.fingerprint })
    }
    atomic(cachePath, JSON.stringify({ document, ...next }))
    return next
  } finally {
    release()
  }
}
/** Independent ceilings intersect. Required settings cannot conflict across administrators. */
export function intersectConstraints(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const out = structuredClone(left)
  for (const [key, value] of Object.entries(right)) {
    const prior = out[key]
    if (prior === undefined) out[key] = structuredClone(value)
    else if (Array.isArray(prior) && Array.isArray(value))
      out[key] =
        key === "deny" ? [...new Set([...prior, ...value])] : prior.filter((item) => value.includes(item))
    else if (isTable(prior) && isTable(value)) out[key] = intersectConstraints(prior, value)
    else if (key === "hooksManagedOnly" && typeof prior === "boolean" && typeof value === "boolean")
      out[key] = prior || value
    else if (digest(JSON.stringify(prior)) !== digest(JSON.stringify(value)))
      throw new Error("Conflicting managed requirements")
  }
  return out
}

function validateFleetSettings(settings: FleetPayload["settings"]): void {
  if (settings === undefined) return
  if (
    !isTable(settings) ||
    Object.keys(settings).some(
      (k) =>
        ![
          "network",
          "identityKinds",
          "identityTenants",
          "apiKeyProviders",
          "disableFeatures",
          "announcements",
          "campaign",
        ].includes(k),
    )
  )
    throw new Error("Invalid fleet settings")
  for (const key of ["identityKinds", "identityTenants", "apiKeyProviders", "disableFeatures"] as const) {
    const list = settings[key]
    if (
      list !== undefined &&
      (!Array.isArray(list) ||
        list.length > 128 ||
        list.some((v) => typeof v !== "string" || !v || v.length > 256))
    )
      throw new Error("Invalid fleet identity or feature ceiling")
  }
  const n = settings.network
  if (n !== undefined) {
    if (
      !isTable(n) ||
      Object.keys(n).some(
        (k) => !["offline", "allowedHosts", "proxy", "extraCA", "requireExtraCA", "timeoutMs"].includes(k),
      )
    )
      throw new Error("Invalid fleet network settings")
    for (const k of ["offline", "requireExtraCA"] as const)
      if (n[k] !== undefined && typeof n[k] !== "boolean") throw new Error("Invalid fleet network flag")
    if (
      n.allowedHosts !== undefined &&
      (!Array.isArray(n.allowedHosts) ||
        n.allowedHosts.length > 256 ||
        n.allowedHosts.some((v) => typeof v !== "string" || !/^[a-z0-9.[\]:-]+$/.test(v)))
    )
      throw new Error("Invalid fleet destination ceiling")
    for (const k of ["proxy", "extraCA"] as const)
      if (n[k] !== undefined && (typeof n[k] !== "string" || !n[k] || n[k].length > 2048))
        throw new Error("Invalid fleet network path")
    if (
      n.timeoutMs !== undefined &&
      (!Number.isInteger(n.timeoutMs) || n.timeoutMs < 100 || n.timeoutMs > 300000)
    )
      throw new Error("Invalid fleet timeout")
  }
  if (
    settings.announcements !== undefined &&
    (!Array.isArray(settings.announcements) ||
      settings.announcements.length > 32 ||
      settings.announcements.some(
        (a) =>
          !isTable(a) ||
          typeof a.id !== "string" ||
          !/^[a-zA-Z0-9._-]{1,128}$/.test(a.id) ||
          typeof a.text !== "string" ||
          a.text.length > 2000,
      ))
  )
    throw new Error("Invalid fleet announcements")
  if (
    settings.campaign !== undefined &&
    (!isTable(settings.campaign) ||
      typeof settings.campaign.id !== "string" ||
      !/^[a-zA-Z0-9._-]{1,128}$/.test(settings.campaign.id) ||
      ![undefined, "dark", "light"].includes(settings.campaign.theme))
  )
    throw new Error("Invalid fleet campaign")
}
