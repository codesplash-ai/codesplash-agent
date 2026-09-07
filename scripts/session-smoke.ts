/** Exercises the compiled CLI against disposable history and a local, unmetered provider fixture. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"

const argument = process.argv[2]
if (!argument) throw new Error("Usage: bun scripts/session-smoke.ts /path/to/codesplash")
const binary = resolve(argument),
  root = await mkdtemp(join(tmpdir(), "codesplash-session-smoke-"))
const cwd = join(root, "project"),
  config = join(root, "config"),
  data = join(root, "data")
const requests: unknown[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    requests.push(await request.json())
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "SAPPHIRE_SESSION_OK" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
try {
  await mkdir(cwd)
  await mkdir(config)
  await writeFile(
    join(config, "config.toml"),
    `schemaVersion = 1\n[providers.session-smoke]\nprotocol = "openai"\nbaseUrl = "http://127.0.0.1:${server.port}"\nrequiresKey = false\nkeyEnvVar = "SESSION_SMOKE_UNUSED"\n[[providers.session-smoke.models]]\nid = "session-smoke"\ncontextWindow = 100000\nmaxOutputTokens = 2048\n`,
  )
  const env = {
    ...process.env,
    CODESPLASH_AGENT_CONFIG_DIR: config,
    CODESPLASH_AGENT_DATA_DIR: data,
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    SESSION_SMOKE_UNUSED: "",
  }
  const run = async (args: string[]) => {
    const result = await runProcess([binary, ...args], {
      cwd,
      env,
      signal: new AbortController().signal,
      timeoutMs: 30000,
      maxBytes: 1024 * 1024,
    })
    assert.equal(result.exitCode, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`)
    return result.stdout
  }
  const session = async (...args: string[]) => JSON.parse(await run(["session", ...args, "--json"]))
  const firstOutput = await run(["run", "--model", "session-smoke", "--trust", "-p", "Investigate sapphire"])
  assert.match(firstOutput, /SAPPHIRE_SESSION_OK/)
  const initial = await session("list"),
    id = initial.sessions[0].localSessionId
  assert.equal(initial.total, 1)
  assert.equal((await session("search", "sapphire")).total, 1)
  assert.equal((await session("reindex", "--apply")).sessions, 1)
  assert.equal((await session("search", "SAPPHIRE_SESSION_OK")).total, 1)
  await session("rename", id, "Sapphire investigation")
  await session("move", id, "Work", "Backlog", "2")
  assert.equal((await session("show", id)).meta.section, "Backlog")
  await session("archive", id)
  assert.equal((await session("list")).total, 0)
  assert.equal((await session("list", "--archived")).total, 1)
  assert.equal(JSON.parse(await run(["stats", "--json"]))[0].sessions, 1)
  await session("unarchive", id)
  assert.ok((await session("compress", id)).apply)
  assert.equal((await session("compress", id, "--apply")).files.length, 2)
  await run([
    "run",
    "--model",
    "session-smoke",
    "--trust",
    "--resume",
    id,
    "-p",
    "Continue the investigation",
  ])
  assert.ok(JSON.stringify(requests.at(-1)).includes("Investigate sapphire"))
  await session("reindex", "--apply")
  assert.equal((await session("search", "Continue the investigation")).total, 1)
  const project = (await readdir(join(data, "sessions"))).find((name) => !name.startsWith(".")) as string
  assert.ok(project)
  await session("delete", id, "--apply")
  assert.equal((await session("list", "--all")).total, 0)
  assert.equal((await session("reindex", "--apply")).sessions, 0)
  assert.equal(requests.length, 2)
  process.stdout.write("Compiled session storage/search/lifecycle/compression/resume smoke passed\n")
} finally {
  server.stop(true)
  await rm(root, { recursive: true, force: true })
}
