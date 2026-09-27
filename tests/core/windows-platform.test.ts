import { expect, test } from "bun:test"
import { shellCommand, validateWindowsPath } from "../../src/core/platform.ts"
import { childEnvironment, supervisorEnvironment } from "../../src/engines/codesplash/sandbox/env-policy.ts"

test.skipIf(process.platform !== "win32")(
  "Windows broker state stays separate from workload profiles",
  () => {
    const source = { ...process.env, LOCALAPPDATA: "C:\\host-state", OPENAI_API_KEY: "credential-canary" }
    const child = childEnvironment("C:\\owned-temp", [], source)
    const broker = supervisorEnvironment("C:\\owned-temp", source)
    expect(child.LOCALAPPDATA).toBe("C:\\owned-temp")
    expect(child.APPDATA).toBe("C:\\owned-temp")
    expect(broker.LOCALAPPDATA).toBe("C:\\host-state")
    expect(child.OPENAI_API_KEY).toBeUndefined()
    expect(broker.OPENAI_API_KEY).toBeUndefined()
  },
)

test.skipIf(process.platform !== "win32")(
  "real Windows PowerShell preserves literal Unicode, quotes and dollar signs",
  () => {
    const literal = "quotes ' dollar $ and Unicode α",
      command = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); [Console]::Write('${literal.replaceAll("'", "''")}')`,
      child = Bun.spawnSync(
        shellCommand(command, "win32", { ...process.env, CODESPLASH_WINDOWS_SHELL: "powershell" }),
        { stdout: "pipe", stderr: "pipe", timeout: 10000 },
      )
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    expect(child.stdout.toString()).toBe(literal)
    expect(() => validateWindowsPath(process.cwd())).not.toThrow()
  },
)
test.skipIf(process.platform !== "win32")("real Windows cmd runs with AutoRun disabled", () => {
  const child = Bun.spawnSync(
    shellCommand("echo WINDOWS_CMD_OK", "win32", { ...process.env, CODESPLASH_WINDOWS_SHELL: "cmd" }),
    { stdout: "pipe", stderr: "pipe", timeout: 10000 },
  )
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  expect(child.stdout.toString().trim()).toBe("WINDOWS_CMD_OK")
})
