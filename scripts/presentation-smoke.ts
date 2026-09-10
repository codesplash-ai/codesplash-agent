/** Compiled local presentation and explicitly generated title using a scripted loopback provider. */

import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"

const argument = process.argv[2]
if (!argument) throw new Error("Usage: bun scripts/presentation-smoke.ts /path/to/codesplash")
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
  const info = await session("info", id)
  assert.equal(info.outcomeCache, "verified")
  assert.equal(info.policy.source, "recorded")
  const outcomes = await session("outcomes", id)
  assert.equal(outcomes.rows.length, 1)
  assert.equal(outcomes.rows[0].status, "completed")
  assert.ok(!JSON.stringify(outcomes).includes("ORIGINAL_HISTORY"))
  const before = requests.length
  assert.ok((await run(["session", "recap", id])).includes("completed"))
  await session("rename", id, "--auto")
  assert.equal(requests.length, before)
  await session("rename", id, "--generate")
  assert.equal(requests.length, before + 1)
  const generated = JSON.parse(requests.at(-1) as string)
  assert.ok(!generated.tools?.length)
  assert.ok((generated.max_tokens ?? generated.max_completion_tokens) <= 512)
  assert.ok((await session("info", id)).usage.cumulative.hasUnpricedUsage)
  await session("outcomes", id, "--repair", "--apply")
  assert.equal((await session("info", id)).outcomeCache, "verified")
  assert.equal((await session("outcomes", id)).rows.length, 1)
  console.log(
    "Compiled presentation smoke passed: local recap, typed cache, title generation, bounded no-tool request and unknown usage",
  )
} finally {
  server.stop(true)
  await rm(root, { recursive: true, force: true })
}
