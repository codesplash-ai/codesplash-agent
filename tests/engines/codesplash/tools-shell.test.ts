import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionPolicy } from "../../../src/core/index.ts"
import { applyStoredCredentials, setApiKey } from "../../../src/engines/codesplash/auth.ts"
import { type ToolContext, ToolInputError } from "../../../src/engines/codesplash/contracts.ts"
import { bashTool, ELISION_MARKER, MAX_OUTPUT_BYTES } from "../../../src/engines/codesplash/tools/bash.ts"

const workDir = realpathSync(mkdtempSync(join(tmpdir(), "codesplash-bash-")))

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function makeContext(policy?: Partial<SessionPolicy>, overrides?: Partial<ToolContext>): ToolContext {
  return {
    cwd: workDir,
    policy: { sandbox: "workspace-write", approvalPolicy: "on-request", ...policy },
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe("bash tool spec", () => {
  test("identifies itself and is never read-only", () => {
    expect(bashTool.name).toBe("bash")
    expect(bashTool.inputSchema).toMatchObject({ type: "object", required: ["command"] })
    expect(bashTool.isReadOnly({ command: "ls" })).toBe(false)
    expect(bashTool.isReadOnly({ command: "cat file.txt" })).toBe(false)
  })

  test("rejects malformed input", async () => {
    const context = makeContext()
    await expect(bashTool.run(undefined, context)).rejects.toBeInstanceOf(ToolInputError)
    await expect(bashTool.run({}, context)).rejects.toBeInstanceOf(ToolInputError)
    await expect(bashTool.run({ command: "   " }, context)).rejects.toBeInstanceOf(ToolInputError)
    await expect(bashTool.run({ command: "echo hi", timeout: -5 }, context)).rejects.toBeInstanceOf(
      ToolInputError,
    )
    await expect(bashTool.run({ command: "echo hi", timeout: "fast" }, context)).rejects.toBeInstanceOf(
      ToolInputError,
    )
    expect(() => bashTool.permission({ command: 42 }, context)).toThrow(ToolInputError)
  })
})

describe("bash tool execution", () => {
  test("echo round-trip merges output and appends the exit code", async () => {
    const outcome = await bashTool.run({ command: "echo hello harness" }, makeContext())
    expect(outcome.text).toContain("hello harness")
    expect(outcome.text).toContain("Exit code: 0")
    expect(outcome.isError).toBe(false)
    expect(outcome.label).toBe("echo hello harness")
    expect(outcome.mutatedPaths).toBeUndefined()
  })

  test("merges stderr with stdout", async () => {
    const outcome = await bashTool.run({ command: "echo to-out; echo to-err 1>&2" }, makeContext())
    expect(outcome.text).toContain("to-out")
    expect(outcome.text).toContain("to-err")
    expect(outcome.text).toContain("Exit code: 0")
  })

  test("reports non-zero exit codes as errors", async () => {
    const outcome = await bashTool.run({ command: "echo failing; exit 7" }, makeContext())
    expect(outcome.text).toContain("failing")
    expect(outcome.text).toContain("Exit code: 7")
    expect(outcome.isError).toBe(true)
  })

  test("reports the exit code with no output", async () => {
    const outcome = await bashTool.run({ command: "exit 3" }, makeContext())
    expect(outcome.text).toBe("Exit code: 3")
    expect(outcome.isError).toBe(true)
  })

  test("honors cwd", async () => {
    const outcome = await bashTool.run({ command: "pwd" }, makeContext())
    expect(outcome.text).toContain(workDir)
    expect(outcome.isError).toBe(false)
  })

  test("kills the command after the timeout", async () => {
    const started = Date.now()
    const outcome = await bashTool.run(
      { command: "echo before-sleep; sleep 30", timeout: 300 },
      makeContext(),
    )
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(outcome.text).toContain("before-sleep")
    expect(outcome.text).toContain("timed out after 300ms")
    expect(outcome.text).toMatch(/Exit code: \d+/)
    expect(outcome.isError).toBe(true)
  })

  test("kills the whole process group on timeout, including pipeline children", async () => {
    // Non-interactive bash does not forward SIGTERM to pipeline members; the harness signals
    // the process group, so the inner sleep must be gone shortly after the timeout.
    const marker = "29.876543"
    const outcome = await bashTool.run({ command: `sleep 30 | sleep ${marker}`, timeout: 300 }, makeContext())
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain("timed out after 300ms")

    const deadline = Date.now() + 5_000
    let alive = true
    while (Date.now() < deadline) {
      const scan = Bun.spawnSync(["pgrep", "-f", `sleep ${marker}`])
      if (scan.exitCode !== 0) {
        alive = false
        break
      }
      await Bun.sleep(50)
    }
    expect(alive).toBe(false)
  }, 15_000)

  test("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const started = Date.now()
    const outcome = await bashTool.run({ command: "trap '' TERM; sleep 30", timeout: 200 }, makeContext())
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(10_000)
    expect(outcome.text).toContain("timed out after 200ms")
    expect(outcome.isError).toBe(true)
  }, 15_000)

  test("clamps an over-max timeout instead of rejecting it", async () => {
    const outcome = await bashTool.run({ command: "echo clamped", timeout: 10_000_000 }, makeContext())
    expect(outcome.text).toContain("clamped")
    expect(outcome.isError).toBe(false)
  })

  test("stops the command when the context signal aborts", async () => {
    const controller = new AbortController()
    const context = makeContext(undefined, { signal: controller.signal })
    const started = Date.now()
    const pending = bashTool.run({ command: "sleep 30" }, context)
    setTimeout(() => controller.abort(), 100)
    const outcome = await pending
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(outcome.text).toContain("interrupted")
    expect(outcome.isError).toBe(true)
  })

  test("returns immediately when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const outcome = await bashTool.run(
      { command: "echo unreachable" },
      makeContext(undefined, { signal: controller.signal }),
    )
    expect(outcome.text).toContain("interrupted")
    expect(outcome.text).not.toContain("unreachable")
    expect(outcome.isError).toBe(true)
  })
})

describe("bash tool output capping", () => {
  test("keeps small output intact with no marker", async () => {
    const outcome = await bashTool.run({ command: "seq 1 100" }, makeContext())
    expect(outcome.text).not.toContain(ELISION_MARKER)
    expect(outcome.text).toContain("1\n")
    expect(outcome.text).toContain("100")
  })

  test("caps output over 2000 lines to head and tail with an elision marker", async () => {
    const outcome = await bashTool.run({ command: "seq 1 3000" }, makeContext())
    expect(outcome.text).toContain(ELISION_MARKER)
    expect(outcome.text).toContain("\n1000\n")
    expect(outcome.text).not.toContain("\n1500\n")
    expect(outcome.text).toContain("\n2999\n")
    expect(outcome.text.split("\n").length).toBeLessThan(2_100)
    expect(outcome.isError).toBe(false)
  })

  test("caps output over 50KB by bytes", async () => {
    const outcome = await bashTool.run(
      { command: "yes abcdefghijklmnopqrstuvwxyz | head -n 8000" },
      makeContext(),
    )
    expect(outcome.text).toContain(ELISION_MARKER)
    expect(Buffer.byteLength(outcome.text, "utf8")).toBeLessThan(MAX_OUTPUT_BYTES + 1_024)
    expect(outcome.text.startsWith("abcdefghijklmnopqrstuvwxyz")).toBe(true)
    expect(outcome.text).toContain("Exit code: 0")
  })

  test("bounds retention for very large output while keeping head and tail", async () => {
    const outcome = await bashTool.run(
      {
        command:
          "echo FIRST-LINE; yes filler-line-abcdefghijklmnopqrstuvwxyz | head -n 40000; echo LAST-LINE",
      },
      makeContext(),
    )
    expect(outcome.text).toContain("FIRST-LINE")
    expect(outcome.text).toContain("LAST-LINE")
    expect(outcome.text).toContain(ELISION_MARKER)
    expect(Buffer.byteLength(outcome.text, "utf8")).toBeLessThan(MAX_OUTPUT_BYTES + 1_024)
  })
})

describe("bash tool permissions", () => {
  const command = "git status"

  test("sandbox read-only: approval, always, without a session key", () => {
    for (const approvalPolicy of ["on-request", "untrusted"] as const) {
      const permission = bashTool.permission(
        { command },
        makeContext({ sandbox: "read-only", approvalPolicy }),
      )
      expect(permission).toEqual({
        kind: "approval",
        title: "Run command?",
        detail: `${command}\n${workDir}`,
      })
    }
  })

  test("workspace-write + on-request: approval keyed by bash:<argv0>", () => {
    const permission = bashTool.permission(
      { command },
      makeContext({ sandbox: "workspace-write", approvalPolicy: "on-request" }),
    )
    expect(permission).toEqual({
      kind: "approval",
      title: "Run command?",
      detail: `${command}\n${workDir}`,
      sessionKey: "bash:git",
    })
  })

  test("workspace-write + untrusted: approval without a session key", () => {
    const permission = bashTool.permission(
      { command },
      makeContext({ sandbox: "workspace-write", approvalPolicy: "untrusted" }),
    )
    expect(permission).toEqual({
      kind: "approval",
      title: "Run command?",
      detail: `${command}\n${workDir}`,
    })
  })

  test("danger-full-access: no permission required", () => {
    for (const approvalPolicy of ["on-request", "untrusted"] as const) {
      const permission = bashTool.permission(
        { command },
        makeContext({ sandbox: "danger-full-access", approvalPolicy }),
      )
      expect(permission).toEqual({ kind: "none" })
    }
  })

  test("session key uses the first token of the command", () => {
    const permission = bashTool.permission(
      { command: "  bun   test tests/" },
      makeContext({ sandbox: "workspace-write", approvalPolicy: "on-request" }),
    )
    expect(permission).toMatchObject({ sessionKey: "bash:bun" })
  })
})

describe("bash tool credential hygiene", () => {
  test("API keys injected from the credential store never reach spawned commands", async () => {
    const saved = {
      configDir: process.env.CODESPLASH_AGENT_CONFIG_DIR,
      openai: process.env.OPENAI_API_KEY,
    }
    const storeDir = mkdtempSync(join(tmpdir(), "codesplash-bash-store-"))
    try {
      process.env.CODESPLASH_AGENT_CONFIG_DIR = storeDir
      delete process.env.OPENAI_API_KEY
      setApiKey("openai", "stored-bash-secret-key")
      applyStoredCredentials()
      // Read through a non-literal key so the `delete` narrowing above does not stick.
      const readEnv = (name: string): string | undefined => process.env[name]
      expect(readEnv("OPENAI_API_KEY")).toBe("stored-bash-secret-key")

      // `env`-style diagnostics in a child must not see (and transcribe) the stored key;
      // printenv exits 1 when the variable is absent from the child environment.
      const outcome = await bashTool.run({ command: "printenv OPENAI_API_KEY" }, makeContext())
      expect(outcome.text).not.toContain("stored-bash-secret-key")
      expect(outcome.text).toContain("Exit code: 1")
      expect(outcome.isError).toBe(true)
    } finally {
      rmSync(storeDir, { recursive: true, force: true })
      if (saved.configDir === undefined) delete process.env.CODESPLASH_AGENT_CONFIG_DIR
      else process.env.CODESPLASH_AGENT_CONFIG_DIR = saved.configDir
      if (saved.openai === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = saved.openai
    }
  })
})

describe("bash permissionTargets", () => {
  test("reports the command line and throws ToolInputError on malformed input", () => {
    const context = makeContext()
    expect(bashTool.permissionTargets?.({ command: "git status --short" }, context)).toEqual({
      command: "git status --short",
    })
    expect(() => bashTool.permissionTargets?.({}, context)).toThrow(ToolInputError)
    expect(() => bashTool.permissionTargets?.({ command: "   " }, context)).toThrow(ToolInputError)
  })
})
