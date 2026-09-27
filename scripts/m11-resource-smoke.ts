/** Explicit Linux cgroup-v2 host gate; not skipped or replaced by an unconfined fallback. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"

if (process.platform !== "linux") throw new Error("Requires Linux cgroup v2 with user systemd")
const binary = resolve(process.argv[2]!),
  root = await realpath(await mkdtemp(join(tmpdir(), "m11-resources-"))),
  cwd = join(root, "project"),
  config = join(root, "config")
try {
  await mkdir(cwd)
  await mkdir(config)
  await writeFile(join(config, "config.toml"), "[sandbox.limits]\nmemoryMiB=128\nprocesses=32\n")
  const env = {
    ...process.env,
    CODESPLASH_AGENT_CONFIG_DIR: config,
    CODESPLASH_AGENT_DATA_DIR: join(root, "data"),
  }
  const run = (script: string) =>
    runProcess([binary, "sandbox", "--no-history", "--", "python3", "-c", script], {
      cwd,
      env,
      signal: AbortSignal.timeout(30000),
      timeoutMs: 25000,
    })
  const memory = await run(
    "import sys\nprint('ALLOCATING', flush=True)\na=[]\nfor i in range(512): a.append(bytearray(1024*1024))\nprint('LIMIT_FAILED')",
  )
  assert.match(memory.stdout, /ALLOCATING/, JSON.stringify(memory))
  assert.doesNotMatch(memory.stdout, /LIMIT_FAILED/)
  assert.equal(memory.exitCode, 137, JSON.stringify(memory))
  const pids = await run(
    "import os,time,signal\nkids=[]\ntry:\n for i in range(64):\n  try: pid=os.fork()\n  except BlockingIOError:\n   print('PIDS_LIMIT_OK', flush=True)\n   break\n  if pid == 0:\n   time.sleep(20)\n   os._exit(0)\n  kids.append(pid)\n else: raise RuntimeError('process limit not enforced')\nfinally:\n for pid in kids: os.kill(pid, signal.SIGKILL)\n for pid in kids: os.waitpid(pid, 0)",
  )
  assert.equal(pids.exitCode, 0, JSON.stringify(pids))
  assert.match(pids.stdout, /PIDS_LIMIT_OK/)
  const alive = Bun.spawnSync(
    ["systemctl", "--user", "list-units", "--state=active", "--no-legend", "codesplash-*.scope"],
    { env },
  )
  assert.equal(alive.exitCode, 0, alive.stderr.toString())
  assert.equal(alive.stdout.toString().trim(), "", "No active owned cgroup may survive")
  console.log("M11_RESOURCES_OK: native sandbox memory OOM, process ceiling, collected scopes")
} finally {
  await rm(root, { recursive: true, force: true })
}
