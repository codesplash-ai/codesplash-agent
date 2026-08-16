/** Per-invocation application options resolved from CLI flags; they override config values. */
import type { AgentConfig, ConfigSandboxMode } from "./config.ts"
import type { SessionPolicy } from "./engine.ts"

export type AppOptions = {
  /** `--no-history`: do not create or write any session files for this run. */
  noHistory: boolean
  /** `--sandbox <mode>`: overrides `[codex].sandbox` from config. */
  sandboxOverride?: ConfigSandboxMode
  /** `--full-access`: the only route to danger-full-access; requires interactive confirmation. */
  fullAccess: boolean
}

export const defaultAppOptions: AppOptions = { noHistory: false, fullAccess: false }

export function effectiveHistoryEnabled(config: AgentConfig, options: AppOptions): boolean {
  return options.noHistory ? false : config.history.enabled
}

export function effectiveSessionPolicy(config: AgentConfig, options: AppOptions): SessionPolicy {
  return {
    sandbox: options.fullAccess ? "danger-full-access" : (options.sandboxOverride ?? config.codex.sandbox),
    approvalPolicy: config.codex.approvalPolicy,
  }
}
