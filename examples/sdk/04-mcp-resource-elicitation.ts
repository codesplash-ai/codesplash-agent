import { writeFile } from "node:fs/promises"
import { reviewIntegration, trustIntegration } from "codesplash-agent"
import { assert, fixture, localProvider } from "./fixture.ts"

await fixture(async ({ options, open }) => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII="
  let calls = 0,
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

  try {
    await writeFile(
      options.config!.path!,
      `[mcp.servers.fixture]\ntransport="http"\nurl="${mcp.url.href}"\nallowLoopback=true\nenabled=true\nreadOnlyTools=["fixture"]\nrequestTimeoutMs=5000\n`,
    )
    const review = await reviewIntegration(options, "mcp", "fixture")
    await trustIntegration(options, "mcp", "fixture", review.fingerprint)
    let stage = 0,
      forms = 0
    const provider = localProvider()
    provider.stream = async function* (request) {
      stage++
      let name = "",
        input: unknown = {}
      if (stage === 1) {
        name = "search_tool"
        input = { query: "select:fixture/fixture" }
      }
      if (stage === 2) {
        const result = request.messages
          .flatMap((message) => message.content)
          .filter((block) => block.type === "tool_result")
          .at(-1)
        assert.ok(result && result.type === "tool_result")
        target = JSON.parse(result.text).tools[0]
        assert.ok(target)
        name = "use_tool"
        input = { id: target.id, generation: target.generation, input: { message: "SDK fixture" } }
      }
      if (stage === 3) {
        assert.match(JSON.stringify(request.messages), /MCP_OPERATION_COMPLETED/)
        sawImage = JSON.stringify(request.messages).includes(png)
        assert.equal(formAction, "accept")
        assert.ok(target)
        name = "mcp_resource"
        input = {
          server: "fixture",
          generation: target.generation,
          action: "read",
          uri: "file:///REMOTE_ONLY",
        }
      }
      if (stage === 4) assert.match(JSON.stringify(request.messages), /MCP_RESOURCE_COMPLETED/)
      assert.ok(stage <= 4)
      if (name) {
        yield { type: "tool_call", id: `call-${stage}`, name, input }
        yield { type: "done", stopReason: "tool_use" }
      } else {
        yield { type: "text_delta", text: "MCP example complete" }
        yield { type: "done", stopReason: "end_turn" }
      }
    }
    const session = await open({
      providers: [provider],
      async respond(request) {
        if (request.requestKind === "elicitation") {
          forms++
          return { choice: "accept", data: { label: "chosen" } }
        }
        return { choice: "accept" }
      },
    })
    assert.equal((await session.prompt("Read the MCP fixture")).status, "completed")
    assert.equal(calls, 1)
    assert.equal(reads, 1)
    assert.equal(forms, 1)
    assert.ok(sawImage)
    await session.close()
  } finally {
    await mcp.stop(true)
  }
})
