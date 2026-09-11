import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { stableValue } from "../../../core/config/source.ts"
import type { AgentConfig } from "../../../core/config.ts"
import { atomic, digest, json, lease } from "../../../core/session/files.ts"
import { executableTrustKey, reviewExecutable } from "../executable-review.ts"
import type { McpServerConfig } from "./config.ts"

export type McpReview = {
  serverId: string
  cwd: string
  fingerprint: string
  config: McpServerConfig
  policy: Record<string, unknown>
  sources: Array<{ id: string; path?: string; fingerprint: string }>
  files: Array<{ requested: string; path: string; sha256: string }>
  argv?: string[]
}

/** Hash bounded regular files through an owned descriptor; never execute during review. */
export async function reviewMcpServer(
  config: AgentConfig,
  id: string,
  directory: string,
  signal?: AbortSignal,
): Promise<McpReview> {
  signal?.throwIfAborted()
  const server = config.mcp?.servers[id]
  if (!server) throw new Error("Unknown MCP server")
  const cwd = await realpath(directory)
  const executable =
    server.transport === "stdio"
      ? await reviewExecutable(server.command ?? "", server.args, server.trustFiles, cwd, signal, "MCP")
      : undefined
  const files = executable?.files ?? [],
    argv = executable?.argv
  const prefix = `mcp.servers.${id}`
  const contributing = new Set(
    Object.entries(config.resolution?.provenance ?? {})
      .filter(([key]) => key === prefix || key.startsWith(`${prefix}.`))
      .flatMap(([, sources]) => sources),
  )
  const sources =
    config.resolution?.sources
      .filter((source) => contributing.has(source.id))
      .map(({ id, path, fingerprint }) => ({ id, ...(path ? { path } : {}), fingerprint })) ?? []
  const policy = {
    sandbox: config.codex.sandbox,
    permissionMode: config.permissions.mode,
    sandboxConfig: config.sandbox ?? {},
    constraints: config.resolution?.constraints ?? {},
  }
  const identity = { serverId: id, cwd, config: server, policy, sources, files }
  return { ...identity, fingerprint: digest(stableValue(identity)), ...(argv ? { argv } : {}) }
}

const receiptPath = (dataDir: string, review: McpReview) =>
  join(dataDir, "mcp-trust", `${executableTrustKey(review.cwd, review.serverId, review.sources)}.json`)

export function hasMcpTrust(dataDir: string, review: McpReview): boolean {
  try {
    const receipt = json<{ version?: number; fingerprint?: string }>(receiptPath(dataDir, review), 4096)
    return receipt.version === 1 && receipt.fingerprint === review.fingerprint
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw new Error("MCP trust receipt is unreadable; review it before reconnecting", { cause: error })
  }
}

export function recordMcpTrust(dataDir: string, review: McpReview, fingerprint: string): void {
  if (fingerprint !== review.fingerprint)
    throw new Error("MCP source changed since review; inspect and trust the new fingerprint")
  const path = receiptPath(dataDir, review)
  const release = lease(join(dataDir, "mcp-trust"), "edit.lease")
  try {
    atomic(path, JSON.stringify({ version: 1, fingerprint, reviewedAt: new Date().toISOString() }))
  } finally {
    release()
  }
}
