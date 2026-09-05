/** Per-invocation application options resolved from CLI flags; they override config values. */
import type { AgentConfig, ConfigSandboxMode, PermissionMode } from "./config.ts"
import type { SessionPolicy } from "./engine.ts"

export type AppOptions = {
  /** `--no-history`: do not create or write any session files for this run. */
  noHistory: boolean
  /** `--sandbox <mode>`: overrides `[codex].sandbox` from config. */
  sandboxOverride?: ConfigSandboxMode
  /** `--full-access`: the only route to danger-full-access; requires interactive confirmation. */
  fullAccess: boolean
  /** Repeatable `-c/--config key=value` overrides applied when config is loaded for this run. */
  configOverrides?: readonly string[]
  /** `--permission-mode <mode>`: overrides `[permissions].mode`; "bypass" is never a flag value. */
  permissionModeOverride?: PermissionMode
  /** `--bypass-approvals`: the only route to bypass mode; per session, never persisted. */
  bypassApprovals: boolean
  /** Repeatable `--allow <rule>`: CLI-tier allow rules. */
  allowRules: readonly string[]
  /** Repeatable `--ask <rule>`: CLI-tier ask rules. */
  askRules: readonly string[]
  /** Repeatable `--deny <rule>`: CLI-tier deny rules. */
  denyRules: readonly string[]
  /** `--trust`: persist a trusted decision for the workspace before opening the session. */
  trustWorkspace: boolean
}

export const defaultAppOptions: AppOptions = {
  noHistory: false,
  fullAccess: false,
  bypassApprovals: false,
  allowRules: [],
  askRules: [],
  denyRules: [],
  trustWorkspace: false,
}

export function effectiveHistoryEnabled(config: AgentConfig, options: AppOptions): boolean {
  return options.noHistory ? false : config.history.enabled
}

export function effectiveSessionPolicy(config: AgentConfig, options: AppOptions): SessionPolicy {
  return {
    sandbox: options.fullAccess ? "danger-full-access" : (options.sandboxOverride ?? config.codex.sandbox),
    approvalPolicy: config.codex.approvalPolicy,
    permissionMode: options.bypassApprovals
      ? "bypass"
      : (options.permissionModeOverride ?? config.permissions.mode),
  }
}
