import type { AgentConfig, PermissionMode } from "../config.ts"
import type { SessionPolicy } from "../engine.ts"
import type { ManagedConstraints } from "./contracts.ts"

export function assertManagedMode(constraints: ManagedConstraints | undefined, mode: PermissionMode): void {
  const required = constraints?.required?.permissions as { mode?: string } | undefined
  if (required?.mode && mode !== required.mode)
    throw new Error(`Permission mode ${mode} conflicts with a managed required setting`)
  if (constraints?.permissionModes && !constraints.permissionModes.includes(mode))
    throw new Error(`Permission mode ${mode} is prohibited by managed configuration`)
}

export function assertManagedPolicy(config: AgentConfig, policy: SessionPolicy): SessionPolicy {
  const constraints = config.resolution?.constraints
  if (constraints?.allowedHosts && policy.sandbox === "danger-full-access")
    throw new Error("Managed network restrictions require an enforced sandbox")
  const required = constraints?.required?.codex as { sandbox?: string; approvalPolicy?: string } | undefined
  if (
    (required?.sandbox && policy.sandbox !== required.sandbox) ||
    (required?.approvalPolicy && policy.approvalPolicy !== required.approvalPolicy)
  )
    throw new Error("Session policy conflicts with a managed required setting")
  if (constraints?.sandboxModes && !constraints.sandboxModes.includes(policy.sandbox))
    throw new Error(`Sandbox mode ${policy.sandbox} is prohibited by managed configuration`)
  if (policy.permissionMode) assertManagedMode(constraints, policy.permissionMode)
  return policy
}
