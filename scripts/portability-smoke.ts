/** Compiled portability, foreign SQLite worker and directory publication; local scripted provider only. */

import { Database } from "bun:sqlite"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"

const argument = process.argv[2]
if (!argument) throw new Error("Usage: bun scripts/portability-smoke.ts /path/to/codesplash")
const binary = resolve(argument),
  root = await realpath(await mkdtemp(join(tmpdir(), "codesplash-portability-smoke-"))),
  cwd = join(root, "original"),
  destination = join(root, "destination"),
  config = join(root, "config"),
  data = join(root, "data"),
  foreign = join(root, "foreign")
const requests: string[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    requests.push(await request.text())
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "PORTABILITY_OK" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
try {
  for (const path of [cwd, destination, config, foreign]) await mkdir(path)
  await writeFile(
    join(config, "config.toml"),
    `schemaVersion = 1\n[providers.portability-smoke]\nprotocol = "openai"\nbaseUrl = "http://127.0.0.1:${server.port}"\nrequiresKey = false\nkeyEnvVar = "PORTABILITY_UNUSED"\n[[providers.portability-smoke.models]]\nid = "portability-smoke"\ncontextWindow = 100000\nmaxOutputTokens = 2048\n`,
  )
  const env = {
    ...process.env,
    CODESPLASH_AGENT_CONFIG_DIR: config,
    CODESPLASH_AGENT_DATA_DIR: data,
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
  }
  const run = async (args: string[], okay = true) => {
    const result = await runProcess([binary, ...args], {
      cwd,
      env,
      signal: new AbortController().signal,
      timeoutMs: 30000,
      maxBytes: 4 * 1024 * 1024,
      structured: true,
    })
    assert.equal(result.exitCode === 0, okay, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`)
    return result.stdout
  }
  const session = async (...args: string[]) => JSON.parse(await run(["session", ...args, "--json"]))
  await run(["run", "--model", "portability-smoke", "--trust", "-p", "ORIGINAL_HISTORY"])
  const id = (await session("list")).sessions[0].localSessionId
  const portable = join(root, "portable.json"),
    html = join(root, "portable.html")
  await run(["session", "export", id, "--output", portable, "--format", "json"])
  await run(["session", "export", id, "--output", html, "--format", "html", "--redact"])
  assert.ok((await readFile(html, "utf8")).includes("default-src 'none'"))
  await run(["session", "export", id, "--output", portable], false)
  const preview = await session("import", portable, "--path", destination)
  const imported = await session(
    "import",
    portable,
    "--path",
    destination,
    "--apply",
    "--sha256",
    preview.sha256,
  )
  assert.notEqual(imported.meta.localSessionId, id)
  assert.equal((await session("import", portable, "--path", destination, "--apply")).duplicate, true)
  const cd = await session("cd", id, destination)
  await session("cd", id, destination, "--clear", "--apply", "--revision", cd.revision)
  assert.equal((await session("pwd", id)).cwd, destination)
  await run(["run", "--resume", id, "--model", "portability-smoke", "-p", "NEW_DIRECTORY_HISTORY"])
  assert.ok(requests.at(-1)?.includes(destination))
  assert.ok(!requests.at(-1)?.includes("ORIGINAL_HISTORY"))
  const rollout = join(foreign, "rollout.jsonl")
  await writeFile(
    rollout,
    `${JSON.stringify({ type: "session_meta", payload: { id: "foreign-fixture", cwd } })}\n${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Foreign evidence" }] } })}\n`,
  )
  const db = new Database(join(foreign, "state.db"))
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE threads(id TEXT, cwd TEXT, rollout_path TEXT)")
    db.query("INSERT INTO threads VALUES (?, ?, ?)").run("foreign-fixture", cwd, rollout)
    const before = await Promise.all(
      ["", "-wal", "-shm"].map((suffix) => readFile(join(foreign, `state.db${suffix}`))),
    )
    const discovery = await session("foreign", "list", "codex", foreign)
    assert.equal(discovery.sessions.length, 1)
    assert.ok(discovery.databases.some((entry: { schema: string }) => entry.schema === "codex-threads-v1"))
    const after = await Promise.all(
      ["", "-wal", "-shm"].map((suffix) => readFile(join(foreign, `state.db${suffix}`))),
    )
    assert.deepEqual(after, before)
  } finally {
    db.close()
  }
  const sourceSettings = join(root, "settings.toml")
  await writeFile(sourceSettings, 'model = "portability-smoke"\n[history]\npersistence = "save-all"\n')
  await run(["import", "settings", "codex", sourceSettings, "--apply"])
  assert.ok((await readFile(join(config, "config.toml"), "utf8")).includes("[models]"))
  process.stdout.write(
    "Compiled portability smoke passed: export/import/no-clobber, cwd publication/resume, non-mutating foreign WAL worker and settings migration\n",
  )
} finally {
  server.stop(true)
  await rm(root, { recursive: true, force: true })
}
