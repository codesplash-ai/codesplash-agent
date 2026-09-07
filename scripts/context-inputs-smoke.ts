/** Compiled context-input acceptance with a local scripted provider; no API quota. */
import assert from "node:assert/strict"
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"

const argument = process.argv[2]
if (!argument) throw new Error("Usage: bun scripts/context-inputs-smoke.ts /path/to/codesplash")
const binary = resolve(argument)
const parent = await mkdtemp(join(tmpdir(), "codesplash-inputs-smoke-"))
const cwd = join(parent, "project"),
  config = join(parent, "config"),
  data = join(parent, "data")
const requests: Array<{ messages: unknown[]; tools: Array<{ function: { name: string } }> }> = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as (typeof requests)[number]
    requests.push(body)
    const tool = requests.length === 1
    const delta = tool
      ? {
          tool_calls: [
            {
              index: 0,
              id: "invoke-skill",
              type: "function",
              function: { name: "skill", arguments: JSON.stringify({ name: "verify" }) },
            },
          ],
        }
      : { content: "CONTEXT_INPUTS_OK" }
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
try {
  const files = {
    "project/AGENTS.md": "NATIVE_RULE_CANARY",
    "project/data.txt": "ATTACHED_DATA_CANARY",
    "project/.codesplash/commands/check.md": "Template $1\n@data.txt\n!`printf '%s' \"$1\"`",
    "project/.codesplash/skills/verify/SKILL.md":
      "---\nname: verify\ndescription: Verify the context smoke\n---\nSKILL_BODY_CANARY",
    "config/context/AGENTS.md": "USER_RULE_CANARY",
    "config/config.toml": `schemaVersion = 1\n[context]\npersonality = "concise"\n[providers.inputs-smoke]\nprotocol = "openai"\nbaseUrl = "http://127.0.0.1:${server.port}"\nrequiresKey = false\nkeyEnvVar = "INPUTS_SMOKE_UNUSED"\n[[providers.inputs-smoke.models]]\nid = "inputs-smoke"\ncontextWindow = 100000\nmaxOutputTokens = 1024\n`,
    "vendor/CLAUDE.md": "Imported rule",
    "destination/.keep": "",
  }
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(parent, path)), { recursive: true })
    await writeFile(join(parent, path), text)
  }
  const env = {
    ...process.env,
    CODESPLASH_AGENT_CONFIG_DIR: config,
    CODESPLASH_AGENT_DATA_DIR: data,
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    INPUTS_SMOKE_UNUSED: "",
  }
  async function run(args: string[], expected = 0) {
    const result = await runProcess([binary, ...args], {
      cwd,
      env,
      signal: new AbortController().signal,
      timeoutMs: 30000,
      maxBytes: 1024 * 1024,
    })
    assert.equal(result.exitCode, expected, `${result.stdout}\n${result.stderr}`)
    return result.stdout
  }
  const prompt = `/check '$(touch ARGUMENT_EXECUTED)'`
  assert.match(
    await run([
      "run",
      "--model",
      "inputs-smoke",
      "--trust",
      "--auto",
      "--allow",
      "bash",
      "--no-history",
      "-p",
      prompt,
    ]),
    /CONTEXT_INPUTS_OK/,
  )
  assert.equal(requests.length, 2)
  const first = JSON.stringify(requests[0]?.messages),
    second = JSON.stringify(requests[1]?.messages)
  for (const canary of [
    "NATIVE_RULE_CANARY",
    "USER_RULE_CANARY",
    "ATTACHED_DATA_CANARY",
    "Verify the context smoke",
  ])
    assert.ok(first.includes(canary), canary)
  assert.ok(!first.includes("SKILL_BODY_CANARY"), "Catalog does not inject bodies")
  assert.ok(second.includes("SKILL_BODY_CANARY"), "Invocation loads the body")
  assert.ok(
    requests[0]?.tools.every(
      (tool) => !tool.function.name.startsWith("context_") && tool.function.name !== "user_context_read",
    ),
    "Internal readers are hidden",
  )
  assert.equal(await lstat(join(cwd, "ARGUMENT_EXECUTED")).catch(() => undefined), undefined)
  assert.match(await run(["create-skill", "new-skill"]), /Preview/)
  assert.equal(await lstat(join(cwd, ".codesplash/skills/new-skill")).catch(() => undefined), undefined)
  assert.match(await run(["create-skill", "new-skill", "--write"]), /Created/)
  assert.match(
    await run(["import", "claude", join(parent, "vendor"), "--destination", join(parent, "destination")]),
    /Preview/,
  )
  assert.equal(await lstat(join(parent, "destination/AGENTS.md")).catch(() => undefined), undefined)
  assert.match(
    await run([
      "import",
      "claude",
      join(parent, "vendor"),
      "--destination",
      join(parent, "destination"),
      "--apply",
    ]),
    /Imported resources/,
  )
  const before = requests.length
  await run(
    [
      "run",
      "--model",
      "inputs-smoke",
      "--trust",
      "--auto",
      "--deny",
      "read_file(data.txt)",
      "--no-history",
      "-p",
      "Read @data.txt",
    ],
    1,
  )
  assert.equal(requests.length, before, "Denied attachment makes no provider request")
  assert.equal(
    (await readdir(data, { recursive: true }).catch(() => [])).some((path) =>
      path.endsWith("transcript.jsonl"),
    ),
    false,
  )
  process.stdout.write(
    "Standalone context-input smoke passed: rules, user context, templates, literal shell arguments, file refs, progressive skills, deny, authoring/import previews, no-history\n",
  )
} finally {
  server.stop(true)
  await rm(parent, { recursive: true, force: true })
}
