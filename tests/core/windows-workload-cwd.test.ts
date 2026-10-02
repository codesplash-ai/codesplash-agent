import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { shellCommand } from "../../src/core/platform.ts"
import { physicalPath } from "../../src/engines/codesplash/sandbox/profile.ts"
import { windowsWorkloadArgv } from "../../src/engines/codesplash/sandbox/windows.ts"

test("encoded PowerShell workloads establish native and provider cwd without changing the command", () => {
  const cwd = "C:\\Users\\someone's folder\\work"
  const command = "Write-Output 'héllo'; Set-Content './owned' 'ok' # final comment"
  const argv = shellCommand(command, "win32", { SystemRoot: "C:\\Windows" })
  const prepared = windowsWorkloadArgv(argv, cwd)
  expect(prepared.slice(0, -1)).toEqual(argv.slice(0, -1))
  const script = Buffer.from(prepared.at(-1) ?? "", "base64").toString("utf16le")
  expect(script).toContain("-Root 'C:\\Users\\someone''s folder\\work'")
  expect(script).toContain("Set-Location -LiteralPath 'CodeSplashWorkspace:\\'")
  expect(script).toContain("[IO.Directory]::SetCurrentDirectory(")
  expect(script).toContain("$PWD.ProviderPath")
  expect(script.endsWith(`\r\n${command}`)).toBe(true)
})

test("native executables and PowerShell file argument payloads are not reinterpreted", () => {
  for (const argv of [
    ["git.exe", "status"],
    ["powershell.exe", "-File", "script.ps1", "-Command", "data", "other"],
  ]) {
    expect(windowsWorkloadArgv(argv, "C:\\work")).toEqual(argv)
  }
})

test("explicit PowerShell command arguments receive the same working-directory setup", () => {
  const argv = ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-NoProfile", "-Command", "Get-Location"]
  expect(windowsWorkloadArgv(argv, "C:\\work").at(-1)).toEndWith("\r\nGet-Location")
})

test.skipIf(process.platform !== "win32")(
  "PowerShell custom drive root and native cwd address the same real folder",
  () => {
    const cwd = physicalPath(mkdtempSync(join(tmpdir(), "codesplash-ps-cwd-")))
    try {
      const argv = windowsWorkloadArgv(
        shellCommand(
          "Set-Content -LiteralPath './owned' -Value 'ok'; [IO.File]::WriteAllText([IO.Path]::Combine([IO.Directory]::GetCurrentDirectory(), 'native'), 'ok')",
        ),
        cwd,
      )
      const executable = argv.shift()
      if (!executable) throw Error("PowerShell executable missing")
      execFileSync(executable, argv, { cwd, timeout: 15000 })
      expect(readFileSync(join(cwd, "owned"), "utf8").trim()).toBe("ok")
      expect(readFileSync(join(cwd, "native"), "utf8")).toBe("ok")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  },
  20000,
)
