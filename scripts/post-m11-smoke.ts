import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const binary = resolve(process.argv[2] ?? "out/codesplash"),
  root = await realpath(await mkdtemp(join(tmpdir(), "post-m11-smoke-")))
let peer: ReturnType<typeof Bun.spawn> | undefined
let requests = 0,
  sawFile = false
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === "/v1/models")
      return Response.json({ data: [{ id: "fixture-model" }] })
    const body = (await request.json()) as { messages: unknown[] }
    requests++
    sawFile = JSON.stringify(body).includes("EXPLICIT_FILE_CANARY")
    if (JSON.stringify(body).includes("Draft a coding-agent definition"))
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ description: "Review code", prompt: "Inspect changes and cite evidence." }) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    return new Response(
      'data: {"choices":[{"delta":{"content":"POST_M11_ANSWER"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
async function run(args: string[], input?: string) {
  const p = Bun.spawn([binary, ...args], {
    cwd: root,
    env: {
      ...process.env,
      CODESPLASH_AGENT_CONFIG_DIR: join(root, "config"),
      CODESPLASH_AGENT_DATA_DIR: join(root, "data"),
      CODESPLASH_INSTALL_INTEGRATION: "0",
      CODESPLASH_OFFLINE: "0",
    },
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => p.kill(), 45000)
  const [code, out, err] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  clearTimeout(timer)
  assert.equal(code, 0, err)
  return out
}
try {
  await mkdir(join(root, "config"))
  await writeFile(join(root, "file with spaces.txt"), "EXPLICIT_FILE_CANARY\n")
  await writeFile(
    join(root, "config", "config.toml"),
    `[memory]\nenabled=false\n[codesplash]\nincrementalTools=true\npartialFallback=true\nstripImagesOn413=true\ndetectStreamLoops=true\nretryEmptyResponse=true\n[providers.local]\nprotocol="openai"\nbaseUrl="${server.url.origin}"\nrequiresKey=false\n[[providers.local.models]]\nid="fixture-model"\npromptFamily="qwen"\n`,
  )
  assert.match(await run(["--help"]), /projection/)
  assert.match(await run(["models", "discover-compatible", server.url.origin]), /fixture-model/)
  assert.match(
    await run([
      "run",
      root,
      "--no-history",
      "--model",
      "fixture-model",
      "-p",
      "Read the explicit attachment",
      "--file",
      join(root, "file with spaces.txt"),
    ]),
    /POST_M11_ANSWER/,
  )
  assert.equal(requests, 1)
  assert.ok(sawFile)
  assert.match(
    await run([
      "agents",
      "generate",
      "reviewer",
      "Review local changes",
      "--model",
      "fixture-model",
      "--write",
    ]),
    /Created disabled draft/,
  )
  assert.match(await Bun.file(join(root, ".codesplash/agents/reviewer.md")).text(), /enabled: false/)
  assert.equal(requests, 2)
  const service = JSON.parse(
    await run(["scheduler", "service", "install", "--executable", binary, "--model", "fixture-model"]),
  )
  assert.ok(service.preview.content.includes("scheduler"))
  const { git } = await import("../src/core/orchestration/git.ts")
  await git(root, ["init", "-q"])
  await git(root, ["add", "file with spaces.txt"])
  await git(root, ["commit", "-qm", "fixture"])
  const prepared = JSON.parse(await run(["worktree", "pool-fill", "1", "--apply", "--trust"]))
  const assigned = JSON.parse(await run(["worktree", "pool-take", "--apply", "--trust"]))
  assert.equal(assigned.id, prepared[0].id)
  assert.equal(assigned.pooled, undefined)
  const socket = join(root, "relay.sock")
  peer = Bun.spawn(
    [
      "node",
      "-e",
      `const net=require("node:net"); net.createServer({allowHalfOpen:true},s=>{let data="";s.on("error",()=>{});s.on("data",d=>data+=d);s.on("end",()=>s.end("echo:"+data))}).listen(process.argv[1],()=>process.stdout.write("ready"));`,
      socket,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const ready = (peer.stdout as ReadableStream<Uint8Array>).getReader()
  await ready.read()
  ready.releaseLock()
  await chmod(socket, 0o600)
  assert.equal(
    await run(["relay", "--socket", socket, "--timeout-ms", "5000"], "RELAY_CANARY"),
    "echo:RELAY_CANARY",
  )
  console.log(
    "POST_M11_SMOKE_OK: compiled drafts, worktree pool, scheduler service preview, Unix relay; compiled launch attachments, compatible discovery, family and recovery config",
  )
} finally {
  peer?.kill()
  if (peer) await peer.exited
  await server.stop(true)
  await rm(root, { recursive: true, force: true })
}
