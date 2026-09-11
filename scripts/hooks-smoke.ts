/** Release fixture: reviewed sandbox command hooks through the actual native headless session. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"

if (!process.argv[2]) throw new Error("Usage: bun scripts/hooks-smoke.ts /path/to/codesplash")
const binary = resolve(process.argv[2]),
  root = await realpath(await mkdtemp(join(tmpdir(), "codesplash-hooks-smoke-")))
const cwd = join(root, "workspace"),
  config = join(root, "config"),
  script = join(cwd, "hook.sh")
let stage = 0
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { messages: Array<{ role: string; content: unknown }> }
    stage++
    if (stage === 1) assert.match(JSON.stringify(body.messages), /HOOK_REVISED_INPUT/)
    if (stage === 2) assert.match(JSON.stringify(body.messages), /MODEL_VIEW_ONLY/)
    if (stage === 3) assert.match(JSON.stringify(body.messages), /HOOK_CONTINUATION/)
    assert.ok(stage <= 3)
    const delta =
      stage === 1
        ? {
            tool_calls: [
              {
                index: 0,
                id: "write",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "original.txt", content: "original" }),
                },
              },
            ],
          }
        : { content: "HOOKS_SMOKE_OK" }
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: stage === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
try {
  await mkdir(cwd)
  await mkdir(config)
  await writeFile(
    script,
    `payload=$(/bin/cat)
case "$payload" in
  *'"name":"input.admit"'*) printf '%s' '{"version":1,"text":"HOOK_REVISED_INPUT"}' ;;
  *'"name":"tool.before"'*) printf '%s' '{"version":1,"input":{"path":"rewritten.txt","content":"HOOK_WRITE_CONFIRMED"}}' ;;
  *'"name":"tool.after"'*) printf '%s' '{"version":1,"result":"MODEL_VIEW_ONLY"}' ;;
  *'"name":"turn.stop"'*) printf '%s' '{"version":1,"continuation":"HOOK_CONTINUATION"}' ;;
  *) printf '%s' '{"version":1}' ;;
esac
`,
  )
  await writeFile(
    join(config, "config.toml"),
    `schemaVersion=1
[providers.hook-fixture]
protocol="openai"
baseUrl="http://127.0.0.1:${provider.port}"
requiresKey=false
keyEnvVar="HOOK_SMOKE_UNUSED"
[[providers.hook-fixture.models]]
id="hook-fixture"
contextWindow=200000
maxOutputTokens=1000
[hooks.continuation]
maxCount=1
maxTokens=100000
[hooks.handlers.fixture]
kind="command"
command="/bin/sh"
args=[${JSON.stringify(script)}]
enabled=true
events=["session.start","input.admit","turn.start","tool.before","permission.request","tool.after","turn.stop","turn.end","session.end"]
share=["text","input"]
allowInputRewrite=true
allowTextRewrite=true
allowResultRewrite=true
allowContinuation=true
timeoutMs=5000
`,
  )
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODESPLASH_AGENT_CONFIG_DIR: config,
    CODESPLASH_AGENT_DATA_DIR: join(root, "data"),
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
  }
  for (const key of ["CODESPLASH_CONFIG", "CODESPLASH_PROFILE", "CODESPLASH_PERMISSION_MODE"]) delete env[key]
  const run = async (args: string[], okay = true) => {
    const result = await runProcess(
      [...(binary.endsWith(".js") ? [process.execPath, binary] : [binary]), ...args],
      {
        cwd,
        env,
        signal: AbortSignal.timeout(45000),
        timeoutMs: 45000,
        maxBytes: 2 * 1024 * 1024,
        structured: true,
      },
    )
    assert.equal(result.exitCode === 0, okay, `${result.stdout}\n${result.stderr}`)
    return result.stdout
  }
  const review = JSON.parse(await run(["hooks", "show", "fixture"]))
  assert.equal(review.trusted, false)
  await run(["hooks", "trust", "fixture", "--fingerprint", review.fingerprint])
  const output = await run([
    "run",
    "--model",
    "hook-fixture",
    "--trust",
    "--auto",
    "--allow",
    "write_file",
    "--no-history",
    "--output-format",
    "stream-json",
    "-p",
    "original input",
  ])
  assert.equal(stage, 3)
  assert.equal(await readFile(join(cwd, "rewritten.txt"), "utf8"), "HOOK_WRITE_CONFIRMED")
  assert.equal(await Bun.file(join(cwd, "original.txt")).exists(), false)
  assert.match(output, /HOOKS_SMOKE_OK/)
  assert.match(output, /session\.end/)
  assert.match(output, /tool\.before/)
  assert.doesNotMatch(output, /MODEL_VIEW_ONLY/)
  await writeFile(script, "exit 2\n")
  assert.equal(JSON.parse(await run(["hooks", "show", "fixture"])).trusted, false)
  await run(
    ["run", "--model", "hook-fixture", "--trust", "--no-history", "-p", "Must refuse changed hook"],
    false,
  )
  assert.equal(stage, 3)
  console.log(
    "Compiled hook smoke passed: explicit trust, sandboxed JSON stdin, input/tool rewrites, recorded effect, model-result processing, bounded continuation, close events and changed-source refusal",
  )
} finally {
  await provider.stop(true)
  await rm(root, { recursive: true, force: true })
}
