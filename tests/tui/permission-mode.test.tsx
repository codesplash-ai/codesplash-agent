import { describe, expect, test } from "bun:test"
import {
  type AppOptions,
  type AppViewState,
  defaultAppOptions,
  initialAppViewState,
  type SessionMeta,
  type SessionPolicy,
} from "../../src/core/index.ts"
import {
  currentPermissionMode,
  keyboardHelpEntries,
  nextPermissionMode,
  permissionModeBadgeLabel,
  permissionModeCycle,
  permissionModeCycleHint,
  slashCommandHelp,
} from "../../src/tui/codex-session.tsx"
import {
  permissionLaunchOptionsFrom,
  permissionOverridesFrom,
  replayedPermissionMode,
  resumedPermissionMode,
} from "../../src/tui/run-codex-session.tsx"

function stateWith(permissionMode?: string): AppViewState {
  return { ...initialAppViewState, permissionMode }
}

function policyWith(permissionMode?: SessionPolicy["permissionMode"]): SessionPolicy {
  return { sandbox: "workspace-write", approvalPolicy: "on-request", permissionMode }
}

function metaWith(permissionMode?: string): SessionMeta {
  const now = "2026-08-29T00:00:00.000Z"
  return {
    schemaVersion: 1,
    engine: "codesplash",
    localSessionId: "local-1",
    projectPath: "/workspace/project",
    projectId: "abcd",
    createdAt: now,
    updatedAt: now,
    lastStatus: "ready",
    lastSequence: 3,
    ...(permissionMode === undefined ? {} : { permissionMode }),
  } as SessionMeta
}

describe("Shift+Tab permission mode cycling", () => {
  test("cycles default → accept-edits → plan → default without the bypass flag", () => {
    expect(nextPermissionMode("default", false)).toBe("accept-edits")
    expect(nextPermissionMode("accept-edits", false)).toBe("plan")
    expect(nextPermissionMode("plan", false)).toBe("default")
  })

  test("includes bypass in the cycle only when the launch flag allowed it", () => {
    expect(nextPermissionMode("plan", true)).toBe("bypass")
    expect(nextPermissionMode("bypass", true)).toBe("default")
    // Every position in the gated cycle skips bypass.
    for (const mode of ["default", "accept-edits", "plan"] as const) {
      expect(nextPermissionMode(mode, false)).not.toBe("bypass")
    }
  })

  test("an unknown current mode restarts the cycle at default", () => {
    // e.g. "bypass" reported while the flag was declined: indexOf misses, cycle restarts.
    expect(nextPermissionMode("bypass", false)).toBe("default")
  })

  test("the full cycle order is pinned", () => {
    expect(permissionModeCycle).toEqual(["default", "accept-edits", "plan", "bypass"])
  })

  test("the cycle hint names bypass only when it is reachable", () => {
    expect(permissionModeCycleHint(false)).toBe("Shift+Tab cycles default → accept-edits → plan")
    expect(permissionModeCycleHint(true)).toBe("Shift+Tab cycles default → accept-edits → plan → bypass")
  })
})

describe("live permission mode resolution", () => {
  test("the last session.status-reported mode wins over the opening policy", () => {
    expect(currentPermissionMode(stateWith("plan"), policyWith("default"))).toBe("plan")
  })

  test("falls back to the policy, then to default, and ignores unknown strings", () => {
    expect(currentPermissionMode(stateWith(undefined), policyWith("accept-edits"))).toBe("accept-edits")
    expect(currentPermissionMode(stateWith(undefined), policyWith(undefined))).toBe("default")
    // Loosely-typed events could carry anything; unknown values never reach the cycle.
    expect(currentPermissionMode(stateWith("weird-mode"), policyWith("plan"))).toBe("plan")
  })
})

describe("status-line mode badge", () => {
  test("default renders no badge; the other modes have pinned labels", () => {
    expect(permissionModeBadgeLabel("default")).toBeUndefined()
    expect(permissionModeBadgeLabel("plan")).toBe("PLAN")
    expect(permissionModeBadgeLabel("accept-edits")).toBe("ACCEPT EDITS")
    expect(permissionModeBadgeLabel("bypass")).toBe("BYPASS")
  })
})

describe("help text", () => {
  test("documents Shift+Tab and the persisting approval key", () => {
    const keys = keyboardHelpEntries.map((entry) => entry.keys).join(" ")
    expect(keys).toContain("Shift+Tab")
    expect(keys).toContain("P")
    const permissionsHelp = slashCommandHelp.find((entry) => entry.command === "/permissions")
    expect(permissionsHelp?.description).toContain("mode")
    expect(permissionsHelp?.description).toContain("rules")
  })
})

describe("resume permission mode reuse", () => {
  test("reuses a recorded non-bypass mode", () => {
    expect(resumedPermissionMode(metaWith("plan"))).toBe("plan")
    expect(resumedPermissionMode(metaWith("accept-edits"))).toBe("accept-edits")
    expect(resumedPermissionMode(metaWith("default"))).toBe("default")
  })

  test("bypass never survives a resume — the launch flag is required per session", () => {
    expect(resumedPermissionMode(metaWith("bypass"))).toBeUndefined()
  })

  test("ignores absent or unknown recorded modes (loose meta validation)", () => {
    expect(resumedPermissionMode(metaWith(undefined))).toBeUndefined()
    expect(resumedPermissionMode(metaWith("full-speed"))).toBeUndefined()
  })

  test("the replayed event log's last mode wins with the same gating as meta", () => {
    // Mid-session Shift+Tab changes only exist in the event log, not the created-at meta.
    expect(replayedPermissionMode(stateWith("plan"))).toBe("plan")
    expect(replayedPermissionMode(stateWith("bypass"))).toBeUndefined()
    expect(replayedPermissionMode(stateWith("full-speed"))).toBeUndefined()
    expect(replayedPermissionMode(stateWith(undefined))).toBeUndefined()
  })
})

describe("permission launch options from app options", () => {
  test("no rule flags means no CLI override tier at all", () => {
    expect(permissionOverridesFrom(defaultAppOptions)).toBeUndefined()
  })

  test("rule flags travel as the CLI override tier", () => {
    const options: AppOptions = {
      ...defaultAppOptions,
      allowRules: ["bash(git status *)"],
      denyRules: ["read_file(**/*.secret)"],
    }
    expect(permissionOverridesFrom(options)).toEqual({
      allow: ["bash(git status *)"],
      ask: [],
      deny: ["read_file(**/*.secret)"],
    })
  })

  test("modeExplicit is true only for an explicit flag (mode override or bypass)", () => {
    expect(permissionLaunchOptionsFrom(defaultAppOptions).modeExplicit).toBe(false)
    expect(
      permissionLaunchOptionsFrom({ ...defaultAppOptions, permissionModeOverride: "plan" }).modeExplicit,
    ).toBe(true)
    const bypass = permissionLaunchOptionsFrom({ ...defaultAppOptions, bypassApprovals: true })
    expect(bypass.modeExplicit).toBe(true)
    expect(bypass.bypassApprovals).toBe(true)
  })
})
