/** Compiled durable queue/history/stash and killed-writer recovery, using only a local provider. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"

const argument = process.argv[2]
if (!argument) throw new Error("Usage: bun scripts/queue-smoke.ts /path/to/codesplash")
const binary = resolve(argument),
  root = await mkdtemp(join(tmpdir(), "codesplash-queue-smoke-"))
const cwd = join(root, "project"),
  config = join(root, "config"),
  data = join(root, "data")
let crashSeen = false
const prompts: string[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { messages: Array<{ role: string; content: unknown }> }
    const prompt = JSON.stringify(body.messages.filter((message) => message.role === "user").at(-1)?.content)
    prompts.push(prompt)
    if (prompt.includes("QUEUE_CRASH")) {
      crashSeen = true
      return new Response(
        new ReadableStream({
          start(controller) {
            request.signal.addEventListener(
              "abort",
              () => {
                try {
                  controller.close()
                } catch {}
              },
              { once: true },
            )
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "QUEUE_OK" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
let crashed: ReturnType<typeof Bun.spawn> | undefined
try {
  await mkdir(cwd)
  await mkdir(config)
  await writeFile(
    join(config, "config.toml"),
    `schemaVersion = 1\n[providers.queue-smoke]\nprotocol = "openai"\nbaseUrl = "http://127.0.0.1:${server.port}"\nrequiresKey = false\nkeyEnvVar = "QUEUE_SMOKE_UNUSED"\n[[providers.queue-smoke.models]]\nid = "queue-smoke"\ncontextWindow = 100000\nmaxOutputTokens = 2048\n`,
  )
  const env = {
    ...process.env,
    CODESPLASH_AGENT_CONFIG_DIR: config,
    CODESPLASH_AGENT_DATA_DIR: data,
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    QUEUE_SMOKE_UNUSED: "",
  }
  const run = async (args: string[], okay = true) => {
    const result = await runProcess([binary, ...args], {
      cwd,
      env,
      signal: new AbortController().signal,
      timeoutMs: 30000,
      maxBytes: 1024 * 1024,
    })
    assert.equal(result.exitCode === 0, okay, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`)
    return result.stdout
  }
  const session = async (...args: string[]) => JSON.parse(await run(["session", ...args, "--json"]))
  await run(["run", "--model", "queue-smoke", "--trust", "-p", "QUEUE_FIRST"])
  const id = (await session("list")).sessions[0].localSessionId
  assert.equal((await session("history", id)).prompts[0].input.text, "QUEUE_FIRST")
  await session("queue", id, "add", "follow-up", "DO_NOT_AUTORUN", "--apply")
  const item = (await session("queue", id)).items.at(-1)
  await session("queue", id, "edit", item.id, "STILL_DO_NOT_AUTORUN", "--apply")
  await session("stash", id, "save", "draft", "saved draft", "--apply")
  await run(["session", "stash", id, "save", "draft", "collision", "--apply"], false)
  assert.equal((await session("stash", id, "apply", "draft")).draft.input.text, "saved draft")
  assert.equal((await session("stash", id, "pop", "draft", "--apply")).draft.input.text, "saved draft")
  assert.equal((await session("stash", id)).length, 0)
  crashed = Bun.spawn(
    [binary, "run", "--model", "queue-smoke", "--trust", "--resume", id, "-p", "QUEUE_CRASH"],
    { cwd, env, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  )
  const deadline = Date.now() + 30000
  while (!crashSeen && Date.now() < deadline) await Bun.sleep(10)
  assert.ok(crashSeen, "killed-writer fixture must reach provider admission")
  crashed.kill("SIGKILL")
  await crashed.exited
  crashed = undefined
  await run(["run", "--model", "queue-smoke", "--trust", "--resume", id, "-p", "QUEUE_RECOVER"])
  const recovered = await session("queue", id)
  assert.equal(
    recovered.items.find((item: { input: { text: string } }) => item.input.text === "QUEUE_CRASH").status,
    "execution-uncertain",
  )
  assert.equal(recovered.items.find((row: { id: string }) => row.id === item.id).status, "blocked")
  assert.ok(prompts.every((prompt) => !prompt.includes("DO_NOT_AUTORUN")))
  assert.equal(prompts.filter((prompt) => prompt.includes("QUEUE_CRASH")).length, 1)
  const before = (await session("list", "--all")).total
  await run(["run", "--model", "queue-smoke", "--trust", "--no-history", "-p", "QUEUE_EPHEMERAL"])
  assert.equal((await session("list", "--all")).total, before)
  assert.ok(
    !(await session("history", id)).prompts.some((row: { input: { text: string } }) =>
      row.input.text.includes("QUEUE_EPHEMERAL"),
    ),
  )
  await session("history", id, "clear", "--apply")
  assert.equal((await session("history", id)).prompts.length, 0)
  process.stdout.write("Compiled input queue/history/stash/killed-writer/no-history smoke passed\n")
} finally {
  if (crashed) {
    crashed.kill("SIGKILL")
    await crashed.exited
  }
  server.stop(true)
  await rm(root, { recursive: true, force: true })
}
