import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/client"
import { validateMcpConfig } from "../../../src/engines/codesplash/mcp/config.ts"
import { openMcpHttpTransport } from "../../../src/engines/codesplash/mcp/http.ts"
import { createProfile } from "../../../src/engines/codesplash/sandbox/profile.ts"

test("MCP Streamable HTTP uses a reviewed exact loopback origin and never reposts redirects", async () => {
  let calls = 0,
    authorization: string | null = null
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      authorization = request.headers.get("authorization")
      if (request.method === "GET") return new Response(null, { status: 405 })
      const message = (await request.json()) as { id?: number; method: string }
      if (message.id === undefined) return new Response(null, { status: 202 })
      if (message.method === "tools/call") {
        calls++
        return Response.redirect(`http://127.0.0.1:${server.port}/different`, 307)
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              serverInfo: { name: "fixture", version: "1" },
              capabilities: { tools: {} },
            }
          : { tools: [{ name: "fixture", inputSchema: { type: "object" } }] }
      return Response.json({ jsonrpc: "2.0", id: message.id, result })
    },
  })
  const client = new Client({ name: "fixture-client", version: "1" })
  const config = validateMcpConfig({
    servers: {
      fixture: { transport: "http", url: `http://127.0.0.1:${server.port}/mcp`, allowLoopback: true },
    },
  }).servers.fixture!
  const transport = await openMcpHttpTransport({
    server: config,
    profile: createProfile(process.cwd(), "read-only"),
    signal: AbortSignal.timeout(5000),
    bearerToken: async () => "fixture-secret",
  })
  try {
    await client.connect(transport, { timeout: 2000 })
    expect((await client.listTools()).tools[0]?.name).toBe("fixture")
    expect(authorization as string | null).toBe("Bearer fixture-secret")
    await expect(client.callTool({ name: "fixture", arguments: {} })).rejects.toThrow()
    expect(calls).toBe(1)
  } finally {
    await client.close()
    await transport.close()
    await server.stop(true)
  }
})

test("MCP HTTP rejects ungranted public hosts before opening a broker", async () => {
  const config = validateMcpConfig({
    servers: { fixture: { transport: "http", url: "https://example.test/mcp" } },
  }).servers.fixture!
  await expect(
    openMcpHttpTransport({
      server: config,
      profile: createProfile(process.cwd(), "read-only"),
      signal: AbortSignal.timeout(1000),
    }),
  ).rejects.toThrow("no fixed sandbox network grant")
})

test("MCP legacy SSE owns its endpoint stream and closes after SDK use", async () => {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  const encoder = new TextEncoder()
  let posted = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "GET")
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller
              controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"))
            },
            cancel() {
              stream = undefined
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      const message = (await request.json()) as { id?: number; method: string }
      posted++
      if (message.id !== undefined) {
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: "2025-11-25",
                serverInfo: { name: "sse-fixture", version: "1" },
                capabilities: { tools: {} },
              }
            : { tools: [] }
        stream?.enqueue(
          encoder.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`),
        )
      }
      return new Response(null, { status: 202 })
    },
  })
  const client = new Client({ name: "fixture-client", version: "1" })
  const config = validateMcpConfig({
    servers: {
      fixture: { transport: "sse", url: `http://127.0.0.1:${server.port}/sse`, allowLoopback: true },
    },
  }).servers.fixture!
  const transport = await openMcpHttpTransport({
    server: config,
    profile: createProfile(process.cwd(), "read-only"),
    signal: AbortSignal.timeout(5000),
  })
  try {
    await client.connect(transport, { timeout: 2000 })
    expect((await client.listTools()).tools).toEqual([])
    expect(posted).toBeGreaterThanOrEqual(3)
  } finally {
    await client.close()
    await transport.close()
    await server.stop(true)
  }
})
