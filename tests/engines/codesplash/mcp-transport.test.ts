import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/client"
import { boundedJson } from "../../../src/engines/codesplash/mcp/bounds.ts"
import { BoundedSchemaValidators, boundedSchema } from "../../../src/engines/codesplash/mcp/schema.ts"
import { SandboxedMcpTransport } from "../../../src/engines/codesplash/mcp/stdio.ts"
import { createProfile } from "../../../src/engines/codesplash/sandbox/profile.ts"
import { NativeSandbox } from "../../../src/engines/codesplash/sandbox/runtime.ts"

test("MCP schema validation is offline, bounded and preserves optional fields", () => {
  const validators = new BoundedSchemaValidators()
  const validate = validators.getValidator({
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  })
  expect(validate({ message: "ok" }).valid).toBe(true)
  expect(validate({ message: 3 }).valid).toBe(false)
  expect(validate({ message: "ok", extra: true }).valid).toBe(false)
  expect(() => boundedSchema({ $ref: "https://example.test/schema" })).toThrow("local")
  expect(() => boundedSchema({ type: "string", pattern: "(a+)+$" })).toThrow("unsupported")
  expect(() =>
    boundedSchema({ $defs: { recurse: { $ref: "#/$defs/recurse" } }, $ref: "#/$defs/recurse" }),
  ).toThrow("acyclic")
  expect(
    validators.getValidator({ $defs: { label: { type: "string" } }, $ref: "#/$defs/label" })("valid").valid,
  ).toBe(true)
  expect(() => boundedJson({ value: "large" }, 2)).toThrow("byte limit")
})

test("MCP SDK initialize/list/call uses a persistent sandboxed stdio process", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "cs-mcp-stdio-")))
  const sandbox = new NativeSandbox(createProfile(cwd, "read-only"))
  const script = `let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  while (buffer.includes("\\n")) {
    const at = buffer.indexOf("\\n"), request = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (request.id === undefined) continue;
    const result = request.method === "initialize"
      ? {protocolVersion:"2025-11-25",serverInfo:{name:"fixture",version:"1"},capabilities:{tools:{}}}
      : request.method === "tools/list"
        ? {tools:[{name:"echo",description:"Echo fixture",inputSchema:{type:"object",properties:{message:{type:"string"}},required:["message"],additionalProperties:false}}]}
        : {content:[{type:"text",text:request.params.arguments.message}]};
    process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\\n");
  }
}`
  let diagnostic = ""
  const transport = new SandboxedMcpTransport({
    sandbox,
    argv: [process.execPath, "-e", script],
    signal: AbortSignal.timeout(8000),
    mode: "plan",
    diagnostic: (value) => {
      diagnostic += value
    },
  })
  const client = new Client(
    { name: "codesplash-test", version: "1" },
    { jsonSchemaValidator: new BoundedSchemaValidators() },
  )
  try {
    await client.connect(transport, { timeout: 5000 })
    expect((await client.listTools()).tools[0]?.name).toBe("echo")
    const result = await client.callTool({ name: "echo", arguments: { message: "MCP_OK" } })
    expect(result.content).toEqual([{ type: "text", text: "MCP_OK" }])
    expect(diagnostic).toBe("")
  } finally {
    await client.close()
    await sandbox.close()
    await rm(cwd, { recursive: true, force: true })
  }
}, 15000)
