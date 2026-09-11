import { join } from "node:path"
import type {
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client"
import { digest, lease } from "../../../core/session/files.ts"
import { boundedJson, jsonObject } from "./bounds.ts"

export interface ProtectedCredentialStore {
  get(identity: string): Promise<string | null>
  set(identity: string, value: string): Promise<void>
  delete(identity: string): Promise<void>
}

/** No filesystem/plaintext fallback when an OS credential service is unavailable. */
export const osMcpCredentialStore: ProtectedCredentialStore = {
  async get(identity) {
    try {
      return await Bun.secrets.get({ service: "codesplash-agent.mcp.oauth", name: identity })
    } catch {
      throw new Error(
        "Protected MCP credential storage is unavailable; configure an OS credential service before login",
      )
    }
  },
  async set(identity, value) {
    try {
      await Bun.secrets.set({ service: "codesplash-agent.mcp.oauth", name: identity, value })
    } catch {
      throw new Error("Protected MCP credential storage is unavailable; credentials were not saved")
    }
  },
  async delete(identity) {
    try {
      await Bun.secrets.delete({ service: "codesplash-agent.mcp.oauth", name: identity })
    } catch {
      throw new Error("Protected MCP credential storage could not delete this login")
    }
  },
}

export type McpOAuthCredentials = {
  version: 1
  identity: string
  resource: string
  issuer: string
  client: StoredOAuthClientInformation
  tokens: StoredOAuthTokens
  expiresAt: number
  /** Written before rotating tokens: an uncertain exchange requires explicit login. */
  refreshBlocked?: boolean
  discovery: OAuthDiscoveryState
}

export class McpOAuthStore {
  constructor(
    readonly identity: string,
    readonly backend: ProtectedCredentialStore = osMcpCredentialStore,
  ) {
    if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error("Invalid MCP credential identity")
  }
  /** Explicit login preflight: fail before contacting an authorization server. */
  async probe(): Promise<void> {
    const probe = `${this.identity}.probe.${crypto.randomUUID()}`
    try {
      await this.backend.set(probe, "codesplash-protected-store-probe")
      if ((await this.backend.get(probe)) !== "codesplash-protected-store-probe")
        throw new Error("Protected credential store failed verification")
    } finally {
      await this.backend.delete(probe)
    }
  }
  async read(): Promise<McpOAuthCredentials | undefined> {
    const source = await this.backend.get(this.identity)
    if (source === null) return undefined
    try {
      if (Buffer.byteLength(source) > 128 * 1024) throw new Error("limit")
      const value: unknown = JSON.parse(source)
      boundedJson(value, 128 * 1024, 5000)
      if (
        !jsonObject(value) ||
        value.version !== 1 ||
        value.identity !== this.identity ||
        typeof value.issuer !== "string" ||
        typeof value.resource !== "string" ||
        !jsonObject(value.client) ||
        !jsonObject(value.tokens) ||
        !jsonObject(value.discovery) ||
        typeof value.expiresAt !== "number" ||
        !Number.isFinite(value.expiresAt)
      )
        throw new Error("shape")
      if (
        value.client.issuer !== value.issuer ||
        value.tokens.issuer !== value.issuer ||
        typeof value.tokens.access_token !== "string" ||
        typeof value.client.client_id !== "string"
      )
        throw new Error("binding")
      return value as McpOAuthCredentials
    } catch {
      throw new Error("MCP protected credentials are invalid or belong to another identity; log in again")
    }
  }
  async write(value: McpOAuthCredentials): Promise<void> {
    if (
      value.identity !== this.identity ||
      value.tokens.issuer !== value.issuer ||
      value.client.issuer !== value.issuer
    )
      throw new Error("MCP credential issuer or identity mismatch")
    await this.backend.set(this.identity, boundedJson(value, 128 * 1024, 5000))
  }
  async logout(): Promise<void> {
    await this.backend.delete(this.identity)
  }
}

const pending = new Map<string, { tail: Promise<void>; count: number }>()
/** Serialize token rotation/logout in-process; a lease rejects a concurrent second CLI process. */
export async function withMcpOAuthLock<T>(
  dataDir: string,
  identity: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = digest(`${dataDir}\0${identity}`)
  const entry = pending.get(key) ?? { tail: Promise.resolve(), count: 0 }
  if (entry.count >= 32) throw new Error("MCP credential operation queue is full")
  entry.count++
  const before = entry.tail
  let releaseQueue: () => void = () => {}
  entry.tail = new Promise<void>((resolve) => {
    releaseQueue = resolve
  })
  pending.set(key, entry)
  await before
  try {
    const release = lease(join(dataDir, "mcp-auth-locks"), `${key}.lease`)
    try {
      return await operation()
    } finally {
      release()
    }
  } finally {
    entry.count--
    releaseQueue()
    if (entry.count === 0) pending.delete(key)
  }
}
