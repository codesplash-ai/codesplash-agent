import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { stableValue } from "../../../core/config/source.ts"
import type { AgentConfig } from "../../../core/config.ts"
import { atomic, digest, json, lease } from "../../../core/session/files.ts"
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
  const files: McpReview["files"] = []
  let total = 0
  const seen = new Set<string>()
  const add = async (requested: string, tree = false): Promise<string> => {
    signal?.throwIfAborted()
    const original = resolve(cwd, requested)
    const info = await lstat(original)
    if (tree && info.isSymbolicLink()) throw new Error("MCP trust directories cannot contain symbolic links")
    const path = await realpath(original)
    if (seen.has(path)) return path
    seen.add(path)
    if (seen.size > 4096) throw new Error("MCP trust file count exceeds 4096")
    if (info.isDirectory()) {
      const names = await readdir(path)
      if (names.length + seen.size > 4096) throw new Error("MCP trust file count exceeds 4096")
      for (const name of names.sort()) await add(join(path, name), true)
      return path
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = await file.stat()
      if (!before.isFile() || before.size + total > 512 * 1024 * 1024)
        throw new Error("MCP trust inputs must be regular files totaling at most 512 MiB")
      total += before.size
      const hash = createHash("sha256")
      const buffer = Buffer.alloc(128 * 1024)
      let count = 0
      while (true) {
        signal?.throwIfAborted()
        const { bytesRead } = await file.read(buffer)
        if (!bytesRead) break
        count += bytesRead
        if (count > before.size) throw new Error("MCP executable changed during review")
        hash.update(buffer.subarray(0, bytesRead))
      }
      const after = await file.stat()
      if (count !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
        throw new Error("MCP executable changed during review")
      files.push({ requested: original, path, sha256: hash.digest("hex") })
    } finally {
      await file.close()
    }
    return path
  }
  let argv: string[] | undefined
  if (server.transport === "stdio") {
    const command = server.command
    if (!command) throw new Error("MCP stdio command is missing")
    const executable =
      isAbsolute(command) || command.includes("/")
        ? resolve(cwd, command)
        : Bun.which(command, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin", cwd })
    if (!executable)
      throw new Error("MCP executable was not found on the sandbox PATH; configure an absolute command")
    const executablePath = await add(executable)
    argv = [executablePath, ...server.args]
    // Common script/file arguments are always covered. Additional dependency trees are explicit.
    for (const arg of server.args) {
      if (!arg || arg.startsWith("-")) continue
      const candidate = resolve(cwd, arg)
      const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
        if (["ENOENT", "ENOTDIR", "ENAMETOOLONG"].includes(error.code ?? "")) return undefined
        throw error
      })
      if (info?.isFile() || info?.isSymbolicLink()) await add(candidate)
    }
    for (const path of server.trustFiles) await add(path)
  }
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

const receiptPath = (dataDir: string, id: string, cwd: string) =>
  join(dataDir, "mcp-trust", `${digest(`${cwd}\0${id}`)}.json`)

export function hasMcpTrust(dataDir: string, review: McpReview): boolean {
  try {
    const receipt = json<{ version?: number; fingerprint?: string }>(
      receiptPath(dataDir, review.serverId, review.cwd),
      4096,
    )
    return receipt.version === 1 && receipt.fingerprint === review.fingerprint
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw new Error("MCP trust receipt is unreadable; review it before reconnecting", { cause: error })
  }
}

export function recordMcpTrust(dataDir: string, review: McpReview, fingerprint: string): void {
  if (fingerprint !== review.fingerprint)
    throw new Error("MCP source changed since review; inspect and trust the new fingerprint")
  const path = receiptPath(dataDir, review.serverId, review.cwd)
  const release = lease(join(dataDir, "mcp-trust"), "edit.lease")
  try {
    atomic(path, JSON.stringify({ version: 1, fingerprint, reviewedAt: new Date().toISOString() }))
  } finally {
    release()
  }
}
