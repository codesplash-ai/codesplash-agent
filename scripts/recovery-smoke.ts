/** Exercise the compiled CLI against a local provider; no account or metered calls. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"

const argument = process.argv[2]
if (!argument) throw new Error("Usage: bun scripts/recovery-smoke.ts /path/to/codesplash")
const binary = resolve(argument),
  root = await mkdtemp(join(tmpdir(), "codesplash-recovery-smoke-")),
  cwd = join(root, "project"),
  config = join(root, "config"),
  data = join(root, "data")
const prompts: string[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { messages: Array<{ role: string; content: unknown }> }
    const prompt = JSON.stringify(body.messages.filter((message) => message.role === "user").at(-1)?.content)
    prompts.push(JSON.stringify(body.messages))
    const tool = prompt.includes("RECOVERY_SECOND") && body.messages.at(-1)?.role !== "tool"
    const delta = tool
      ? {
          tool_calls: [
            {
              index: 0,
              id: "recovery-write",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "work.txt", content: "agent change\n" }),
              },
            },
          ],
        }
      : { content: "RECOVERY_OK" }
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
try {
  await mkdir(cwd)
  await mkdir(config)
  await writeFile(join(cwd, "work.txt"), "pre-existing user changes\n")
  await writeFile(join(cwd, "unrelated.txt"), "keep this\n")
  await writeFile(
    join(config, "config.toml"),
    `schemaVersion = 1\n[providers.recovery-smoke]\nprotocol = "openai"\nbaseUrl = "http://127.0.0.1:${server.port}"\nrequiresKey = false\nkeyEnvVar = "RECOVERY_SMOKE_UNUSED"\n[[providers.recovery-smoke.models]]\nid = "recovery-smoke"\ncontextWindow = 100000\nmaxOutputTokens = 2048\n`,
  )
  const env = {
    ...process.env,
    CODESPLASH_AGENT_CONFIG_DIR: config,
    CODESPLASH_AGENT_DATA_DIR: data,
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    RECOVERY_SMOKE_UNUSED: "",
  }
  const run = async (args: string[], okay = true) => {
    const result = await runProcess([binary, ...args], {
      cwd,
      env,
      signal: new AbortController().signal,
      timeoutMs: 30000,
      maxBytes: 2 * 1024 * 1024,
    })
    assert.equal(result.exitCode === 0, okay, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`)
    return result.stdout
  }
  const session = async (...args: string[]) => JSON.parse(await run(["session", ...args, "--json"]))
  const turn = async (prompt: string, id?: string) =>
    run([
      "run",
      "--model",
      "recovery-smoke",
      "--trust",
      "--allow",
      "write_file",
      ...(id ? ["--resume", id] : []),
      "-p",
      prompt,
    ])
  await turn("RECOVERY_FIRST")
  const id = (await session("list")).sessions[0].localSessionId
  const first = (await session("tree", id)).data.head
  await turn("RECOVERY_SECOND", id)
  assert.equal(await readFile(join(cwd, "work.txt"), "utf8"), "agent change\n")
  const tree = (await session("tree", id)).data
  assert.ok(tree.nodes.length >= 3)
  const steps = (await session("checkpoints", id)).data.steps
  assert.equal(steps.length, 1)
  const checkpoint = steps[0].id
  const diff = (await session("checkpoint-diff", id, checkpoint)).data
  assert.equal(diff.rows[0].before.text, "pre-existing user changes\n")
  assert.equal(diff.rows[0].after.text, "agent change\n")
  await writeFile(join(cwd, "work.txt"), "new external change\n")
  const conflict = (await session("restore", id, checkpoint, "work.txt")).data
  assert.ok(conflict.rows[0].conflict)
  await run(
    ["session", "restore", id, checkpoint, "work.txt", "--apply", "--revision", conflict.revision],
    false,
  )
  assert.equal(await readFile(join(cwd, "work.txt"), "utf8"), "new external change\n")
  await writeFile(join(cwd, "work.txt"), "agent change\n")
  const restore = (await session("restore", id, checkpoint, "work.txt")).data
  await session("restore", id, checkpoint, "work.txt", "--apply", "--revision", restore.revision)
  assert.equal(await readFile(join(cwd, "work.txt"), "utf8"), "pre-existing user changes\n")
  assert.equal(await readFile(join(cwd, "unrelated.txt"), "utf8"), "keep this\n")
  const fork = (await session("fork", id, first, "--apply")).fork
  await turn("RECOVERY_FORK", fork.localSessionId)
  const forkPrompt = prompts.at(-1) as string
  assert.ok(forkPrompt.includes("RECOVERY_FIRST"))
  assert.ok(!forkPrompt.includes("RECOVERY_SECOND"))
  const preview = (await session("rewind", id, first)).data
  await session("rewind", id, first, "--apply", "--revision", preview.revision)
  await turn("RECOVERY_ALTERNATE", id)
  assert.ok(!prompts.at(-1)?.includes("RECOVERY_SECOND"))
  const retained = (await session("tree", id)).data
  assert.ok(retained.nodes.some((node: { id: string }) => node.id === tree.head))
  assert.equal(retained.nodes.at(-1).parent, first)
  process.stdout.write(
    "Compiled recovery smoke passed: branches, independent fork/resume, rewind, private checkpoints, diff, restore and external-edit conflict\n",
  )
} finally {
  server.stop(true)
  await rm(root, { recursive: true, force: true })
}
