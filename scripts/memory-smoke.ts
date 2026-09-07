/** Compiled durable-memory acceptance; all provider traffic stays in this local fixture. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"

const arg = process.argv[2]
if (!arg) throw new Error("Usage: bun scripts/memory-smoke.ts /path/to/codesplash")
const binary = resolve(arg),
  parent = await mkdtemp(join(tmpdir(), "codesplash-memory-smoke-")),
  cwd = join(parent, "project"),
  config = join(parent, "config"),
  data = join(parent, "data")
const requests: Array<{ messages: Array<{ role: string; content: string }>; tools?: unknown[] }> = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as (typeof requests)[number]
    requests.push(body)
    const extracting = body.messages.some((m) => m.role === "system" && m.content.includes("Extract durable"))
    let content = "MEMORY_SMOKE_OK"
    if (extracting) {
      assert.equal(body.tools?.length ?? 0, 0)
      const evidence = JSON.parse(body.messages.find((m) => m.role === "user")?.content ?? "[]") as Array<{
        id: string
      }>
      content = JSON.stringify({
        facts: [{ text: "Learned parser transactions are atomic", sourceIds: [evidence[0]?.id] }],
      })
    }
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
try {
  await mkdir(cwd)
  await mkdir(config)
  await writeFile(
    join(config, "config.toml"),
    `schemaVersion = 1\n[providers.memory-smoke]\nprotocol = "openai"\nbaseUrl = "http://127.0.0.1:${server.port}"\nrequiresKey = false\nkeyEnvVar = "MEMORY_SMOKE_UNUSED"\n[[providers.memory-smoke.models]]\nid = "memory-smoke"\ncontextWindow = 100000\nmaxOutputTokens = 2048\n`,
  )
  const env = {
    ...process.env,
    CODESPLASH_AGENT_CONFIG_DIR: config,
    CODESPLASH_AGENT_DATA_DIR: data,
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    MEMORY_SMOKE_UNUSED: "",
  }
  const run = async (args: string[], expected = 0) => {
    const result = await runProcess([binary, ...args], {
      cwd,
      env,
      signal: new AbortController().signal,
      timeoutMs: 30000,
      maxBytes: 1024 * 1024,
    })
    assert.equal(result.exitCode, expected, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`)
    return result.stdout
  }
  const memory = (...args: string[]) => run(["memory", ...args])
  const saved = await memory("remember", "--trust", "Parser uses MEMORY_FIRST_CANARY")
  const id = saved.trim().split(" ").at(-1) ?? "missing-id"
  assert.match(id, /^[0-9a-f-]{36}$/)
  assert.match(await memory("search", "parser"), /MEMORY_FIRST_CANARY/)
  await run(["run", "--model", "memory-smoke", "--trust", "-p", "Explain parser transactions"])
  assert.ok(JSON.stringify(requests.at(-1)?.messages).includes("MEMORY_FIRST_CANARY"))
  await memory("edit", id, "Parser uses MEMORY_EDITED_CANARY")
  assert.ok(!(await memory("search", "parser")).includes("MEMORY_FIRST_CANARY"))
  assert.match(await memory("show", id), /MEMORY_EDITED_CANARY/)
  const extracted = await memory("extract", "--model", "memory-smoke")
  assert.match(extracted, /1 memory candidates saved/)
  assert.match(extracted, /Memory usage:/)
  assert.match(await memory("extract", "--model", "memory-smoke"), /already processed/)
  assert.match(await memory("consolidate", "--model", "memory-smoke"), /memory candidates saved/)
  const listed = await memory("list")
  const candidate = listed
    .split("\n")
    .find((line) => line.includes("[candidate/"))
    ?.split(" ")[0]
  assert.ok(candidate)
  await memory("accept", candidate)
  assert.match(await memory("show", candidate), /generated\/reviewed/)
  await memory("forget", id)
  await memory("repair")
  assert.ok(!(await memory("search", "parser")).includes("MEMORY_EDITED_CANARY"))
  const registry = JSON.parse(await readFile(join(data, "memory", "repositories.json"), "utf8")) as Record<
    string,
    { id: string }
  >
  const repo = Object.values(registry)[0]?.id
  assert.ok(repo)
  const db = join(data, "memory", repo, "index.sqlite")
  await writeFile(db, "CORRUPT_INDEX")
  assert.match(await memory("search", "parser", "--read-only"), /fallback/)
  assert.equal(await readFile(db, "utf8"), "CORRUPT_INDEX")
  await memory("repair")
  // A configured but unavailable embedding credential falls back without any endpoint traffic.
  const before = requests.length
  assert.match(
    await run([
      "memory",
      "search",
      "parser",
      "-c",
      'memory.embedding.url="https://embedding.invalid/v1/embeddings"',
      "-c",
      'memory.embedding.model="fixture"',
      "-c",
      'memory.embedding.keyEnvVar="MEMORY_SMOKE_UNUSED"',
      "-c",
      "memory.embedding.dimensions=2",
    ]),
    /fallback/,
  )
  assert.equal(requests.length, before)
  await run(["run", "--model", "memory-smoke", "--trust", "--no-history", "-p", "Explain parser"])
  assert.ok(!JSON.stringify(requests.at(-1)?.messages).includes("Learned parser transactions"))
  assert.match(await memory("status", "--no-history"), /disabled/)
  const separate = join(parent, "nohistory")
  await mkdir(separate)
  await run(["memory", "remember", "--path", separate, "--trust", "--no-history", "NEVER_SAVE"], 1)
  assert.equal(
    Object.keys(JSON.parse(await readFile(join(data, "memory", "repositories.json"), "utf8"))).length,
    1,
  )
  for (const object of await readdir(join(data, "memory", repo, "objects")))
    assert.ok(
      !(await readFile(join(data, "memory", repo, "objects", object), "utf8")).includes(
        "MEMORY_EDITED_CANARY",
      ),
    )
  process.stdout.write(
    "Compiled memory smoke: cross-session recall, edit/delete/rebuild, extraction/consolidation, fallback and no-history passed\n",
  )
} finally {
  server.stop(true)
  await rm(parent, { recursive: true, force: true })
}
