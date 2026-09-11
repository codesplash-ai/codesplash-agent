import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type JSONRPCMessage, parseJSONRPCMessage, type Transport } from "@modelcontextprotocol/client"
import { validateConfig } from "../../../src/core/config.ts"
import type { AgentEvent } from "../../../src/core/events.ts"
import type { HookEvent } from "../../../src/core/hooks.ts"
import { MemorySessionState } from "../../../src/core/session/control.ts"
import type {
  ModelInfo,
  ProviderClient,
  ProviderStreamEvent,
  ToolCallBlock,
  ToolContext,
} from "../../../src/engines/codesplash/contracts.ts"
import { HookManager } from "../../../src/engines/codesplash/hooks/manager.ts"
import { reviewHook, trustHook } from "../../../src/engines/codesplash/hooks/trust.ts"
import { CodesplashEventFactory, CodesplashLoop } from "../../../src/engines/codesplash/loop.ts"
import { McpManager } from "../../../src/engines/codesplash/mcp/manager.ts"
import { createMcpToolRegistry, rankMcpTools } from "../../../src/engines/codesplash/mcp/registry.ts"
import { recordMcpTrust, reviewMcpServer } from "../../../src/engines/codesplash/mcp/trust.ts"
import { createPermissionRuntime } from "../../../src/engines/codesplash/permissions.ts"
import { createProfile } from "../../../src/engines/codesplash/sandbox/profile.ts"
import { NativeSandbox } from "../../../src/engines/codesplash/sandbox/runtime.ts"
import { ToolOutputStore } from "../../../src/engines/codesplash/tool-output-store.ts"
import { createToolRegistry } from "../../../src/engines/codesplash/tools/registry.ts"

const echo = {
  name: "echo/fixture",
  description: "Fixture echo",
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  },
}
class FixtureTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  closed = false
  calls = 0
  arguments: unknown[] = []
  hang = false
  repeatCursor = false
  lastRead?: unknown
  elicitation = false
  formReply?: unknown
  pendingCall?: string | number
  content: unknown[] = [{ type: "text", text: "fixture result" }]
  async start(): Promise<void> {}
  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.onclose?.()
    }
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error("closed")
    if (!("method" in message)) {
      if ("result" in message && message.id === "form") {
        this.formReply = message.result
        queueMicrotask(() =>
          this.onmessage?.(
            parseJSONRPCMessage({ jsonrpc: "2.0", id: this.pendingCall, result: { content: this.content } }),
          ),
        )
      }
      return
    }
    if (!("id" in message)) return
    let result: unknown = {}
    if (message.method === "initialize")
      result = {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "fixture", version: "1" },
        capabilities: { tools: { listChanged: true }, resources: {} },
      }
    if (message.method === "tools/list")
      result = {
        tools: this.repeatCursor ? [] : [echo, { ...echo, name: "denied" }],
        ...(this.repeatCursor ? { nextCursor: "same" } : {}),
      }
    if (message.method === "tools/call") {
      this.calls++
      this.arguments.push(message.params?.arguments)
      if (this.hang) return
      if (this.elicitation) {
        this.pendingCall = message.id
        queueMicrotask(() =>
          this.onmessage?.(
            parseJSONRPCMessage({
              jsonrpc: "2.0",
              id: "form",
              method: "elicitation/create",
              params: {
                mode: "form",
                message: "Choose a label",
                requestedSchema: {
                  type: "object",
                  properties: { label: { type: "string", maxLength: 32 } },
                  required: ["label"],
                },
              },
            }),
          ),
        )
        return
      }
      result = { content: this.content }
    }
    if (message.method === "resources/list")
      result = { resources: [{ uri: "fixture://document", name: "Document", mimeType: "text/plain" }] }
    if (message.method === "resources/templates/list")
      result = { resourceTemplates: [{ uriTemplate: "fixture://documents/{id}", name: "Documents" }] }
    if (message.method === "resources/read") {
      this.lastRead = message.params?.uri
      result = {
        contents: [{ uri: message.params?.uri, mimeType: "text/plain", text: "remote fixture content" }],
      }
    }
    queueMicrotask(() => this.onmessage?.(parseJSONRPCMessage({ jsonrpc: "2.0", id: message.id, result })))
  }
  invalidate(): void {
    this.onmessage?.(parseJSONRPCMessage({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }))
  }
}

async function setup(elicitation?: ConstructorParameters<typeof McpManager>[0]["elicitation"]) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "cs-mcp-manager-")))
  let config = validateConfig(
    {
      mcp: {
        servers: {
          fixture: {
            transport: "http",
            url: "https://example.test/mcp",
            enabled: false,
            requestTimeoutMs: 100,
            denyTools: ["denied"],
          },
        },
      },
    },
    "fixture",
  )
  const sandbox = new NativeSandbox(createProfile(cwd, "read-only"))
  let next = new FixtureTransport(),
    created = 0
  const manager = new McpManager({
    cwd,
    dataDir: cwd,
    sandbox,
    elicitation,
    mode: () => "default",
    resolveConfig: async () => config,
    transport: () => {
      created++
      return next
    },
  })
  return {
    cwd,
    manager,
    get created() {
      return created
    },
    get transport() {
      return next
    },
    replace() {
      next = new FixtureTransport()
      return next
    },
    async enable() {
      config.mcp!.servers.fixture!.enabled = true
      const review = await reviewMcpServer(config, "fixture", cwd)
      recordMcpTrust(cwd, review, review.fingerprint)
    },
    restrictTools(names: string[]) {
      config.mcp!.servers.fixture!.allowTools = names
    },
    disable() {
      config = { ...config, mcp: { servers: {} } }
    },
    async close() {
      await manager.close()
      await sandbox.close()
      await rm(cwd, { recursive: true, force: true })
    },
  }
}

test("MCP manager refuses disabled clients, filters denied tools and fences stale catalogs", async () => {
  const fixture = await setup()
  try {
    expect(fixture.manager.catalog()).toEqual([])
    await expect(fixture.manager.connect("fixture")).rejects.toThrow("disabled")
    expect(fixture.created).toBe(0)
    await fixture.enable()
    await fixture.manager.connect("fixture")
    const tool = fixture.manager.catalog()[0]!
    expect(fixture.manager.catalog()).toHaveLength(1)
    expect(tool.id).toMatch(/^mcp_fixture_[a-f0-9]{24}$/)
    await expect(
      fixture.manager.call(tool.id, tool.generation, { message: 3 }, AbortSignal.timeout(1000)),
    ).rejects.toThrow("schema")
    expect(fixture.transport.calls).toBe(0)
    expect(
      await fixture.manager.call(tool.id, tool.generation, { message: "ok" }, AbortSignal.timeout(1000)),
    ).toEqual({ content: [{ type: "text", text: "fixture result" }] })
    fixture.transport.invalidate()
    await Promise.resolve()
    expect(fixture.manager.catalog()).toEqual([])
    await expect(
      fixture.manager.call(tool.id, tool.generation, { message: "ok" }, AbortSignal.timeout(1000)),
    ).rejects.toThrow("stale")
    fixture.replace()
    await fixture.manager.connect("fixture")
    expect(fixture.manager.catalog()[0]?.generation).not.toBe(tool.generation)
    expect(() => fixture.manager.lookup(tool.id, tool.generation)).toThrow("stale")
  } finally {
    await fixture.close()
  }
})

test("failed staged catalog keeps the previous client and uncertain calls are never retried", async () => {
  const fixture = await setup()
  try {
    await fixture.enable()
    await fixture.manager.connect("fixture")
    const first = fixture.transport,
      tool = fixture.manager.catalog()[0]!
    const staged = fixture.replace()
    staged.repeatCursor = true
    await expect(fixture.manager.connect("fixture")).rejects.toThrow("repeated cursor")
    expect(staged.closed).toBe(true)
    expect(first.closed).toBe(false)
    expect(fixture.manager.lookup(tool.id, tool.generation)).toEqual(tool)
    first.hang = true
    await expect(
      fixture.manager.call(tool.id, tool.generation, { message: "ok" }, AbortSignal.timeout(1000)),
    ).rejects.toThrow("uncertain")
    expect(first.calls).toBe(1)
    const pending = fixture.manager.call(
      tool.id,
      tool.generation,
      { message: "ok" },
      AbortSignal.timeout(1000),
    )
    const failure = expect(pending).rejects.toThrow()
    await fixture.manager.close()
    await failure
    expect(first.closed).toBe(true)
  } finally {
    await fixture.close()
  }
})

test("MCP resources/templates are bounded server operations and URIs never become host reads", async () => {
  const fixture = await setup()
  try {
    await fixture.enable()
    await fixture.manager.connect("fixture")
    const generation = fixture.manager.statuses()[0]!.generation
    expect(
      await fixture.manager.listResources("fixture", generation, false, AbortSignal.timeout(1000)),
    ).toEqual([{ uri: "fixture://document", name: "Document", mimeType: "text/plain" }])
    expect(
      await fixture.manager.listResources("fixture", generation, true, AbortSignal.timeout(1000)),
    ).toEqual([{ uriTemplate: "fixture://documents/{id}", name: "Documents" }])
    const uri = "file:///no-host-access-for-this-uri"
    expect(await fixture.manager.readResource("fixture", generation, uri, AbortSignal.timeout(1000))).toEqual(
      { contents: [{ uri, mimeType: "text/plain", text: "remote fixture content" }] },
    )
    expect(fixture.transport.lastRead).toBe(uri)
    fixture.disable()
    await expect(
      fixture.manager.readResource("fixture", generation, uri, AbortSignal.timeout(1000)),
    ).rejects.toThrow("disabled")
    await fixture.manager.close()
    await expect(
      fixture.manager.listResources("fixture", generation, false, AbortSignal.timeout(1000)),
    ).rejects.toThrow("stale")
  } finally {
    await fixture.close()
  }
})

const model: ModelInfo = {
  id: "fixture",
  displayName: "Fixture",
  provider: "anthropic",
  protocol: "anthropic",
  contextWindow: 200000,
  maxOutputTokens: 1000,
  isDefault: true,
  supportsReasoning: false,
}
const context: ToolContext = {
  cwd: "/tmp",
  policy: { sandbox: "workspace-write", approvalPolicy: "on-request" },
  signal: AbortSignal.timeout(10000),
}

async function runMcpLoop(
  fixture: Awaited<ReturnType<typeof setup>>,
  calls: ToolCallBlock[],
  deny: string[] = [],
  hooks?: HookManager,
) {
  const registry = createMcpToolRegistry(createToolRegistry([]), fixture.manager)
  await registry.get("search_tool")!.run({ query: "select:fixture/echo/fixture" }, context)
  const events: AgentEvent[] = []
  let checkpointCount = 0,
    requests = 0
  const permissions = await createPermissionRuntime({
    cwd: fixture.cwd,
    mode: "default",
    workspaceTrusted: false,
    configRules: { allow: [], ask: [], deny },
    grantsPath: join(fixture.cwd, "grants.json"),
  })
  const loop = new CodesplashLoop({
    hooks,
    cwd: fixture.cwd,
    policy: context.policy,
    registry,
    permissions,
    events: new CodesplashEventFactory("fixture"),
    beforeMutation: async () => {
      checkpointCount++
      return "checkpoint"
    },
    emit(event) {
      events.push(event)
      if (event.kind === "request.opened")
        queueMicrotask(() => loop.resolveRequest(event.payload.id, "acceptForSession"))
    },
  })
  const provider: ProviderClient = {
    id: "anthropic",
    models: [model],
    async *stream() {
      requests++
      if (requests === 1) {
        for (const call of calls) yield call satisfies ProviderStreamEvent
        yield { type: "done", stopReason: "tool_use" }
      } else yield { type: "done", stopReason: "end_turn" }
    },
  }
  await loop.runTurn({
    provider,
    model,
    system: "fixture",
    userText: "run fixture",
    userContent: [{ type: "text", text: "run fixture" }],
  })
  return { events, history: loop.historySnapshot(), checkpointCount }
}

test("direct, deferred and resource MCP rewrites use effective inputs without changing source identity", async () => {
  const f = await setup(),
    seen: HookEvent[] = []
  const config = validateConfig(
    {
      hooks: {
        handlers: {
          rewrite: {
            kind: "command",
            command: "/bin/cat",
            enabled: true,
            events: ["tool.before"],
            share: ["input"],
            allowInputRewrite: true,
          },
        },
      },
    },
    "fixture",
  )
  const sandbox = new NativeSandbox(createProfile(f.cwd, "read-only"))
  let malicious = false
  sandbox.executeFixed = async (_argv, input) => {
    const event = JSON.parse(input) as HookEvent
    seen.push(event)
    const resource = event.metadata.toolSource?.includes("/resources/")
    return {
      kind: "success",
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        version: 1,
        input: resource
          ? { ...event.fields.input, uri: "fixture://rewritten", ...(malicious ? { server: "evil" } : {}) }
          : { message: "rewritten" },
      }),
    }
  }
  const hooks = new HookManager({
    config,
    resolveConfig: async () => config,
    cwd: f.cwd,
    dataDir: f.cwd,
    sandbox,
    mode: () => "default",
    state: new MemorySessionState(),
    outputs: new ToolOutputStore(),
  })
  try {
    const review = await reviewHook(config, "rewrite", f.cwd)
    trustHook(f.cwd, review, review.fingerprint)
    await f.enable()
    await f.manager.connect("fixture")
    const target = f.manager.catalog()[0]!
    await runMcpLoop(
      f,
      [
        { type: "tool_call", id: "direct", name: target.id, input: { message: "original" } },
        {
          type: "tool_call",
          id: "deferred",
          name: "use_tool",
          input: { id: target.id, generation: target.generation, input: { message: "original" } },
        },
        {
          type: "tool_call",
          id: "resource",
          name: "mcp_resource",
          input: {
            server: "fixture",
            generation: target.generation,
            action: "read",
            uri: "fixture://original",
          },
        },
      ],
      [],
      hooks,
    )
    expect(f.transport.arguments).toEqual([{ message: "rewritten" }, { message: "rewritten" }])
    expect(f.transport.lastRead).toBe("fixture://rewritten")
    expect(seen.map((event) => event.metadata.toolSource)).toEqual([
      "mcp:fixture/echo/fixture",
      "mcp:fixture/echo/fixture",
      "mcp:fixture/resources/read",
    ])
    expect(seen.every((event) => event.metadata.toolGeneration === target.generation)).toBe(true)
    malicious = true
    const refused = await runMcpLoop(
      f,
      [
        {
          type: "tool_call",
          id: "bad-resource",
          name: "mcp_resource",
          input: {
            server: "fixture",
            generation: target.generation,
            action: "read",
            uri: "fixture://original",
          },
        },
      ],
      [],
      hooks,
    )
    expect(
      refused.history
        .flatMap((message) => message.content)
        .some((block) => block.type === "tool_result" && block.isError),
    ).toBe(true)
    expect(f.transport.lastRead).toBe("fixture://rewritten")
  } finally {
    await hooks.close()
    await sandbox.close()
    await f.close()
  }
})

test("direct and deferred MCP calls share actual approvals, schema guards, results and external checkpoint boundaries", async () => {
  const fixture = await setup()
  try {
    await fixture.enable()
    await fixture.manager.connect("fixture")
    const tool = fixture.manager.catalog()[0]!
    expect(tool.readOnly).toBe(false) // Server annotations alone cannot authorize readonly dispatch.
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII="
    fixture.transport.content = [{ type: "image", mimeType: "image/png", data: png }]
    const result = await runMcpLoop(fixture, [
      {
        type: "tool_call",
        id: "invalid",
        name: "use_tool",
        input: { id: tool.id, generation: tool.generation, input: { message: 3 } },
      },
      { type: "tool_call", id: "direct", name: tool.id, input: { message: "direct" } },
      {
        type: "tool_call",
        id: "deferred",
        name: "use_tool",
        input: { id: tool.id, generation: tool.generation, input: { message: "deferred" } },
      },
    ])
    expect(fixture.transport.calls).toBe(2)
    expect(result.checkpointCount).toBe(0)
    const approvals = result.events.filter((event) => event.kind === "request.opened")
    expect(approvals).toHaveLength(1)
    expect(JSON.stringify(approvals)).toContain("fixture/echo/fixture")
    expect(JSON.stringify(approvals)).toContain(tool.fingerprint)
    expect(JSON.stringify(approvals)).not.toContain("acceptAlways")
    const content = result.history.flatMap((message) => message.content)
    const results = content.filter((block) => block.type === "tool_result")
    expect(results.map((block) => block.toolCallId)).toEqual(["invalid", "direct", "deferred"])
    expect(results[0]?.isError).toBe(true)
    expect(results[1]?.text).toContain('"attachedImage":1')
    expect(content.filter((block) => block.type === "image")).toHaveLength(2)
    expect(content.some((block) => block.type === "tool_call" && block.name === "use_tool")).toBe(true)
  } finally {
    await fixture.close()
  }
})

test("MCP deferred aliases cannot bypass deny rules and reconnect discards selected schemas", async () => {
  const fixture = await setup()
  try {
    await fixture.enable()
    await fixture.manager.connect("fixture")
    const tool = fixture.manager.catalog()[0]!
    for (const denied of [tool.id, "use_tool"]) {
      const result = await runMcpLoop(
        fixture,
        [
          {
            type: "tool_call",
            id: "denied",
            name: "use_tool",
            input: { id: tool.id, generation: tool.generation, input: { message: "denied" } },
          },
        ],
        [denied],
      )
      expect(result.events.filter((event) => event.kind === "request.opened")).toHaveLength(0)
      expect(
        result.history
          .flatMap((message) => message.content)
          .filter((block) => block.type === "tool_result")[0]?.isError,
      ).toBe(true)
    }
    expect(fixture.transport.calls).toBe(0)
    const registry = createMcpToolRegistry(createToolRegistry([]), fixture.manager)
    expect(registry.specs().some((spec) => spec.name === tool.id)).toBe(false)
    await registry.get("search_tool")!.run({ query: "fixture echo" }, context)
    expect(registry.specs().some((spec) => spec.name === tool.id)).toBe(true)
    fixture.replace()
    await fixture.manager.connect("fixture")
    expect(registry.specs().some((spec) => spec.name === tool.id)).toBe(false)
    expect(() =>
      registry.resolve!({
        type: "tool_call",
        id: "old",
        name: "use_tool",
        input: { id: tool.id, generation: tool.generation, input: {} },
      }),
    ).toThrow("stale")
    expect(fixture.manager.catalog()[0]?.id).toBe(tool.id)
  } finally {
    await fixture.close()
  }
})

test("MCP SDK elicitation is correlated with the active operation and headless mode declines", async () => {
  for (const interactive of [false, true]) {
    let forms = 0
    const fixture = await setup(
      interactive
        ? {
            respond: async (form) => {
              forms++
              expect(form.source.server).toBe("fixture")
              expect(form.source.operation).toBe("echo/fixture")
              return { action: "accept", content: { label: "chosen" } }
            },
          }
        : undefined,
    )
    try {
      await fixture.enable()
      await fixture.manager.connect("fixture")
      const tool = fixture.manager.catalog()[0]!
      fixture.transport.elicitation = true
      await fixture.manager.call(tool.id, tool.generation, { message: "form" }, AbortSignal.timeout(2000))
      expect(forms).toBe(interactive ? 1 : 0)
      expect(fixture.transport.formReply).toEqual(
        interactive ? { action: "accept", content: { label: "chosen" } } : { action: "decline" },
      )
    } finally {
      await fixture.close()
    }
  }
})

test("resource dispatch names the actual server operation and source rejection closes its client", async () => {
  const fixture = await setup()
  try {
    await fixture.enable()
    await fixture.manager.connect("fixture")
    const generation = fixture.manager.statuses()[0]!.generation
    const registry = createMcpToolRegistry(createToolRegistry([]), fixture.manager)
    const { call, tool } = registry.resolve!({
      type: "tool_call",
      id: "read",
      name: "mcp_resource",
      input: { server: "fixture", generation, action: "read", uri: "file:///remote-only" },
    })
    expect(tool.name).toMatch(/^mcp_fixture_/)
    expect(tool.permission(call.input, context)).toMatchObject({
      kind: "approval",
      title: "Run MCP fixture/resources/read?",
    })
    expect((await tool.run(call.input, context)).text).toContain("remote fixture content")
    expect(fixture.transport.lastRead).toBe("file:///remote-only")
    fixture.disable()
    await expect(tool.run(call.input, context)).rejects.toThrow("disabled")
    expect(fixture.transport.closed).toBe(true)
    expect(fixture.manager.catalog()).toEqual([])
  } finally {
    await fixture.close()
  }
})

test("BM25 discovery bounds a large catalog and ranks distinctive operation terms", () => {
  const target = {
    id: "target",
    serverId: "fixture",
    originalName: "needle",
    description: "Index metadata",
    inputSchema: { type: "object" },
    generation: "one",
    fingerprint: "review",
    readOnly: false,
    transport: "http" as const,
  }
  const catalog = [
    ...Array.from({ length: 4999 }, (_, index) => ({
      ...target,
      id: `other${index}`,
      originalName: "ordinary",
      description: "Index documents",
    })),
    target,
  ]
  expect(rankMcpTools(catalog, "needle metadata").map((tool) => tool.id)).toEqual(["target"])
})

test("MCP allowlists also gate resource operations before selection and protocol dispatch", async () => {
  const fixture = await setup()
  try {
    fixture.restrictTools(["echo/fixture"])
    await fixture.enable()
    await fixture.manager.connect("fixture")
    const generation = fixture.manager.statuses()[0]!.generation
    expect(() => fixture.manager.resourceTarget("fixture", generation, "read")).toThrow("denied")
    await expect(
      fixture.manager.readResource("fixture", generation, "file:///denied", AbortSignal.timeout(1000)),
    ).rejects.toThrow("denied")
    expect(fixture.transport.lastRead).toBeUndefined()
    expect(fixture.transport.closed).toBe(true)
  } finally {
    await fixture.close()
  }
})
