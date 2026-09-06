/** Real execution gate for standalone artifacts; no model, credentials, or external network. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { childEnvironment } from "../src/engines/codesplash/sandbox/env-policy.ts"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"
import { createProfile, physicalPath } from "../src/engines/codesplash/sandbox/profile.ts"

const binary = process.argv[2]
if (!binary) throw new Error("Usage: bun scripts/sandbox-smoke.ts /path/to/codesplash")
if (!["darwin", "linux"].includes(process.platform)) throw new Error("Sandbox smoke requires a supported OS")
const executable = resolve(binary)
const parent = physicalPath(await mkdtemp(join(tmpdir(), "codesplash-artifact-smoke-")))
const cwd = join(parent, "project"),
  temp = join(parent, "temporary")
await mkdir(cwd)
await mkdir(temp)
async function command(args: string[], input?: string) {
  return runProcess([executable, ...args], {
    cwd,
    env: childEnvironment(temp),
    signal: AbortSignal.timeout(20_000),
    input,
    timeoutMs: 15_000,
  })
}
try {
  const allowed = await command(["sandbox", "--no-history", "--", "/bin/bash", "-c", "printf ok > allowed"])
  assert.equal(allowed.exitCode, 0, JSON.stringify(allowed))
  assert.equal(await readFile(join(cwd, "allowed"), "utf8"), "ok")
  const denied = await command([
    "sandbox",
    "--no-history",
    "--",
    "/bin/bash",
    "-c",
    "printf bad > ../outside",
  ])
  assert.notEqual(denied.exitCode, 0, JSON.stringify(denied))
  assert.equal(await Bun.file(join(parent, "outside")).exists(), false)
  const readonly = await command([
    "sandbox",
    "--no-history",
    "--read-only",
    "--",
    "/usr/bin/touch",
    "readonly",
  ])
  assert.notEqual(readonly.exitCode, 0, JSON.stringify(readonly))
  const profile = createProfile(cwd, "workspace-write")
  const worker = {
    tool: "write_file",
    input: { path: "worker.txt", content: "compiled worker" },
    cwd,
    policy: { sandbox: "workspace-write", approvalPolicy: "on-request" },
    rules: { allow: [], ask: [], deny: [] },
  }
  const wire = JSON.stringify({
    profile,
    argv: [executable, "--internal-sandbox-worker"],
    input: JSON.stringify(worker),
    temp,
    timeoutMs: 10_000,
    structured: true,
  })
  const transport = await command(["--internal-sandbox-supervisor"], wire)
  assert.equal(transport.exitCode, 0, JSON.stringify(transport))
  const result = JSON.parse(transport.stdout)
  assert.equal(result.kind, "success", JSON.stringify(result))
  assert.equal(JSON.parse(result.stdout).isError, undefined, result.stdout)
  assert.equal(await readFile(join(cwd, "worker.txt"), "utf8"), "compiled worker")
  process.stdout.write(
    "Standalone sandbox smoke passed: project write, external denial, read-only, compiled worker\n",
  )
} finally {
  await rm(parent, { recursive: true, force: true })
}
