import { chmod, mkdir, readFile, rename } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { stringifyToml } from "./toml.ts"

export type ThemePreference = "system" | "dark" | "light"

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access"

export type ConfigSandboxMode = Exclude<SandboxMode, "danger-full-access">

export type ApprovalPolicy = "untrusted" | "on-request"

export type AgentConfig = {
  schemaVersion: 1
  theme: ThemePreference
  history: { enabled: boolean }
  codex: { sandbox: ConfigSandboxMode; approvalPolicy: ApprovalPolicy }
}

export const defaultConfig: AgentConfig = {
  schemaVersion: 1,
  theme: "system",
  history: { enabled: true },
  codex: { sandbox: "workspace-write", approvalPolicy: "on-request" },
}

export function configDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  if (env.CODESPLASH_AGENT_CONFIG_DIR) return env.CODESPLASH_AGENT_CONFIG_DIR
  if (platform === "darwin") return join(home, "Library", "Application Support", "codesplash-agent")
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "codesplash-agent")
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "codesplash-agent")
}

export function dataDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  if (env.CODESPLASH_AGENT_DATA_DIR) return env.CODESPLASH_AGENT_DATA_DIR
  if (platform === "darwin") return join(home, "Library", "Application Support", "codesplash-agent")
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "codesplash-agent")
  return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "codesplash-agent")
}

export function configFilePath(directory = configDirectory()): string {
  return join(directory, "config.toml")
}

export async function loadConfig(path = configFilePath()): Promise<AgentConfig> {
  let source: string
  try {
    source = await readFile(path, "utf8")
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return structuredClone(defaultConfig)
    throw new Error(`Could not read config at ${path}: ${errorMessage(error)}`, { cause: error })
  }

  let parsed: unknown
  try {
    parsed = Bun.TOML.parse(source)
  } catch (error) {
    throw new Error(`Could not parse config at ${path}: ${errorMessage(error)}`, { cause: error })
  }

  return validateConfig(parsed, path)
}

export function validateConfig(parsed: unknown, path: string): AgentConfig {
  if (!isRecord(parsed)) throw new Error(`Invalid config at ${path}: expected a TOML table`)

  const problems: string[] = []
  const config = structuredClone(defaultConfig)

  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 1) {
    problems.push(`schemaVersion: got ${JSON.stringify(parsed.schemaVersion)}, expected 1`)
  }

  if (parsed.theme !== undefined) {
    if (isThemePreference(parsed.theme)) config.theme = parsed.theme
    else problems.push(`theme: got ${JSON.stringify(parsed.theme)}, expected "system", "dark", or "light"`)
  }

  if (parsed.history !== undefined) {
    if (!isRecord(parsed.history)) {
      problems.push(`[history]: expected a table`)
    } else if (parsed.history.enabled !== undefined) {
      if (typeof parsed.history.enabled === "boolean") config.history.enabled = parsed.history.enabled
      else
        problems.push(
          `[history].enabled: got ${JSON.stringify(parsed.history.enabled)}, expected true or false`,
        )
    }
  }

  if (parsed.codex !== undefined) {
    if (!isRecord(parsed.codex)) {
      problems.push(`[codex]: expected a table`)
    } else {
      const sandbox = parsed.codex.sandbox
      if (sandbox !== undefined) {
        if (sandbox === "danger-full-access") {
          problems.push(
            `[codex].sandbox: "danger-full-access" cannot be a persisted default; full access requires the --full-access flag per session`,
          )
        } else if (isConfigSandboxMode(sandbox)) {
          config.codex.sandbox = sandbox
        } else {
          problems.push(
            `[codex].sandbox: got ${JSON.stringify(sandbox)}, expected "read-only" or "workspace-write"`,
          )
        }
      }
      const approvalPolicy = parsed.codex.approvalPolicy
      if (approvalPolicy !== undefined) {
        if (isApprovalPolicy(approvalPolicy)) config.codex.approvalPolicy = approvalPolicy
        else {
          problems.push(
            `[codex].approvalPolicy: got ${JSON.stringify(approvalPolicy)}, expected "untrusted" or "on-request"`,
          )
        }
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid config at ${path}:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`)
  }

  return config
}

export async function saveConfig(config: AgentConfig, path = configFilePath()): Promise<void> {
  const directory = dirname(path)

  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${process.pid}.tmp`
  const source = stringifyToml({
    schemaVersion: config.schemaVersion,
    theme: config.theme,
    history: { enabled: config.history.enabled },
    codex: { sandbox: config.codex.sandbox, approvalPolicy: config.codex.approvalPolicy },
  })
  await Bun.write(temporaryPath, source)
  await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, path)
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "dark" || value === "light"
}

export function isSandboxMode(value: unknown): value is SandboxMode {
  return value === "danger-full-access" || isConfigSandboxMode(value)
}

function isConfigSandboxMode(value: unknown): value is ConfigSandboxMode {
  return value === "read-only" || value === "workspace-write"
}

function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  return value === "untrusted" || value === "on-request"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
