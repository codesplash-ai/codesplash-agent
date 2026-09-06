/** Standalone native-engine context smoke. Local scripted provider only; no API credentials/quota. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"

const argument = process.argv[2]
if (!argument) throw new Error("Usage: bun scripts/context-smoke.ts /path/to/codesplash")
const binary = resolve(argument)
const parent = await mkdtemp(join(tmpdir(), "codesplash-context-smoke-"))
const cwd = join(parent, "project")
const config = join(parent, "config")
const data = join(parent, "data")
let normalRequests = 0
let summaries = 0
let resumedWithSummary = false
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { tools?: unknown[]; messages?: unknown[] }
    const summary = !body.tools?.length
    if (summary) summaries++
    else normalRequests++
    if (normalRequests > 33 && JSON.stringify(body.messages).includes("Generated summary"))
      resumedWithSummary = true
    const tool = !summary && normalRequests <= 32
    const delta = tool
      ? {
          tool_calls: [
            {
              index: 0,
              id: `read-${normalRequests}`,
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: `fixture-${normalRequests}.txt` }),
              },
            },
          ],
        }
      : {
          content: summary
            ? "The user requested an offline context test. Files were read successfully. Continue inspecting the remaining fixtures; do not run commands or publish."
            : "CONTEXT_SMOKE_OK",
        }
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
try {
  await mkdir(cwd)
  await mkdir(config)
  for (let i = 1; i <= 32; i++)
    await writeFile(join(cwd, `fixture-${i}.txt`), `Fixture ${i}\n${"bounded evidence\n".repeat(3000)}`)
  await writeFile(
    join(config, "config.toml"),
    `schemaVersion = 1\n[providers.context-smoke]\nprotocol = "openai"\nbaseUrl = "http://127.0.0.1:${server.port}"\nrequiresKey = false\nkeyEnvVar = "CONTEXT_SMOKE_UNUSED"\n[[providers.context-smoke.models]]\nid = "context-smoke"\ncontextWindow = 24000\nmaxOutputTokens = 1024\n`,
  )
  const environment = {
    ...process.env,
    CODESPLASH_AGENT_CONFIG_DIR: config,
    CODESPLASH_AGENT_DATA_DIR: data,
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    CONTEXT_SMOKE_UNUSED: "",
  }
  async function run(continuation: boolean) {
    const result = await runProcess(
      [
        binary,
        "run",
        "--model",
        "context-smoke",
        "--trust",
        "--output-format",
        "json",
        ...(continuation ? ["--continue"] : []),
        "-p",
        "Read the numbered fixtures for an offline context test; do not run commands or publish.",
      ],
      {
        cwd,
        env: environment,
        signal: AbortSignal.timeout(90_000),
        timeoutMs: 90_000,
      },
    )
    assert.equal(result.exitCode, 0, JSON.stringify(result))
    assert.match(result.stdout, /CONTEXT_SMOKE_OK/)
  }
  await run(false)
  assert.ok(summaries > 0, "Standalone engine must actually compact")
  const paths = await readdir(data, { recursive: true })
  const transcript = paths.find((path) => path.endsWith("/transcript.jsonl"))
  assert.ok(transcript, "Native transcript exists")
  assert.match(await readFile(join(data, transcript), "utf8"), /Generated summary/)
  assert.ok(
    paths.some((path) => path.includes("/tool-outputs/")),
    "Large outputs were retained",
  )
  await run(true)
  assert.ok(resumedWithSummary, "Resumed compiled engine sends the compacted context")
  process.stdout.write(
    `Standalone context smoke passed: ${summaries} summary requests, retained output, atomic snapshot, resume\n`,
  )
} finally {
  server.stop(true)
  await rm(parent, { recursive: true, force: true })
}
