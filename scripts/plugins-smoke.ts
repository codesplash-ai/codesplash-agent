import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"

const binary = resolve(process.argv[2] ?? "out/codesplash"),
  root = await realpath(await mkdtemp(join(tmpdir(), "plugins-smoke-")))
try {
  const source = join(root, "source"),
    cfg = join(root, "config"),
    data = join(root, "data")
  await mkdir(source)
  await mkdir(cfg)
  await writeFile(
    join(source, "codesplash-plugin.json"),
    JSON.stringify({ schemaVersion: 1, api: 1, id: "fixture", version: "1.0.0" }),
  )
  const env = { ...process.env, CODESPLASH_AGENT_CONFIG_DIR: cfg, CODESPLASH_AGENT_DATA_DIR: data }
  for (const args of [
    ["install", source],
    ["show", "fixture"],
    ["enable", "fixture"],
    ["disable", "fixture"],
    ["remove", "fixture"],
  ]) {
    const result = await runProcess(
      [...(binary.endsWith(".js") ? [process.execPath, binary] : [binary]), "plugin", ...args],
      { cwd: root, env, signal: AbortSignal.timeout(30000) },
    )
    assert.equal(result.exitCode, 0, result.stderr)
  }
  // A separate compiled native consumer exercises the live session method using the same sources.
  const probe = join(root, "plugin-reload")
  const build = await runProcess(
    [
      process.execPath,
      "build",
      "--compile",
      resolve("scripts/fixtures/plugin-reload.ts"),
      "--outfile",
      probe,
    ],
    { cwd: process.cwd(), env, signal: AbortSignal.timeout(60000) },
  )
  assert.equal(build.exitCode, 0, build.stderr)
  await cp(
    binary.endsWith(".js") ? resolve("out/sandbox-runtime") : join(dirname(binary), "sandbox-runtime"),
    join(root, "sandbox-runtime"),
    { recursive: true },
  )
  const result = await runProcess([probe], {
    cwd: root,
    env,
    signal: AbortSignal.timeout(45000),
    timeoutMs: 45000,
  })
  assert.equal(result.exitCode, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /Compiled plugin reload probe passed/)
  console.log(
    "Plugin smoke passed: compiled release management and separate compiled native install/trust/live reload/resource/close probe",
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
