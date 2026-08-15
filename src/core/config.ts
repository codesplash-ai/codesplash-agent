import { chmod, mkdir, readFile, rename } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type ThemePreference = "system" | "dark" | "light"

export type AgentConfig = {
  schemaVersion: 1
  theme: ThemePreference
}

export const defaultConfig: AgentConfig = {
  schemaVersion: 1,
  theme: "system",
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

export function configFilePath(directory = configDirectory()): string {
  return join(directory, "config.toml")
}

export async function loadConfig(path = configFilePath()): Promise<AgentConfig> {
  let source: string
  try {
    source = await readFile(path, "utf8")
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { ...defaultConfig }
    throw new Error(`Could not read config at ${path}: ${errorMessage(error)}`, { cause: error })
  }

  let parsed: unknown
  try {
    parsed = Bun.TOML.parse(source)
  } catch (error) {
    throw new Error(`Could not parse config at ${path}: ${errorMessage(error)}`, { cause: error })
  }

  if (!isRecord(parsed)) throw new Error(`Invalid config at ${path}: expected a TOML table`)
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Invalid config at ${path}: schemaVersion must be 1`)
  }
  if (!isThemePreference(parsed.theme)) {
    throw new Error(`Invalid config at ${path}: theme must be system, dark, or light`)
  }

  return { schemaVersion: 1, theme: parsed.theme }
}

export async function saveConfig(config: AgentConfig, path = configFilePath()): Promise<void> {
  const directory = dirname(path)

  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${process.pid}.tmp`
  const source = `schemaVersion = 1\ntheme = "${config.theme}"\n`
  await Bun.write(temporaryPath, source)
  await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, path)
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "dark" || value === "light"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
