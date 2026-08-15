import type { EngineProbe } from "../../core/index.ts"
import { runTerminalHandoff, type TerminalHandoffResult } from "./terminal-handoff.ts"

export type ClaudeDriverOptions = {
  binary?: string
}

export class ClaudeDriver {
  readonly id = "claude" as const

  constructor(readonly options: ClaudeDriverOptions = {}) {}

  async probe(): Promise<EngineProbe> {
    const binary = this.resolveBinary()
    if (!binary) return { available: false, detail: "Not installed" }

    try {
      const versionChild = Bun.spawn([binary, "--version"], { stdout: "pipe", stderr: "pipe" })
      const authChild = Bun.spawn([binary, "auth", "status", "--json"], { stdout: "pipe", stderr: "pipe" })
      const [versionOutput, versionCode, authOutput, authCode] = await Promise.all([
        new Response(versionChild.stdout).text(),
        versionChild.exited,
        new Response(authChild.stdout).text(),
        authChild.exited,
      ])
      if (versionCode !== 0) return { available: false, detail: "Version check failed" }

      const version = versionOutput.trim().replace(/\s+\(Claude Code\)$/i, "")
      if (authCode !== 0) return { available: true, authenticated: false, version, detail: "Login required" }

      const auth = parseClaudeAuthStatus(authOutput)
      return {
        available: true,
        authenticated: auth.loggedIn,
        version,
        detail: auth.loggedIn ? claudeAccountLabel(auth) : "Login required",
      }
    } catch (error) {
      return { available: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  async handoff(cwd: string, args: readonly string[] = []): Promise<TerminalHandoffResult> {
    const binary = this.resolveBinary()
    if (!binary) throw new Error("Claude Code CLI is not installed")
    return runTerminalHandoff({ command: [binary, ...args], cwd })
  }

  private resolveBinary(): string | null {
    if (this.options.binary) return this.options.binary
    return Bun.which("claude")
  }
}

type ClaudeAuthStatus = {
  loggedIn: boolean
  authMethod?: string
  apiProvider?: string
}

function parseClaudeAuthStatus(source: string): ClaudeAuthStatus {
  const value: unknown = JSON.parse(source)
  if (typeof value !== "object" || value === null || !("loggedIn" in value)) {
    throw new Error("Claude returned an invalid auth status")
  }
  const status = value as Record<string, unknown>
  return {
    loggedIn: status.loggedIn === true,
    authMethod: typeof status.authMethod === "string" ? status.authMethod : undefined,
    apiProvider: typeof status.apiProvider === "string" ? status.apiProvider : undefined,
  }
}

function claudeAccountLabel(status: ClaudeAuthStatus): string {
  if (status.authMethod === "oauth") return "Claude OAuth"
  if (status.authMethod === "api_key") return "Claude API"
  if (status.apiProvider === "firstParty") return "Claude account"
  return "Connected"
}
