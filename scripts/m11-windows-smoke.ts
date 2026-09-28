import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { shellCommand } from "../src/core/platform.ts"
import { createProfile } from "../src/engines/codesplash/sandbox/profile.ts"
import { NativeSandbox } from "../src/engines/codesplash/sandbox/runtime.ts"

if (process.platform !== "win32" || process.arch !== "x64")
  throw Error("This gate requires actual Windows x64")
const root = realpathSync(mkdtempSync(join(tmpdir(), "m11-native-"))),
  work = join(root, "work"),
  outside = join(root, "outside")
mkdirSync(work)
mkdirSync(join(work, ".git"))
writeFileSync(outside, "host-secret")
writeFileSync(join(work, ".git", "protected"), "original")
const runtime = new NativeSandbox(createProfile(work, "workspace-write")),
  ps = (text: string) => `'${text.replaceAll("'", "''")}'`
try {
  const result = await runtime.execute(
    shellCommand(
      `$ErrorActionPreference='Stop'; Set-Content -LiteralPath ${ps(join(work, "owned"))} -Value 'allowed'; try { Get-Content -LiteralPath ${ps(outside)}; exit 31 } catch {}; try { Set-Content -LiteralPath ${ps(join(work, ".git", "protected"))} -Value 'changed'; exit 32 } catch {}; Write-Output 'WINDOWS_DENIALS_PASS'`,
    ),
    new AbortController().signal,
  )
  console.log(result)
  assert.equal(result.kind, "success")
  assert.match(result.stdout, /WINDOWS_DENIALS_PASS/)
  assert.equal(readFileSync(join(work, ".git", "protected"), "utf8"), "original")
  const privileges = await runtime.execute(shellCommand("whoami /priv"), new AbortController().signal)
  assert.equal(privileges.kind, "success")
  assert.doesNotMatch(privileges.stdout, /SeRestorePrivilege/, "broker restore privilege leaked to workload")
  const abort = new AbortController(),
    timer = setTimeout(() => abort.abort(), 2000)
  try {
    const cancelled = await runtime.execute(shellCommand("Start-Sleep -Seconds 120"), abort.signal)
    assert.equal(cancelled.kind, "interrupted")
  } finally {
    clearTimeout(timer)
  }
  console.log("M11_WINDOWS_NATIVE_PASS: actual restricted-token command, filesystem deny/write, cancellation")
} finally {
  await runtime.close()
  rmSync(root, { recursive: true, force: true })
}
