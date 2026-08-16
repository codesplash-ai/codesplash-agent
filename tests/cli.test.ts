import { describe, expect, test } from "bun:test"
import { parseAppArguments } from "../src/cli.ts"
import { effectiveHistoryEnabled, effectiveSessionPolicy } from "../src/core/app-options.ts"
import { defaultConfig } from "../src/core/config.ts"

describe("parseAppArguments", () => {
  test("parses the project path and defaults", () => {
    expect(parseAppArguments([])).toEqual({
      path: undefined,
      options: { noHistory: false, fullAccess: false },
    })
    expect(parseAppArguments(["/tmp/project"])).toEqual({
      path: "/tmp/project",
      options: { noHistory: false, fullAccess: false },
    })
  })

  test("parses history, sandbox, and full-access flags in any order", () => {
    expect(parseAppArguments(["--no-history", "/tmp/project", "--sandbox", "read-only"])).toEqual({
      path: "/tmp/project",
      options: { noHistory: true, fullAccess: false, sandboxOverride: "read-only" },
    })
    expect(parseAppArguments(["--sandbox=workspace-write", "--full-access"])).toEqual({
      path: undefined,
      options: { noHistory: false, fullAccess: true, sandboxOverride: "workspace-write" },
    })
  })

  test("rejects invalid sandbox values, danger mode via --sandbox, and unknown flags", () => {
    expect(() => parseAppArguments(["--sandbox", "yolo"])).toThrow(
      "--sandbox expects read-only or workspace-write",
    )
    expect(() => parseAppArguments(["--sandbox"])).toThrow("got nothing")
    expect(() => parseAppArguments(["--sandbox", "danger-full-access"])).toThrow(
      "Use --full-access to run without a sandbox",
    )
    expect(() => parseAppArguments(["--frobnicate"])).toThrow("Unknown option --frobnicate")
    expect(() => parseAppArguments(["a", "b"])).toThrow("Expected at most one project path")
  })
})

describe("effective options", () => {
  test("flags override config with flag > config > default precedence", () => {
    const config = structuredClone(defaultConfig)
    config.codex.sandbox = "read-only"
    config.history.enabled = true

    expect(effectiveSessionPolicy(config, { noHistory: false, fullAccess: false })).toEqual({
      sandbox: "read-only",
      approvalPolicy: "on-request",
    })
    expect(
      effectiveSessionPolicy(config, {
        noHistory: false,
        fullAccess: false,
        sandboxOverride: "workspace-write",
      }),
    ).toEqual({ sandbox: "workspace-write", approvalPolicy: "on-request" })
    expect(
      effectiveSessionPolicy(config, {
        noHistory: false,
        fullAccess: true,
        sandboxOverride: "workspace-write",
      }).sandbox,
    ).toBe("danger-full-access")

    expect(effectiveHistoryEnabled(config, { noHistory: false, fullAccess: false })).toBe(true)
    expect(effectiveHistoryEnabled(config, { noHistory: true, fullAccess: false })).toBe(false)
    config.history.enabled = false
    expect(effectiveHistoryEnabled(config, { noHistory: false, fullAccess: false })).toBe(false)
  })
})
