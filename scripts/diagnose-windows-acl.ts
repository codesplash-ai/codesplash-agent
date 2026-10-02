import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getWindowsSandboxUserStatus,
  grantWindowsAcl,
  resolveSrtWin,
  restoreWindowsAcl,
  revokeWindowsAcl,
  stampWindowsAcl,
} from "@anthropic-ai/sandbox-runtime"
import { createProfile } from "../src/engines/codesplash/sandbox/profile.ts"
import { verifiedWindowsHelper, windowsRuntimeConfig } from "../src/engines/codesplash/sandbox/windows.ts"

// Manual diagnostics on a disposable hosted runner only. No workload is run
// while individual grants are measured; this is not sandbox acceptance.
if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true")
  throw new Error("ACL diagnostics require a disposable Windows Actions runner")
const root = mkdtempSync(join(tmpdir(), "codesplash-acl-diagnostic-"))
const work = join(root, "work")
mkdirSync(work)
mkdirSync(join(work, ".git"))
const config = windowsRuntimeConfig({
  profile: createProfile(work, "workspace-write"),
  argv: [],
  temp: root,
  timeoutMs: 60000,
})
const srtWin = resolveSrtWin({ path: verifiedWindowsHelper() })
const user = getWindowsSandboxUserStatus({ srtWin })
if (!user.sid) throw new Error("Provisioned sandbox account SID missing")
const results: Array<{
  path: string
  mode: string
  durationMs: number
  error?: string
}> = []
const report = () =>
  writeFileSync("windows-acl-diagnostic.json", JSON.stringify({ acceptance: false, results }, null, 2))
// Opt-in deadline experiment on the disposable runner only: retain every
// configured ACL and measure whether propagation completes within five minutes.
// This never changes the production helper deadlines or claims acceptance.
if (process.env.CODESPLASH_EXTENDED_ACL_DIAGNOSTIC === "1") {
  let failed = false
  for (const [phase, payload] of [
    ["grant", { read: config.filesystem.allowRead, write: config.filesystem.allowWrite }],
    ["revoke", undefined],
    ["stamp", { denyRead: config.filesystem.denyRead, denyWrite: config.filesystem.denyWrite }],
    ["restore", undefined],
  ] as const) {
    console.log(`ACL_PROBE_START extended-${phase}`)
    const started = Date.now()
    const result = spawnSync(
      srtWin.exe,
      [
        ...srtWin.prependArgs,
        "acl",
        phase,
        "--holder-pid",
        String(process.pid),
        "--sandbox-user-sid",
        user.sid,
        ...(payload ? [] : ["--json"]),
      ],
      {
        input: payload ? JSON.stringify(payload) : undefined,
        encoding: "utf8",
        timeout: 300000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
    )
    const error =
      result.error?.message || (result.status !== 0 ? result.stderr || `exit ${result.status}` : undefined)
    results.push({
      path: "configured-set",
      mode: `extended-${phase}`,
      durationMs: Date.now() - started,
      ...(error ? { error } : {}),
    })
    report()
    console.log(`ACL_PROBE_RESULT ${JSON.stringify(results.at(-1))}`)
    if (error) failed = true
    if (!payload && error) throw new Error("Extended diagnostic cleanup was not confirmed; stopped")
    if (!payload && failed) throw new Error("Extended ACL phase failed; cleanup completed")
  }
  console.log("Extended ACL diagnostics completed; native acceptance has NOT been run")
  process.exit(0)
}
for (const mode of ["read", "write"] as const) {
  const paths = mode === "read" ? config.filesystem.allowRead : config.filesystem.allowWrite
  for (const path of [...new Set(paths)]) {
    console.log(`ACL_PROBE_START ${mode} ${path}`)
    const started = Date.now()
    let error: string | undefined
    let cleanupConfirmed = false
    try {
      grantWindowsAcl({
        read: mode === "read" ? [path] : [],
        write: mode === "write" ? [path] : [],
        sandboxUserSid: user.sid,
        srtWin,
      })
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    } finally {
      const result = {
        path,
        mode,
        durationMs: Date.now() - started,
        ...(error ? { error } : {}),
      }
      results.push(result)
      report()
      console.log(`ACL_PROBE_RESULT ${JSON.stringify(result)}`)
      const restored = revokeWindowsAcl({ sandboxUserSid: user.sid, srtWin })
      cleanupConfirmed = Boolean(restored)
    }
    if (!cleanupConfirmed)
      throw new Error("ACL cleanup was not confirmed; refusing further diagnostic grants")
  }
}
console.log("ACL diagnostics collected; native acceptance has NOT been run by this diagnostic.")

// Measure the same combined grant and deny sets used by initialization; a
// collection of successful individual grants does not prove the batch fits
// the helper deadline. There is still no workload during this diagnostic.
for (const phase of ["combined-grant", "combined-deny"] as const) {
  console.log(`ACL_PROBE_START ${phase}`)
  const started = Date.now()
  let cleanupConfirmed = false
  let error: string | undefined
  try {
    if (phase === "combined-grant")
      grantWindowsAcl({
        read: config.filesystem.allowRead ?? [],
        write: config.filesystem.allowWrite,
        sandboxUserSid: user.sid,
        srtWin,
      })
    else
      stampWindowsAcl({
        denyRead: config.filesystem.denyRead,
        denyWrite: config.filesystem.denyWrite,
        sandboxUserSid: user.sid,
        srtWin,
      })
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  } finally {
    const result = {
      path: "configured-set",
      mode: phase,
      durationMs: Date.now() - started,
      ...(error ? { error } : {}),
    }
    results.push(result)
    report()
    console.log(`ACL_PROBE_RESULT ${JSON.stringify(result)}`)
    const restored =
      phase === "combined-grant"
        ? revokeWindowsAcl({ sandboxUserSid: user.sid, srtWin })
        : restoreWindowsAcl({ sandboxUserSid: user.sid, srtWin })
    cleanupConfirmed = Boolean(restored)
  }
  if (!cleanupConfirmed) throw new Error("Combined ACL cleanup was not confirmed")
}
