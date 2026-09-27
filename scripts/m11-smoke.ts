/** Compiled distribution gate. Local fixtures only; no external provider credentials. */
import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { signDocument } from "../src/core/distribution/signed.ts"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"

const binary = resolve(process.argv[2]!),
  root = await realpath(await mkdtemp(join(tmpdir(), "m11-compiled-"))),
  cwd = join(root, "project"),
  config = join(root, "config"),
  data = join(root, "data"),
  key = generateKeyPairSync("ed25519")
let calls = 0
const fleet = (disabled: boolean) =>
  JSON.stringify({
    version: 1,
    keys: { fixture: key.publicKey.export({ type: "spki", format: "pem" }).toString() },
    document: signDocument(
      {
        version: 1,
        kind: "fleet",
        revision: disabled ? 2 : 1,
        issuedAt: Date.now() - 1000,
        expiresAt: Date.now() + 3600000,
        settings: { disableFeatures: disabled ? ["clock"] : [] },
      },
      "fixture",
      key.privateKey,
    ),
  })
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body = await req.json()
    let frames: unknown[]
    if (calls++ === 0) {
      assert.match(JSON.stringify(body.tools), /clock/)
      // Revoke a tool after advertisement but before the live session dispatches it.
      await writeFile(join(config, "fleet.json"), fleet(true))
      frames = [
        {
          type: "response.output_item.done",
          item: { type: "function_call", call_id: "clock-1", name: "clock", arguments: "{}" },
        },
      ]
    } else {
      assert.match(
        JSON.stringify(body.input),
        /not (?:enabled|available)|disabled|Unknown tool|not allowed|not permitted/i,
      )
      frames = [{ type: "response.output_text.delta", delta: "M11_LIVE_KILL_OK" }]
    }
    frames.push({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } })
    return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    })
  },
})
try {
  await mkdir(cwd)
  await mkdir(config)
  await writeFile(join(config, "fleet.json"), fleet(false))
  await writeFile(
    join(config, "config.toml"),
    `[memory]\nenabled=false\n[providers.m11]\nprotocol="openai"\napi="responses"\nbaseUrl=${JSON.stringify(server.url.origin)}\nrequiresKey=false\nkeyEnvVar="M11_UNUSED"\n[[providers.m11.models]]\nid="m11-fixture"\ncontextWindow=32768\nmaxOutputTokens=512\n`,
  )
  const env = {
    ...process.env,
    CODESPLASH_AGENT_CONFIG_DIR: config,
    CODESPLASH_AGENT_DATA_DIR: data,
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    CODESPLASH_OTLP_ENABLED: "0",
    CODESPLASH_ANALYTICS_ENABLED: "0",
  }
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}, exe = binary) =>
    runProcess([exe, ...args], {
      cwd,
      env: { ...env, ...extra },
      signal: AbortSignal.timeout(60000),
      timeoutMs: 55000,
      maxBytes: 1024 * 1024,
    })
  const ok = async (args: string[], extra: NodeJS.ProcessEnv = {}, exe = binary) => {
    const result = await run(args, extra, exe)
    assert.equal(result.exitCode, 0, JSON.stringify(result))
    return result.stdout
  }
  const build = JSON.parse(await ok(["--harden", "--build-info"]))
  assert.equal(build.hardening.coreDumps, false)
  await ok(["features", "set", "clock", "on", "--apply"])
  assert.match(
    await ok(["run", "--model", "m11-fixture", "--trust", "--auto", "-p", "Read the clock"]),
    /M11_LIVE_KILL_OK/,
  )
  assert.equal(calls, 2)
  assert.deepEqual(JSON.parse(await ok(["features", "list"])).enabled, [])
  await mkdir(join(cwd, "secret"))
  await mkdir(join(cwd, "protected"))
  await writeFile(join(cwd, "secret", "value"), "DO_NOT_READ_M11")
  const deniedRead = await run([
    "sandbox",
    "--no-history",
    "--deny-read",
    join(cwd, "secret", "*.key"),
    "--",
    "/bin/cat",
    "secret/value",
  ])
  assert.notEqual(deniedRead.exitCode, 0, JSON.stringify(deniedRead))
  assert.doesNotMatch(deniedRead.stdout, /DO_NOT_READ_M11/)
  const deniedWrite = await run([
    "sandbox",
    "--no-history",
    "--deny-write",
    join(cwd, "protected", "*.key"),
    "--",
    "/bin/sh",
    "-c",
    "echo forbidden > protected/future.key",
  ])
  assert.notEqual(deniedWrite.exitCode, 0, JSON.stringify(deniedWrite))
  assert.equal(await Bun.file(join(cwd, "protected", "future.key")).exists(), false)
  const offline = await run([
    "--offline",
    "sandbox",
    "--no-history",
    "--allow-host",
    "example.com:443",
    "--",
    "curl",
    "--fail",
    "--max-time",
    "5",
    "https://example.com",
  ])
  assert.notEqual(offline.exitCode, 0, JSON.stringify(offline))
  const alias = join(root, `${build.command}-sandbox`)
  await symlink(binary, alias)
  // Runtime assets resolve beside the executable's physical path, including aliases.
  await ok(["--no-history", "--", "/bin/sh", "-c", "printf alias-ok > alias-result"], {}, alias)
  assert.equal(await readFile(join(cwd, "alias-result"), "utf8"), "alias-ok")
  for (const clipboard of [false, true]) {
    let output = ""
    const child = Bun.spawn(
      [
        binary,
        "wrap",
        ...(clipboard ? ["--clipboard"] : []),
        "--",
        "/bin/sh",
        "-c",
        "printf 'WRAP_START\\033]52;c;aGk=\\007WRAP_END'",
      ],
      {
        cwd,
        env: { ...env, TMUX: "" },
        terminal: {
          cols: 80,
          rows: 24,
          data: (_, chunk) => {
            output += Buffer.from(chunk).toString()
          },
        },
      },
    )
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15000)
    try {
      assert.equal(await child.exited, 0, output)
      await Bun.sleep(50)
      assert.match(output, /WRAP_START/)
      assert.match(output, /WRAP_END/)
      assert.equal(output.includes("\x1b]52;c;aGk=\x07"), clipboard, output)
    } finally {
      clearTimeout(timeout)
      child.terminal?.close()
    }
  }
  assert.ok(JSON.parse(await ok(["disk"])))
  assert.equal(JSON.parse(await ok(["update", "status"])).configured, false)
  console.log(
    `M11_SMOKE_OK: hardening, live feature revocation, kernel denies, offline supervisor, alias, wrapped PTY clipboard, disk, update (${dirname(binary)})`,
  )
} finally {
  server.stop(true)
  await rm(root, { recursive: true, force: true })
}
