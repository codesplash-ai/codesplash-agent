import { describe, expect, test } from "bun:test"
import { defaultAppOptions, effectiveSessionPolicy } from "../../src/core/app-options.ts"
import { defaultConfig } from "../../src/core/config.ts"

describe("effectiveSessionPolicy permission mode resolution", () => {
  test("defaults resolve to the config's permission mode", () => {
    const policy = effectiveSessionPolicy(defaultConfig, defaultAppOptions)
    expect(policy.permissionMode).toBe("default")
    // Existing fields are untouched by the permissions additions.
    expect(policy.sandbox).toBe("workspace-write")
    expect(policy.approvalPolicy).toBe("on-request")
  })

  test("config [permissions].mode flows through when no flag overrides it", () => {
    const config = {
      ...structuredClone(defaultConfig),
      permissions: { ...defaultConfig.permissions, mode: "plan" as const },
    }
    expect(effectiveSessionPolicy(config, defaultAppOptions).permissionMode).toBe("plan")
  })

  test("--permission-mode overrides the config mode", () => {
    const config = {
      ...structuredClone(defaultConfig),
      permissions: { ...defaultConfig.permissions, mode: "plan" as const },
    }
    const options = { ...defaultAppOptions, permissionModeOverride: "accept-edits" as const }
    expect(effectiveSessionPolicy(config, options).permissionMode).toBe("accept-edits")
  })

  test("--bypass-approvals wins over both the flag override and the config mode", () => {
    const config = {
      ...structuredClone(defaultConfig),
      permissions: { ...defaultConfig.permissions, mode: "plan" as const },
    }
    const options = {
      ...defaultAppOptions,
      bypassApprovals: true,
      permissionModeOverride: "accept-edits" as const,
    }
    expect(effectiveSessionPolicy(config, options).permissionMode).toBe("bypass")
  })

  test("default options carry no bypass, no rules, and no trust", () => {
    expect(defaultAppOptions.bypassApprovals).toBe(false)
    expect(defaultAppOptions.trustWorkspace).toBe(false)
    expect(defaultAppOptions.allowRules).toEqual([])
    expect(defaultAppOptions.askRules).toEqual([])
    expect(defaultAppOptions.denyRules).toEqual([])
  })
})
