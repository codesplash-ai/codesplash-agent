/** Actual compiled first-party session inside startup confinement; local Responses fixture only. */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"

const binary = resolve(process.argv[2]!),
  root = realpathSync(mkdtempSync(join(tmpdir(), "m11-startup-"))),
  work = join(root, "work"),
  config = join(root, "config"),
  data = join(root, "data")
for (const dir of [work, config, data]) mkdirSync(dir)
let calls = 0
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = await request.json()
    let frames: unknown[]
    if (calls++ === 0)
      frames = [
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "startup-tool",
            name: "bash",
            arguments: JSON.stringify({ command: "printf startup-agent" }),
          },
        },
      ]
    else {
      assert.match(JSON.stringify(body.input), /startup-agent/)
      frames = [{ type: "response.output_text.delta", delta: "STARTUP_AGENT_PASS" }]
    }
    frames.push({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } })
    return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    })
  },
})
try {
  writeFileSync(
    join(config, "config.toml"),
    `[memory]\nenabled=false\n[providers.startup]\nprotocol="openai"\napi="responses"\nbaseUrl=${JSON.stringify(server.url.origin)}\nrequiresKey=false\n[[providers.startup.models]]\nid="startup-fixture"\ncontextWindow=32768\nmaxOutputTokens=512\n`,
  )
  const profile = join(root, "profile.json")
  writeFileSync(
    profile,
    JSON.stringify({ version: 1, workspace: work, configDirectory: config, dataDirectory: data }),
  )
  const result = await runProcess(
    [
      binary,
      "isolate",
      profile,
      "--",
      "run",
      "--model",
      "startup-fixture",
      "--trust",
      "--auto",
      "--allow",
      "bash(printf startup-agent)",
      "-p",
      "Execute the approved command",
    ],
    {
      cwd: work,
      env: process.env,
      signal: AbortSignal.timeout(60000),
      timeoutMs: 55000,
      maxBytes: 1024 * 1024,
    },
  )
  assert.equal(result.exitCode, 0, JSON.stringify(result))
  assert.match(result.stdout, /STARTUP_AGENT_PASS/)
  assert.equal(calls, 2)
  console.log(
    "M11_STARTUP_AGENT_PASS: confined compiled agent, local provider, session state, nested approved tool",
  )
} finally {
  server.stop(true)
  rmSync(root, { recursive: true, force: true })
}
