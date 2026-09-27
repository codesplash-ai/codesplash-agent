import { expect, test } from "bun:test"
import { shellCommand, validateWindowsPath } from "../../src/core/platform.ts"

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
