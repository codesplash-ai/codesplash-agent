import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { atomic, bytes, lease } from "../src/core/session/files.ts"
import { createProfile } from "../src/engines/codesplash/sandbox/profile.ts"
import { NativeSandbox } from "../src/engines/codesplash/sandbox/runtime.ts"

const kernel = readFileSync("/proc/version", "utf8")
if (!/android/i.test(kernel)) throw Error("This acceptance gate requires an actual Android kernel")
const root = realpathSync(mkdtempSync(join(tmpdir(), "codesplash-termux-")))
try {
  const release = lease(root)
  atomic(join(root, "probe"), "local-storage")
  assert.equal(bytes(join(root, "probe")).toString(), "local-storage")
  release()
  const launch = Bun.spawn([process.execPath, resolve("dist/cli.js"), "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, version] = await Promise.all([launch.exited, new Response(launch.stdout).text()])
  assert.equal(code, 0)
  const runtime = new NativeSandbox(createProfile(root, "workspace-write"))
  try {
    const result = await runtime.execute(
      ["/bin/sh", "-c", "echo TERMUX_SANDBOX"],
      new AbortController().signal,
    )
    assert.ok(result.kind === "success" || result.kind === "unavailable")
    console.log(
      JSON.stringify(
        {
          kernel: kernel.trim(),
          runtime: Bun.version,
          version: version.trim(),
          storage: "passed",
          sandbox: result.kind,
          detail: result.stderr,
          scope: result.kind === "success" ? "local-command-probe-only" : "remote-client-only",
        },
        null,
        2,
      ),
    )
  } finally {
    await runtime.close()
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
