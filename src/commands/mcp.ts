import { realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { assertManagedPolicy } from "../core/config/policy.ts"
import { editConfigSource, isTable, readConfigSource } from "../core/config/source.ts"
import { configDirectory, configFilePath, dataDirectory, loadConfig } from "../core/config.ts"
import { MCP_SERVER_ID, validateMcpConfig } from "../engines/codesplash/mcp/config.ts"
import { McpManager } from "../engines/codesplash/mcp/manager.ts"
import { McpOAuth } from "../engines/codesplash/mcp/oauth.ts"
import { McpOAuthIndex } from "../engines/codesplash/mcp/oauth-index.ts"
import { hasMcpTrust, recordMcpTrust, reviewMcpServer } from "../engines/codesplash/mcp/trust.ts"
import { createProfile } from "../engines/codesplash/sandbox/profile.ts"
import { NativeSandbox } from "../engines/codesplash/sandbox/runtime.ts"
import { redactConfigValue } from "./config.ts"
import { UsageError } from "./usage-error.ts"

export async function runMcpCommand(
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv
    output?: (text: string) => void
    cwd?: string
  } = {},
): Promise<number> {
  const env = options.env ?? process.env
  const output = options.output ?? ((text: string) => process.stdout.write(text))
  if (args.length === 1 && ["--help", "-h"].includes(args[0] ?? "")) {
    output(
      "Usage: codesplash mcp list|show ID|doctor ID [--connect]|add ID -- COMMAND [ARGS]|remove ID|enable ID|disable ID|trust ID --fingerprint HASH|login ID|logout ID\nHTTP/SSE: add ID --transport http|sse --url URL\nOptions: --scope user|project --path DIR --profile NAME --strict-config -c KEY=VALUE --json\nAdd is inert. Enable, inspect with show, and trust the fingerprint before connection or login.\n",
    )
    return 0
  }
  const emit = (value: unknown) => output(`${JSON.stringify(redactConfigValue(value, env), null, 2)}\n`)
  let cwd = options.cwd ?? process.cwd(),
    scope = "user",
    profile: string | undefined,
    strict = false
  const flags: Record<string, string> = {},
    positional: string[] = [],
    overrides: string[] = []
  let argv: string[] | undefined
  let connect = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ""
    if (arg === "--") {
      argv = args.slice(i + 1)
      break
    }
    if (arg === "--json") continue
    if (arg === "--connect") {
      connect = true
      continue
    }
    if (arg === "--strict-config") {
      strict = true
      continue
    }
    if (
      ["--scope", "--path", "--profile", "--transport", "--url", "--fingerprint", "-c", "--config"].includes(
        arg,
      )
    ) {
      const value = args[++i]
      if (!value) throw new UsageError(`${arg} requires a value`)
      if (arg === "--scope") scope = value
      else if (arg === "--path") cwd = resolve(value)
      else if (arg === "--profile") profile = value
      else if (arg === "-c" || arg === "--config") overrides.push(value)
      else {
        if (arg in flags) throw new UsageError(`Duplicate ${arg}`)
        flags[arg] = value
      }
    } else if (arg.startsWith("-")) throw new UsageError(`Unknown MCP option ${arg}`)
    else positional.push(arg)
  }
  const [action = "list", id, ...extra] = positional
  if (connect && action !== "doctor") throw new UsageError("--connect is only supported by mcp doctor")
  if (extra.length || !["user", "project"].includes(scope) || (id && !MCP_SERVER_ID.test(id)))
    throw new UsageError("Invalid MCP arguments, server id or scope")
  if (
    !["list", "show", "doctor", "add", "remove", "enable", "disable", "trust", "login", "logout"].includes(
      action,
    ) ||
    (action === "list" ? Boolean(id) : !id) ||
    (action !== "add" && argv !== undefined)
  )
    throw new UsageError(
      "Usage: codesplash mcp list|show ID|doctor ID|add ID|remove ID|enable ID|disable ID|trust ID --fingerprint HASH [--scope user|project] [--path DIR]",
    )
  const userPath = configFilePath(configDirectory(env))
  const path = scope === "user" ? userPath : join(cwd, ".codesplash", "config.toml")
  if (["add", "remove", "enable", "disable"].includes(action) && id) {
    if (profile || overrides.length)
      throw new UsageError("MCP edits target the raw user/project source; omit profile and -c overrides")
    if (Object.keys(flags).some((key) => action !== "add" || !["--transport", "--url"].includes(key)))
      throw new UsageError("Unexpected MCP edit option")
    const previous = readConfigSource(path)
    editConfigSource(
      path,
      (raw) => {
        if (raw.mcp === undefined) raw.mcp = { servers: {} }
        if (!isTable(raw.mcp)) throw new Error("Invalid MCP source table")
        if (raw.mcp.servers === undefined) raw.mcp.servers = {}
        if (!isTable(raw.mcp.servers)) throw new Error("Invalid MCP server source table")
        const servers = raw.mcp.servers
        if (action === "add") {
          if (id in servers) throw new Error("MCP server already exists in this source")
          const transport = flags["--transport"] ?? "stdio"
          if (transport === "stdio" ? !argv?.[0] || flags["--url"] : argv !== undefined || !flags["--url"])
            throw new UsageError(
              "stdio: mcp add ID -- COMMAND [ARGS]; HTTP/SSE: mcp add ID --transport http|sse --url URL",
            )
          servers[id] =
            transport === "stdio"
              ? { transport, enabled: false, command: argv?.[0], args: argv?.slice(1) ?? [] }
              : { transport, enabled: false, url: flags["--url"] }
        } else {
          if (!isTable(servers[id])) throw new Error("MCP server is absent from the selected raw source")
          if (action === "remove") delete servers[id]
          else servers[id].enabled = action === "enable"
        }
        validateMcpConfig(raw.mcp)
      },
      previous.fingerprint,
    )
    emit({
      action,
      id,
      scope,
      path,
      message:
        action === "enable"
          ? "Enabled in configuration. Inspect and trust the resulting source fingerprint before connection."
          : "Configuration updated.",
    })
    return 0
  }
  if (Object.keys(flags).some((key) => action !== "trust" || key !== "--fingerprint"))
    throw new UsageError("Unexpected MCP inspection option")
  const config = await loadConfig(userPath, overrides, { cwd, env, profile, strict })
  const servers = config.mcp?.servers ?? {}
  if (action === "list") {
    emit({
      servers: Object.entries(servers).map(([name, server]) => ({
        id: name,
        transport: server.transport,
        enabled: server.enabled,
        permitted: config.resolution?.constraints.mcpServers?.includes(name) ?? true,
        trust: "Run mcp show to verify executable content and source trust",
      })),
      diagnostics: config.resolution?.diagnostics ?? [],
    })
    return 0
  }
  if (action === "logout") {
    await new McpOAuthIndex(dataDirectory(env), await realpath(cwd), id ?? "").logout()
    emit({
      id,
      action,
      message:
        "Local protected credentials removed for this server and prior source generations. Remote tokens are not revoked.",
    })
    return 0
  }
  const review = await reviewMcpServer(config, id ?? "", cwd)
  if (action === "login") {
    const oauth = new McpOAuth({
      review,
      profile: createProfile(cwd, config.codex.sandbox, config.sandbox),
      dataDir: dataDirectory(env),
    })
    if (action === "login") {
      assertManagedPolicy(config, { ...config.codex, permissionMode: config.permissions.mode })
      const constraints = config.resolution?.constraints
      if (
        !review.config.enabled ||
        !hasMcpTrust(dataDirectory(env), review) ||
        (constraints?.mcpServers && !constraints.mcpServers.includes(review.serverId)) ||
        (review.config.allowLoopback && constraints?.allowedHosts !== undefined)
      )
        throw new Error("MCP login requires an enabled, trusted and policy-permitted server")
      await (await import("./mcp-login.ts")).runMcpLogin(oauth, output)
    } else await oauth.logout()
    emit({ id: review.serverId, action, authenticated: action === "login" })
    return 0
  }
  if (connect) {
    assertManagedPolicy(config, { ...config.codex, permissionMode: config.permissions.mode })
    const sandbox = new NativeSandbox(
      createProfile(cwd, config.codex.sandbox, config.sandbox),
      undefined,
      undefined,
      config.resolution?.constraints,
    )
    const manager = new McpManager({
      cwd,
      dataDir: dataDirectory(env),
      sandbox,
      mode: () => config.permissions.mode,
      env,
      configurationBoundary: structuredClone(config),
      resolveConfig: () => loadConfig(userPath, overrides, { cwd, env, profile, strict }),
    })
    try {
      await manager.connect(review.serverId)
      emit({ servers: manager.statuses(), connected: true })
    } finally {
      await manager.close()
      await sandbox.close()
    }
    return 0
  }
  if (action === "trust") {
    if (!flags["--fingerprint"])
      throw new UsageError("Inspect mcp show ID, then mcp trust ID --fingerprint HASH")
    recordMcpTrust(dataDirectory(env), review, flags["--fingerprint"])
  }
  emit({
    ...review,
    trusted: hasMcpTrust(dataDirectory(env), review),
    permitted: config.resolution?.constraints.mcpServers?.includes(review.serverId) ?? true,
    connected: false,
    message: "Offline inspection; no server was started.",
  })
  return 0
}
