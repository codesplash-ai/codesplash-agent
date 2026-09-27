import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { digest } from "../src/core/session/files.ts"
import { type MicroVMEnvironment, runMicroVM } from "../src/engines/codesplash/sandbox/microvm.ts"

const assets = process.argv[2]
if (!assets) throw new Error("Usage: bun scripts/m11-microvm-smoke.ts PINNED_ASSET_DIRECTORY")
const env: MicroVMEnvironment = {
  id: "smoke",
  transport: "microvm",
  executable: "/usr/bin/qemu-system-x86_64",
  kernel: join(assets, "kernel"),
  initrd: join(assets, "initrd"),
  kernelSha256: digest(readFileSync(join(assets, "kernel"))),
  initrdSha256: digest(readFileSync(join(assets, "initrd"))),
  memoryMiB: 256,
  accelerator: "tcg",
  bootTimeoutMs: 60000,
}
const owner = mkdtempSync(join(tmpdir(), "m11-vm-canary-")),
  canary = join(owner, "secret")
writeFileSync(canary, "host-private")
const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("codesplash-microvm-")))
try {
  const first = await runMicroVM(
    env,
    `uname -m; test ! -e '${canary}' || exit 20; test ! -e /sys/class/net/eth0 || exit 21; echo isolated > /workspace/guest-only; echo BOUNDARIES_PASS`,
    5000,
    new AbortController().signal,
  )
  console.log(first)
  assert.equal(first.kind, "success")
  assert.match(first.stdout, /x86_64/)
  assert.match(first.stdout, /BOUNDARIES_PASS/)
  const second = await runMicroVM(
    env,
    "test ! -e /workspace/guest-only; exit $?",
    5000,
    new AbortController().signal,
  )
  console.log(second)
  assert.equal(second.exitCode, 0)
  const timeout = await runMicroVM(env, "sleep 30", 1000, new AbortController().signal)
  console.log(timeout)
  assert.notEqual(timeout.exitCode, 0)
  const abort = new AbortController(),
    timer = setTimeout(() => abort.abort(), 1500)
  try {
    const cancelled = await runMicroVM(env, "sleep 30", 30000, abort.signal)
    assert.equal(cancelled.kind, "interrupted")
  } finally {
    clearTimeout(timer)
  }
  assert.deepEqual(
    readdirSync(tmpdir()).filter((n) => n.startsWith("codesplash-microvm-") && !before.has(n)),
    [],
  )
  assert.equal(readFileSync(canary, "utf8"), "host-private")
  console.log(
    "M11_MICROVM_PASS: actual guest, host-file/network denial, ephemeral state, timeout, cancellation, cleanup",
  )
} finally {
  rmSync(owner, { recursive: true, force: true })
}
