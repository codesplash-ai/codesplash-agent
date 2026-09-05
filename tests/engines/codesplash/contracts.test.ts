import { describe, expect, test } from "bun:test"
import type {
  HarnessTool,
  PermissionDecision,
  PermissionMode,
  PermissionRuntime,
  PermissionTargets,
  SystemPromptOptions,
  ToolContext,
} from "../../../src/engines/codesplash/contracts.ts"
import {
  ASK_USER_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
} from "../../../src/engines/codesplash/contracts.ts"

/**
 * Type-level coverage for the phase-1 permission contracts: the assignments below are the
 * assertions — a shape drift fails compilation before any test runs.
 */
describe("permission contracts", () => {
  test("plan-mode tool names are stable intrinsic identifiers", () => {
    expect(ENTER_PLAN_MODE_TOOL_NAME).toBe("enter_plan_mode")
    expect(EXIT_PLAN_MODE_TOOL_NAME).toBe("exit_plan_mode")
    expect(new Set([ASK_USER_TOOL_NAME, ENTER_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME]).size).toBe(3)
  })

  test("PermissionRuntime is implementable and consumable through ToolContext", async () => {
    const allowDecision: PermissionDecision = {
      kind: "allow",
      reason: "allow rule bash(git status *) [user]",
    }
    const defaultDecision: PermissionDecision = { kind: "default" }
    // Every union variant is constructible (the assignments are the type-level assertion).
    const otherVariants: PermissionDecision[] = [
      { kind: "deny", reason: "deny rule read_file(**/*.secret) [cli]" },
      { kind: "ask", alwaysAsk: true, reason: "sudo always asks" },
      { kind: "ask", persistableRule: "bash(git status *)" },
    ]
    expect(otherVariants).toHaveLength(3)

    let mode: PermissionMode = "default"
    const runtime: PermissionRuntime = {
      get mode() {
        return mode
      },
      setMode(next) {
        mode = next
      },
      decide(_toolName: string, targets: PermissionTargets | undefined, isReadOnly: boolean) {
        return isReadOnly || targets === undefined ? defaultDecision : allowDecision
      },
      isReadDenied(resolvedPath: string) {
        return resolvedPath.endsWith(".env") ? "matches built-in pattern **/.env" : undefined
      },
      async persistGrant(_rule: string) {},
    }

    const context: ToolContext = {
      cwd: "/workspace",
      policy: { sandbox: "workspace-write", approvalPolicy: "on-request", permissionMode: "plan" },
      signal: new AbortController().signal,
      permissions: runtime,
    }

    // Targets carry resolved absolute paths / command / host, all optional.
    const targets: PermissionTargets = {
      command: "git status",
      paths: ["/workspace/a.ts"],
      urlHost: "docs.example.com",
    }
    expect(context.permissions?.decide("bash", targets, false)).toEqual(allowDecision)
    expect(context.permissions?.decide("read_file", targets, true)).toEqual({ kind: "default" })
    expect(runtime.isReadDenied("/workspace/.env", "grep")).toContain("**/.env")
    expect(runtime.isReadDenied("/workspace/a.ts", "grep")).toBeUndefined()

    runtime.setMode("bypass")
    expect(runtime.mode).toBe("bypass")
    await runtime.persistGrant("bash(git status *)")
  })

  test("HarnessTool.permissionTargets and SystemPromptOptions additions are optional", () => {
    // A tool without permissionTargets still satisfies the interface.
    const bare: HarnessTool = {
      name: "todo",
      description: "d",
      inputSchema: {},
      isReadOnly: () => true,
      permission: () => ({ kind: "none" }),
      run: async () => ({ text: "", label: "" }),
    }
    expect(bare.permissionTargets).toBeUndefined()

    const targeted: HarnessTool = {
      ...bare,
      name: "bash",
      permissionTargets: (input) => ({ command: String((input as { command: string }).command) }),
    }
    expect(
      targeted.permissionTargets?.(
        { command: "ls" },
        {
          cwd: "/",
          policy: { sandbox: "read-only", approvalPolicy: "on-request" },
          signal: new AbortController().signal,
        },
      ),
    ).toEqual({ command: "ls" })

    // SystemPromptOptions additions type-check with and without the new fields.
    const promptOptions: Pick<SystemPromptOptions, "permissionMode" | "workspaceTrusted"> = {
      permissionMode: "plan",
      workspaceTrusted: false,
    }
    expect(promptOptions.permissionMode).toBe("plan")
    const legacy: Pick<SystemPromptOptions, "permissionMode" | "workspaceTrusted"> = {}
    expect(legacy.workspaceTrusted).toBeUndefined()
  })
})
