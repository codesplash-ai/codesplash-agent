/** Compiled MCP-to-native-loop fixture: real HTTP/SSE exchange, deferred calls, images and forms. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"

const argument = process.argv[2]
if (!argument) throw new Error("Usage: bun scripts/mcp-session-smoke.ts /path/to/codesplash")
const binary = resolve(argument)
const root = await realpath(await mkdtemp(join(tmpdir(), "codesplash-mcp-session-")))
const cwd = join(root, "workspace"),
  config = join(root, "config")
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII="
let stage = 0,
  calls = 0,
  reads = 0,
  formAction: unknown,
  sawImage = false
let target: { id: string; generation: string } | undefined
let pending: { id: string | number; controller: ReadableStreamDefaultController<Uint8Array> } | undefined
const encoder = new TextEncoder()
const event = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`)
const mcp = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 })
    const body = (await request.json()) as {
      id?: string | number
      method?: string
      params?: Record<string, unknown>
      result?: { action?: string }
    }
    if (body.id === "form" && body.result) {
      formAction = body.result.action
      assert.ok(pending)
      pending.controller.enqueue(
        event({
          jsonrpc: "2.0",
          id: pending.id,
          result: {
            content: [
              { type: "image", data: png, mimeType: "image/png" },
              { type: "text", text: "MCP_OPERATION_COMPLETED" },
            ],
          },
        }),
      )
      pending.controller.close()
      pending = undefined
      return new Response(null, { status: 202 })
    }
    if (body.id === undefined) return new Response(null, { status: 202 })
    let result: unknown
    switch (body.method) {
      case "initialize":
        result = {
          protocolVersion: "2025-11-25",
          serverInfo: { name: "mcp-session-smoke", version: "1" },
          capabilities: { tools: {}, resources: {} },
        }
        break
      case "tools/list":
        result = {
          tools: [
            {
              name: "fixture",
              description: "Fixture operation",
              inputSchema: {
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"],
                additionalProperties: false,
              },
            },
          ],
        }
        break
      case "tools/call": {
        calls++
        const id = body.id
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            pending = { id, controller }
            controller.enqueue(
              event({
                jsonrpc: "2.0",
                id: "form",
                method: "elicitation/create",
                params: {
                  mode: "form",
                  message: "Choose a label",
                  requestedSchema: { type: "object", properties: { label: { type: "string" } } },
                },
              }),
            )
          },
          cancel() {
            pending = undefined
          },
        })
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
      }
      case "resources/read":
        reads++
        assert.equal(body.params?.uri, "file:///REMOTE_ONLY")
        result = {
          contents: [{ uri: body.params?.uri, mimeType: "text/plain", text: "MCP_RESOURCE_COMPLETED" }],
        }
        break
      default:
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "Unsupported fixture method" },
        })
    }
    return Response.json({ jsonrpc: "2.0", id: body.id, result })
  },
})
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as {
      messages: Array<{ role: string; content: unknown }>
      tools?: unknown[]
    }
    stage++
    let name = "",
      input: unknown = {}
    if (stage === 1) {
      name = "search_tool"
      input = { query: "select:fixture/fixture" }
    }
    if (stage === 2) {
      const result = body.messages.filter((message) => message.role === "tool").at(-1)
      assert.ok(result && typeof result.content === "string")
      target = JSON.parse(result.content).tools[0]
      assert.ok(target)
      name = "use_tool"
      input = { id: target.id, generation: target.generation, input: { message: "compiled fixture" } }
    }
    if (stage === 3) {
      assert.match(JSON.stringify(body.messages), /MCP_OPERATION_COMPLETED/)
      sawImage = JSON.stringify(body.messages).includes("data:image/png;base64,")
      assert.equal(formAction, "decline")
      assert.ok(target)
      name = "mcp_resource"
      input = {
        server: "fixture",
        generation: target.generation,
        action: "read",
        uri: "file:///REMOTE_ONLY",
      }
    }
    if (stage === 4) assert.match(JSON.stringify(body.messages), /MCP_RESOURCE_COMPLETED/)
    assert.ok(stage <= 4)
    const delta = name
      ? {
          tool_calls: [
            {
              index: 0,
              id: `call-${stage}`,
              type: "function",
              function: { name, arguments: JSON.stringify(input) },
            },
          ],
        }
      : { content: "MCP_SESSION_SMOKE_OK" }
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
try {
  await mkdir(cwd)
  await mkdir(config)
  await writeFile(
    join(config, "config.toml"),
    `schemaVersion=1\n[providers.mcp-fixture]\nprotocol="openai"\nbaseUrl="http://127.0.0.1:${provider.port}"\nrequiresKey=false\nkeyEnvVar="MCP_SMOKE_UNUSED"\n[[providers.mcp-fixture.models]]\nid="mcp-fixture"\ncontextWindow=200000\nmaxOutputTokens=1000\n[mcp.servers.fixture]\ntransport="http"\nurl="http://127.0.0.1:${mcp.port}/mcp"\nallowLoopback=true\nenabled=true\nreadOnlyTools=["fixture"]\nrequestTimeoutMs=5000\n`,
  )
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODESPLASH_AGENT_CONFIG_DIR: config,
    CODESPLASH_AGENT_DATA_DIR: join(root, "data"),
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
  }
  for (const key of ["CODESPLASH_CONFIG", "CODESPLASH_PROFILE", "CODESPLASH_PERMISSION_MODE"]) delete env[key]
  const run = async (args: string[]) => {
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
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`)
    return result.stdout
  }
  const review = JSON.parse(await run(["mcp", "show", "fixture"]))
  await run(["mcp", "trust", "fixture", "--fingerprint", review.fingerprint])
  const output = await run([
    "run",
    "--model",
    "mcp-fixture",
    "--trust",
    "--auto",
    "--output-format",
    "json",
    "-p",
    "Exercise the configured MCP fixture",
  ])
  assert.match(output, /MCP_SESSION_SMOKE_OK/)
  assert.equal(calls, 1)
  assert.equal(reads, 1)
  assert.equal(sawImage, true)
  assert.equal(pending, undefined)
  console.log(
    "Compiled MCP session smoke passed: native deferred dispatch, HTTP SSE elicitation decline, validated image, remote resource URI and owned close",
  )
} finally {
  pending?.controller.close()
  await mcp.stop(true)
  await provider.stop(true)
  await rm(root, { recursive: true, force: true })
}
