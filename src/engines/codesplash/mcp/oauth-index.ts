import { existsSync } from "node:fs"
import { join } from "node:path"
import { atomic, digest, directory, json } from "../../../core/session/files.ts"
import { osMcpCredentialStore, type ProtectedCredentialStore, withMcpOAuthLock } from "./oauth-store.ts"

/** Non-secret cleanup receipts. Source changes never reuse tokens, but logout can still remove them. */
export class McpOAuthIndex {
  readonly identity: string
  readonly path: string
  constructor(
    readonly dataDir: string,
    readonly cwd: string,
    readonly serverId: string,
  ) {
    this.identity = digest(`${cwd}\0${serverId}`)
    this.path = join(dataDir, "mcp-auth-index", `${this.identity}.json`)
  }
  read(): string[] {
    if (!existsSync(this.path)) return []
    const value = json<{ version?: unknown; identity?: unknown; accounts?: unknown }>(this.path, 16 * 1024)
    if (
      value.version !== 1 ||
      value.identity !== this.identity ||
      !Array.isArray(value.accounts) ||
      value.accounts.length > 128 ||
      value.accounts.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
    )
      throw new Error("MCP credential cleanup index is invalid; inspect it before changing logins")
    return [...new Set(value.accounts as string[])]
  }
  #write(accounts: string[]): void {
    directory(join(this.dataDir, "mcp-auth-index"), true)
    atomic(this.path, JSON.stringify({ version: 1, identity: this.identity, accounts }))
  }
  record(account: string): void {
    if (!/^[a-f0-9]{64}$/.test(account)) throw new Error("Invalid MCP credential account")
    const accounts = [...new Set([...this.read(), account])]
    if (accounts.length > 128)
      throw new Error("MCP credential history limit reached; log out before logging in again")
    // Persist the cleanup receipt before the protected write so crashes cannot orphan credentials.
    this.#write(accounts)
  }
  async clear(backend: ProtectedCredentialStore = osMcpCredentialStore, current?: string): Promise<void> {
    const accounts = [...new Set([...this.read(), ...(current ? [current] : [])])]
    for (const account of accounts) await backend.delete(account)
    this.#write([])
  }
  logout(backend: ProtectedCredentialStore = osMcpCredentialStore, current?: string): Promise<void> {
    return withMcpOAuthLock(this.dataDir, this.identity, () => this.clear(backend, current))
  }
}
