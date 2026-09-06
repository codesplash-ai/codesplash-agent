import type { PermissionMode } from "../../../core/config.ts"
import type { SessionPolicy } from "../../../core/engine.ts"
import type { HarnessTool, ToolContext, ToolOutcome } from "../contracts.ts"

export type NativeSandboxConfig = {
  readRoots?: string[]
  writeRoots?: string[]
  allowedHosts?: string[]
  environment?: string[]
}

export type SandboxProfile = {
  version: 1
  cwd: string
  mode: SessionPolicy["sandbox"]
  readRoots: string[]
  writeRoots: string[]
  protectedPaths: string[]
  deniedReadPaths: string[]
  allowedHosts: string[]
  environment: string[]
  hash: string
}

export type AccessGrant = {
  resource: "read" | "write" | "network"
  target: string
  scope: "turn" | "session"
}

export type ExecutionResult = {
  kind: "success" | "command-failure" | "sandbox-denial" | "unavailable" | "timeout" | "interrupted"
  exitCode: number
  stdout: string
  stderr: string
}

export interface SandboxRuntime {
  readonly profile: SandboxProfile
  runTool(tool: HarnessTool, input: unknown, context: ToolContext): Promise<ToolOutcome>
  execute(argv: string[], signal: AbortSignal, mode?: PermissionMode): Promise<ExecutionResult>
  validateGrant(grant: AccessGrant, mode: PermissionMode): AccessGrant
  grant(grant: AccessGrant): void
  endTurn(): void
  close(): Promise<void>
  sanitize?(value: string): string
  status?(): string
}
