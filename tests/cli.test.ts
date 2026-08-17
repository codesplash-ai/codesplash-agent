import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import packageJson from "../package.json"
import { parseAppArguments } from "../src/cli.ts"
import { effectiveHistoryEnabled, effectiveSessionPolicy } from "../src/core/app-options.ts"
import { defaultConfig } from "../src/core/config.ts"
import { formatDoctorReport } from "../src/doctor.ts"
import { APP_VERSION } from "../src/version.ts"

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

describe("version and doctor", () => {
  test("APP_VERSION stays in sync with package.json", () => {
    expect(APP_VERSION).toBe(packageJson.version)
  })

  test("--version prints the version and exits cleanly", async () => {
    const child = Bun.spawn([process.execPath, "src/cli.ts", "--version"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    expect(exitCode).toBe(0)
    expect(output.trim()).toBe(APP_VERSION)
  })

  test("--doctor reports diagnostics and always exits 0", async () => {
    const child = Bun.spawn([process.execPath, "src/cli.ts", "--doctor"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    expect(exitCode).toBe(0)
    expect(output).toContain(`CodeSplash Agent ${APP_VERSION}`)
    expect(output).toContain("codex")
    expect(output).toContain("claude")
    expect(output).toContain("config")
    expect(output).toContain("data")
  }, 30000)

  test("formats missing and unsupported engines as findings, not failures", () => {
    const report = formatDoctorReport({
      version: "9.9.9",
      runtime: "bun 1.3.14",
      platform: "darwin arm64",
      configPath: "/tmp/config.toml",
      configPresent: false,
      dataDirectory: "/tmp/data",
      git: "available",
      codex: { available: true, authenticated: true, compatible: false, version: "0.150.0" },
      claude: { available: false, detail: "Not installed" },
    })
    expect(report).toContain("CodeSplash Agent 9.9.9")
    expect(report).toContain("unsupported version")
    expect(report).toContain("○ Not installed")
    expect(report).toContain("defaults; not created yet")
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
