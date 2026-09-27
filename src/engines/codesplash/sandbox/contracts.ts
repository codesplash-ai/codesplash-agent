import type { PermissionMode } from "../../../core/config.ts"
import type { SessionPolicy } from "../../../core/engine.ts"
import type { HarnessTool, ToolContext, ToolOutcome } from "../contracts.ts"

export type NativeSandboxConfig = {
  denyRead?: string[]
  denyWrite?: string[]
  limits?: { memoryMiB: number; processes: number }
  readRoots?: string[]
  writeRoots?: string[]
  allowedHosts?: string[]
  environment?: string[]
}

export type SandboxProfile = {
  limits?: { memoryMiB: number; processes: number }
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
  openTerminal?(
    argv: string[],
    options: import("./terminal.ts").TerminalOptions,
    signal: AbortSignal,
    output: (bytes: Uint8Array) => void,
    mode?: PermissionMode,
    readOnly?: boolean,
  ): Promise<import("./terminal.ts").SandboxTerminal>
  /** Reviewed external handlers use fixed grants and literal JSON stdin, never temporary grants. */
  executeFixed?(
    argv: string[],
    input: string,
    signal: AbortSignal,
    options: {
      mode: PermissionMode
      environment: readonly string[]
      timeoutMs: number
      writeWorkspace: boolean
    },
  ): Promise<ExecutionResult>
  openDuplex?(
    argv: string[],
    signal: AbortSignal,
    stdout: (chunk: Uint8Array) => void | Promise<void>,
    mode?: PermissionMode,
    environment?: readonly string[],
  ): Promise<import("./duplex.ts").SandboxDuplex>
  readonly profile: SandboxProfile
  runTool(tool: HarnessTool, input: unknown, context: ToolContext): Promise<ToolOutcome>
  execute(argv: string[], signal: AbortSignal, mode?: PermissionMode): Promise<ExecutionResult>
  validateGrant(grant: AccessGrant, mode: PermissionMode): AccessGrant
  grant(grant: AccessGrant): void
  endTurn(): void
  resetGrants?(): void
  close(): Promise<void>
  outputSanitizer?(): { push(text: string, final?: boolean): string }
  sanitize?(value: string): string
  status?(): string
}
