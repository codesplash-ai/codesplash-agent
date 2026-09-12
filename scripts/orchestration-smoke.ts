/** Compiled worktree lifecycle and two separate authenticated Unix-peer processes. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { git } from "../src/core/orchestration/git.ts"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"

const binary = resolve(process.argv[2] ?? "out/codesplash"),
  root = await realpath(await mkdtemp(join(tmpdir(), "cs-m7d-smoke-"))),
  cwd = join(root, "repo")
await mkdir(cwd)
const env: NodeJS.ProcessEnv = {
  ...process.env,
  CODESPLASH_AGENT_CONFIG_DIR: join(root, "config"),
  CODESPLASH_AGENT_DATA_DIR: join(root, "data"),
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
}
for (const key of ["CODESPLASH_CONFIG", "CODESPLASH_PROFILE", "CODESPLASH_PERMISSION_MODE"]) delete env[key]
const run = async (args: string[]) => {
  const value = await runProcess([binary, ...args], {
    cwd,
    env,
    signal: AbortSignal.timeout(30000),
    timeoutMs: 30000,
    maxBytes: 1024 * 1024,
    structured: true,
  })
  assert.equal(value.exitCode, 0, value.stdout + value.stderr)
  return JSON.parse(value.stdout)
}
try {
  await git(cwd, ["init", "-q"])
  await Bun.write(join(cwd, "file.txt"), "base\n")
  await git(cwd, ["add", "file.txt"])
  await git(cwd, ["commit", "-qm", "base"])
  const tree = await run(["worktree", "create", "--apply", "--trust"])
  await Bun.write(join(tree.cwd, "file.txt"), "compiled child\n")
  const preview = await run(["worktree", "preview", tree.id])
  await run(["worktree", "apply", tree.id, "--fingerprint", preview.fingerprint, "--apply", "--trust"])
  assert.equal(await Bun.file(join(cwd, "file.txt")).text(), "compiled child\n")
  const recovery = await run(["worktree", "recover", tree.id])
  assert.equal(recovery.status, "ready")
  assert.equal((await git(cwd, ["show", `${recovery.recoveryRef}:file.txt`])).toString(), "base\n")
  const clean = await run(["worktree", "create", "--apply", "--trust"])
  await run(["worktree", "remove", clean.id, "--apply", "--trust"])
  const listener = Bun.spawn([binary, "peer", "listen", "--duration", "3"], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => listener.kill("SIGKILL"), 15000),
    reader = listener.stdout.getReader()
  try {
    let text = ""
    while (!text.includes("\n")) {
      const next = await reader.read()
      assert.ok(!next.done)
      text += Buffer.from(next.value!).toString()
      assert.ok(text.length < 65536)
    }
    const endpoint = JSON.parse(text.split("\n")[0]!)
    const ack = await run(["peer", "send", endpoint.endpoint, "root", "M7D_COMPILED_PEER_OK"])
    assert.equal(ack.ok, true)
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      text += Buffer.from(next.value).toString()
      assert.ok(text.length < 65536)
    }
    assert.equal(await listener.exited, 0, await new Response(listener.stderr).text())
    assert.ok(text.includes("M7D_COMPILED_PEER_OK"))
    assert.ok(text.includes("external capability holder"))
    assert.equal(await Bun.file(endpoint.endpoint).exists(), false)
  } finally {
    clearTimeout(timeout)
    reader.releaseLock()
    if (listener.exitCode === null) {
      listener.kill("SIGKILL")
      await listener.exited
    }
  }
  console.log(
    "Compiled orchestration smoke passed: worktree create/preview/apply/recovery/remove and separate authenticated peer processes",
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
