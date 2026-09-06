import { type HarnessTool, ToolInputError } from "../contracts.ts"
import type { AccessGrant } from "../sandbox/contracts.ts"

export const REQUEST_PERMISSIONS_TOOL_NAME = "request_permissions"
export function parsePermissionRequest(input: unknown): AccessGrant & { reason: string } {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ToolInputError("request_permissions expects resource, target, scope, and reason")
  const p = input as Record<string, unknown>
  if (
    !["read", "write", "network"].includes(String(p.resource)) ||
    !["turn", "session"].includes(String(p.scope)) ||
    typeof p.target !== "string" ||
    typeof p.reason !== "string" ||
    !p.reason.trim() ||
    p.reason.length > 1000
  )
    throw new ToolInputError(
      "Invalid permission request: provide an exact resource/target, turn or session scope, and a short reason",
    )
  return {
    resource: p.resource as AccessGrant["resource"],
    scope: p.scope as AccessGrant["scope"],
    target: p.target,
    reason: p.reason,
  }
}
export const requestPermissionsTool: HarnessTool = {
  name: REQUEST_PERMISSIONS_TOOL_NAME,
  description:
    "Request scoped filesystem or network access. Use absolute literal paths or exact public hostname:port. Approval does not retry a command. Explicit denies and protected paths cannot be overridden. Turn grants expire at turn end; session grants expire on close/resume.",
  inputSchema: {
    type: "object",
    properties: {
      resource: { enum: ["read", "write", "network"] },
      target: { type: "string" },
      scope: { enum: ["turn", "session"] },
      reason: { type: "string" },
    },
    required: ["resource", "target", "scope", "reason"],
    additionalProperties: false,
  },
  isReadOnly: () => false,
  permission: () => ({ kind: "none" }),
  async run() {
    throw new ToolInputError("Permission requests require the native session loop")
  },
}
