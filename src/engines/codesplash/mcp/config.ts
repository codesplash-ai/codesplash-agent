import { isTable } from "../../../core/config/source.ts"
import { validateEnvironmentName } from "../sandbox/env-policy.ts"

export type McpServerConfig = {
  transport: "stdio" | "http" | "sse"
  enabled: boolean
  command?: string
  args: string[]
  url?: string
  /** Explicit credential references; values never belong in configuration. */
  bearerEnv?: string
  environment: string[]
  trustFiles: string[]
  allowLoopback: boolean
  initializeTimeoutMs: number
  requestTimeoutMs: number
  allowTools?: string[]
  denyTools: string[]
  /** Explicit local review; server annotations alone never authorize readonly dispatch. */
  readOnlyTools?: string[]
  oauth?: { clientId?: string; scopes: string[] }
}
export type McpConfig = { servers: Record<string, McpServerConfig> }
export const MCP_SERVER_ID = /^[a-z][a-z0-9_-]{0,31}$/

function strings(value: unknown, name: string, max: number, empty = false): string[] {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    value.some(
      (entry) =>
        typeof entry !== "string" || (!empty && !entry.length) || entry.length > 8192 || entry.includes("\0"),
    )
  )
    throw new Error(`MCP ${name}: expected at most ${max} bounded strings`)
  return [...new Set(value as string[])]
}

export function validateMcpConfig(raw: unknown): McpConfig {
  if (!isTable(raw) || Object.keys(raw).some((key) => key !== "servers") || !isTable(raw.servers))
    throw new Error("[mcp]: expected named servers")
  if (Object.keys(raw.servers).length > 32) throw new Error("MCP supports at most 32 configured servers")
  const servers: Record<string, McpServerConfig> = Object.create(null)
  for (const [id, value] of Object.entries(raw.servers)) {
    if (!MCP_SERVER_ID.test(id) || !isTable(value)) throw new Error("Invalid MCP server identifier or table")
    const known = [
      "transport",
      "enabled",
      "command",
      "args",
      "url",
      "bearerEnv",
      "environment",
      "trustFiles",
      "allowLoopback",
      "initializeTimeoutMs",
      "requestTimeoutMs",
      "allowTools",
      "denyTools",
      "readOnlyTools",
      "oauth",
    ]
    if (Object.keys(value).some((key) => !known.includes(key)))
      throw new Error(`MCP ${id}: unknown setting; credentials must use references`)
    if (!["stdio", "http", "sse"].includes(value.transport as string))
      throw new Error(`MCP ${id}: invalid transport`)
    for (const key of ["enabled", "allowLoopback"])
      if (value[key] !== undefined && typeof value[key] !== "boolean")
        throw new Error(`MCP ${id}: ${key} must be boolean`)
    const timeout = (key: string, fallback: number): number => {
      const result = value[key] ?? fallback
      if (!Number.isInteger(result) || (result as number) < 100 || (result as number) > 120_000)
        throw new Error(`MCP ${id}: ${key} must be between 100 and 120000 ms`)
      return result as number
    }
    const server: McpServerConfig = {
      transport: value.transport as McpServerConfig["transport"],
      enabled: value.enabled === true,
      args: strings(value.args ?? [], "args", 128, true),
      environment: strings(value.environment ?? [], "environment", 32),
      trustFiles: strings(value.trustFiles ?? [], "trustFiles", 32),
      allowLoopback: value.allowLoopback === true,
      initializeTimeoutMs: timeout("initializeTimeoutMs", 10_000),
      requestTimeoutMs: timeout("requestTimeoutMs", 30_000),
      denyTools: strings(value.denyTools ?? [], "denyTools", 5000),
      ...(value.readOnlyTools === undefined
        ? {}
        : { readOnlyTools: strings(value.readOnlyTools, "readOnlyTools", 5000) }),
      ...(value.allowTools === undefined
        ? {}
        : { allowTools: strings(value.allowTools, "allowTools", 5000) }),
    }
    // Argument order and repetition are meaningful (unlike policy lists).
    server.args = [...((value.args as string[] | undefined) ?? [])]
    for (const name of server.environment) validateEnvironmentName(name)
    if (server.transport === "stdio") {
      if (
        typeof value.command !== "string" ||
        !value.command.trim() ||
        value.command.length > 8192 ||
        Array.from(value.command).some((char) => char.charCodeAt(0) < 32)
      )
        throw new Error(`MCP ${id}: stdio requires a literal command`)
      if (["url", "bearerEnv", "oauth", "allowLoopback"].some((key) => key in value))
        throw new Error(`MCP ${id}: HTTP settings cannot be used with stdio`)
      server.command = value.command
    } else {
      if (["command", "args", "environment", "trustFiles"].some((key) => key in value))
        throw new Error(`MCP ${id}: process settings cannot be used with HTTP/SSE`)
      let url: URL
      try {
        url = new URL(value.url as string)
      } catch {
        throw new Error(`MCP ${id}: invalid endpoint URL`)
      }
      if (
        typeof value.url !== "string" ||
        value.url.length > 8192 ||
        url.username ||
        url.password ||
        url.hash ||
        url.search ||
        !["https:", "http:"].includes(url.protocol)
      )
        throw new Error(`MCP ${id}: endpoint must be HTTP(S) without credentials, query or fragment`)
      const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname)
      if (
        (url.protocol === "http:" && !(loopback && server.allowLoopback)) ||
        (server.allowLoopback && !loopback)
      )
        throw new Error(`MCP ${id}: plaintext HTTP requires an explicitly reviewed literal loopback endpoint`)
      server.url = url.href
      if (value.bearerEnv !== undefined) {
        if (typeof value.bearerEnv !== "string" || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(value.bearerEnv))
          throw new Error(`MCP ${id}: bearerEnv must name an environment variable`)
        server.bearerEnv = value.bearerEnv
      }
      if (value.oauth !== undefined) {
        if (
          !isTable(value.oauth) ||
          Object.keys(value.oauth).some((key) => !["clientId", "scopes"].includes(key)) ||
          server.bearerEnv
        )
          throw new Error(`MCP ${id}: invalid OAuth configuration or conflicting bearer authentication`)
        const clientId = value.oauth.clientId
        if (
          clientId !== undefined &&
          (typeof clientId !== "string" ||
            !clientId.length ||
            clientId.length > 1024 ||
            Array.from(clientId).some((char) => char.charCodeAt(0) <= 32))
        )
          throw new Error(`MCP ${id}: invalid OAuth client ID`)
        server.oauth = {
          ...(clientId ? { clientId: clientId as string } : {}),
          scopes: strings(value.oauth.scopes ?? [], "OAuth scopes", 32),
        }
      }
    }
    servers[id] = server
  }
  return { servers }
}

export function mcpToolPermitted(server: McpServerConfig, name: string): boolean {
  return (
    !server.denyTools.includes(name) && (server.allowTools === undefined || server.allowTools.includes(name))
  )
}

/** Omit fields belonging to the other transport when persisting normalized defaults. */
export function mcpConfigTable(config: McpConfig): Record<string, unknown> {
  return {
    servers: Object.fromEntries(
      Object.entries(config.servers).map(([id, server]) => {
        const raw = JSON.parse(JSON.stringify(server)) as Record<string, unknown>
        for (const key of server.transport === "stdio"
          ? ["url", "bearerEnv", "oauth", "allowLoopback"]
          : ["command", "args", "environment", "trustFiles"])
          delete raw[key]
        return [id, raw]
      }),
    ),
  }
}
