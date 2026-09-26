/** Compiled M9 protocols and shared session ownership against an isolated local provider. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { attachSession, DaemonClient } from "../src/server/client.ts"
import { ndjson } from "../src/server/transport.ts"

const binary = resolve(process.argv[2] ?? "dist/cli.js"),
  argv = binary.endsWith(".js") ? [process.execPath, binary] : [binary]
const root = await realpath(await mkdtemp(join(tmpdir(), "m9-compiled-"))),
  cwd = join(root, "workspace"),
  config = join(root, "config"),
  extension = join(root, "extension"),
  daemonRoot = join(root, "daemon")
const env: NodeJS.ProcessEnv = {
  ...process.env,
  CODESPLASH_AGENT_CONFIG_DIR: config,
  CODESPLASH_AGENT_DATA_DIR: join(root, "data"),
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
}
for (const name of ["CODESPLASH_CONFIG", "CODESPLASH_PROFILE", "CODESPLASH_PERMISSION_MODE"]) delete env[name]
let daemon: ReturnType<typeof Bun.spawn> | undefined
const run = async (args: string[], input = "") => {
  const child = Bun.spawn([...argv, ...args], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  child.stdin.write(input)
  child.stdin.end()
  const timer = setTimeout(() => child.kill("SIGKILL"), 45000)
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    assert.equal(exit, 0, stderr + stdout)
    return stdout
  } finally {
    clearTimeout(timer)
  }
}
try {
  for (const path of [cwd, config, extension]) await mkdir(path)
  await writeFile(
    join(extension, "entry.ts"),
    `export default api => api.registerProvider({name:'local',displayName:'M9 fixture',protocol:'openai',models:[{id:'model',displayName:'Local',contextWindow:32768,maxOutputTokens:100,isDefault:true,supportsReasoning:false}],async *stream(){yield {type:'text_delta',text:'{"ok":true}'};yield {type:'usage',usage:{inputTokens:4,outputTokens:2}};yield {type:'done',stopReason:'end_turn'}}})`,
  )
  await writeFile(
    join(config, "config.toml"),
    `[memory]\nenabled=false\n[extensions.entries.fixture]\nroot=${JSON.stringify(extension)}\nentry="entry.ts"\nenabled=true\n`,
  )
  const review = JSON.parse(await run(["extensions", "show", "fixture"]))
  await run(["extensions", "trust", "fixture", "--fingerprint", review.fingerprint])
  await run(["generate", join(root, "generated")])
  assert.match(await readFile(join(root, "generated", "protocol.ts"), "utf8"), /MethodParams/)
  await run(["ide", "package", join(root, "codesplash.vsix")])
  assert.equal((await readFile(join(root, "codesplash.vsix"))).readUInt32LE(0), 0x04034b50)
  const output = JSON.parse(
    await run(
      [
        "run",
        "--model",
        "ext_fixture_local/model",
        "--trust",
        "--no-history",
        "--tools",
        "read_file",
        "--input-format",
        "stream-json",
        "--output-format",
        "json",
        "--output-schema",
        '{"type":"object","required":["ok"]}',
        "--output-last-message",
        join(root, "answer.json"),
      ],
      '{"type":"user","text":"one"}\n{"type":"user","text":"two"}\n',
    ),
  )
  assert.equal(output.turns, 2)
  assert.equal(await readFile(join(root, "answer.json"), "utf8"), '{"ok":true}')
  for (const dialect of ["serve", "acp", "mcp-server"]) {
    const child = Bun.spawn(
      [
        ...argv,
        dialect,
        ...(dialect === "serve" ? ["--stdio"] : []),
        "--root",
        join(root, dialect),
        "--cwd",
        cwd,
      ],
      { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    )
    const pending = new Map<number, (v: any) => void>()
    let id = 0
    const reader = (async () => {
      for await (const value of ndjson(
        (async function* () {
          const reader = child.stdout.getReader()
          try {
            while (true) {
              const next = await reader.read()
              if (next.done) return
              yield next.value
            }
          } finally {
            reader.releaseLock()
          }
        })(),
      )) {
        const message = value as any
        if (pending.has(message.id)) {
          pending.get(message.id)!(message)
          pending.delete(message.id)
        }
      }
    })()
    const call = (method: string, params: unknown) =>
      new Promise<any>((done, reject) => {
        const key = ++id,
          timer = setTimeout(() => {
            child.kill()
            reject(Error("Protocol timed out"))
          }, 15000)
        pending.set(key, (v) => {
          clearTimeout(timer)
          v.error ? reject(Error(JSON.stringify(v.error))) : done(v.result)
        })
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: key, method, params }) + "\n")
      })
    try {
      const initialized = await call(
        "initialize",
        dialect === "serve"
          ? { version: 1, client: "compiled" }
          : dialect === "acp"
            ? { protocolVersion: 1 }
            : { protocolVersion: "2025-11-25", capabilities: {} },
      )
      assert.ok(initialized)
      if (dialect === "mcp-server") {
        child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
        assert.equal((await call("tools/list", {})).tools.length, 2)
      } else if (dialect === "acp") assert.ok((await call("session/new", { cwd, mcpServers: [] })).sessionId)
      else assert.deepEqual(await call("thread/list", {}), [])
    } finally {
      child.stdin.end()
      await child.exited
      await reader
    }
  }
  daemon = Bun.spawn(
    [...argv, "serve", "--root", daemonRoot, "--cwd", cwd, "--port", "0", "--share", "manual"],
    { cwd, env, stdout: "ignore", stderr: "pipe" },
  )
  let metadata: { url: string } | undefined
  for (let tries = 0; tries < 100; tries++) {
    try {
      metadata = JSON.parse(await readFile(join(daemonRoot, "daemon.json"), "utf8"))
      break
    } catch {
      await Bun.sleep(50)
    }
  }
  assert.ok(metadata, "Daemon did not start")
  const token = await readFile(join(daemonRoot, "token"), "utf8"),
    writer = new DaemonClient(metadata.url, token),
    observer = new DaemonClient(metadata.url, token)
  let attached: Awaited<ReturnType<typeof attachSession>> | undefined
  try {
    await writer.initialize(["sharing", "tui-control"])
    const { threadId, inputEpoch } = (await writer.rpc("thread/create", {
      cwd,
      model: "ext_fixture_local/model",
    })) as any
    const { lease } = (await writer.rpc("lease/acquire", { threadId, mode: "shared" })) as any
    attached = await attachSession(observer, threadId, "shared", false)
    const messages: string[] = []
    const stream = (async () => {
      for await (const e of attached!.events)
        if (e.kind === "message.completed") messages.push(e.payload.text ?? "")
    })()
    await writer.rpc("turn/start", {
      threadId,
      lease,
      text: "compiled",
      submissionId: `${inputEpoch}.compiled`,
    })
    for (let tries = 0; tries < 150 && !messages.length; tries++) await Bun.sleep(20)
    assert.deepEqual(messages, ['{"ok":true}'])
    const control = await fetch(new URL("tui/prompt", metadata.url), {
      method: "POST",
      headers: { ...writer.headers(), "content-type": "application/json" },
      body: JSON.stringify({ requestId: "control", threadId, lease, text: "draft only" }),
    })
    assert.equal(control.status, 200)
    const share = (await writer.rpc("share/create", { threadId, lease })) as any
    assert.equal((await fetch(share.url)).status, 200)
    await writer.rpc("share/revoke", { threadId, lease, shareId: share.shareId })
    assert.equal((await fetch(share.url)).status, 404)
    await attached.close()
    attached = undefined
    await stream
  } finally {
    await attached?.close()
    await observer.close()
    await writer.close()
  }
  console.log(
    "Compiled server smoke passed: schema/VSIX assets, two streamed schema-validated prompts, native/ACP/MCP stdio, authenticated HTTP, simultaneous attachment, TUI control, share/revoke",
  )
} finally {
  if (daemon) {
    daemon.kill("SIGTERM")
    await daemon.exited
  }
  await rm(root, { recursive: true, force: true })
}
