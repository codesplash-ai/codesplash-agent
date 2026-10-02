import { expect, test } from "bun:test"
import { shellCommand } from "../../src/core/platform.ts"
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
