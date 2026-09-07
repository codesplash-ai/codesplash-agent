import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  ChatMessage,
  ModelInfo,
  ProviderClient,
  ProviderRequest,
  ProviderStreamEvent,
  ToolContext,
} from "../../../src/engines/codesplash/contracts.ts"
import { embeddingTool } from "../../../src/engines/codesplash/memory/embedding.ts"
import { maintainMemory, memoryEvidence } from "../../../src/engines/codesplash/memory/maintenance.ts"
import { MemorySession } from "../../../src/engines/codesplash/memory/session.ts"
import { memoryTools } from "../../../src/engines/codesplash/memory/tools.ts"
import { createPermissionRuntime } from "../../../src/engines/codesplash/permissions.ts"

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture tool")
  return value
}
const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
const signal = () => new AbortController().signal
const clean = (s: string) => s.replaceAll("SECRET_CANARY", "[REDACTED]")
async function fixture(history = true, writable = true) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "memory-maintenance-")))
  roots.push(cwd)
  const permissions = await createPermissionRuntime({
    cwd,
    mode: "default",
    workspaceTrusted: true,
    configRules: { allow: [], ask: [], deny: [] },
  })
  const memory = new MemorySession({
    cwd,
    root: join(cwd, "memory"),
    session: "current",
    history,
    trusted: true,
    writable: () => writable,
    permissions,
    sanitize: clean,
  })
  const context: ToolContext = {
    cwd,
    signal: signal(),
    policy: { sandbox: writable ? "workspace-write" : "read-only", approvalPolicy: "on-request" },
    permissions,
    sanitizeOutput: clean,
  }
  return { memory, context, cwd }
}
const model: ModelInfo = {
  id: "fixture",
  displayName: "Fixture",
  provider: "fixture",
  protocol: "openai",
  isDefault: true,
  contextWindow: 100000,
  maxOutputTokens: 2048,
  supportsReasoning: false,
}
const messages: ChatMessage[] = [
  { role: "user", content: [{ type: "text", text: "Use a transactional parser. SECRET_CANARY" }] },
]
function provider(handler: (request: ProviderRequest) => AsyncIterable<ProviderStreamEvent>): ProviderClient {
  return { id: "openai", models: [model], stream: handler }
}
function success(request: ProviderRequest, count = 1) {
  const input = request.messages[0]?.content[0]
  if (input?.type !== "text") throw new Error("Missing evidence")
  const evidence = JSON.parse(input.text) as Array<{ id: string }>
  return (async function* () {
    expect(request.tools).toEqual([])
    expect(JSON.stringify(request)).not.toContain("SECRET_CANARY")
    yield {
      type: "text_delta",
      text: JSON.stringify({
        facts: Array.from({ length: count }, () => ({
          text: "Transactional parser SECRET_CANARY",
          sourceIds: [evidence[0]?.id],
        })),
      }),
    } as const
    yield { type: "usage", usage: { inputTokens: 123, outputTokens: 21 } } as const
    yield { type: "done", stopReason: "end_turn" } as const
  })()
}
test("extraction validates provenance, sanitizes every durable/index surface, deduplicates and records usage", async () => {
  const { memory } = await fixture()
  let tokens = 0,
    calls = 0
  const options = {
    memory,
    messages,
    model,
    signal: signal(),
    action: "extract" as const,
    onUsage: (u: { inputTokens?: number }) => {
      tokens += u.inputTokens ?? 0
    },
    provider: provider((r) => {
      calls++
      return success(r, 2)
    }),
  }
  expect(await maintainMemory(options)).toContain("1 memory candidates saved")
  expect(tokens).toBe(123)
  expect(await maintainMemory(options)).toContain("already processed")
  expect(calls).toBe(1)
  const store = await memory.store(signal())
  const candidate = store?.snapshot().records[0]
  expect(candidate?.sources[0]?.id).toBe(memoryEvidence(messages, clean)[0]?.id)
  expect((await memory.search("parser", signal())).records).toHaveLength(0)
  if (!candidate || !store) throw new Error("Missing candidate")
  await memory.mutate(candidate.id, "accept", undefined, signal(), 1)
  expect(store.snapshot().records[0]?.source).toBe("generated")
  expect(store.snapshot().records[0]?.reviewed).toBe(true)
  expect((await memory.search("parser", signal())).records).toHaveLength(1)
  for (const file of readdirSync(join(store.root, "objects")))
    expect(readFileSync(join(store.root, "objects", file), "utf8")).not.toContain("SECRET_CANARY")
  expect(readFileSync(join(store.root, "index.sqlite")).includes(Buffer.from("SECRET_CANARY"))).toBe(false)
  await expect(memory.mutate(candidate.id, "edit", "hijack", signal(), 2, true)).rejects.toThrow(
    "Only the user",
  )
})
test("malformed/unsupported/truncated extraction preserves the last committed store", async () => {
  const { memory } = await fixture()
  await memory.remember("Curated parser", signal())
  const store = await memory.store(signal()),
    before = store?.snapshot()
  for (const events of [
    [
      { type: "text_delta", text: '{"facts":[{"text":"bad","sourceIds":["invented"]}]}' },
      { type: "done", stopReason: "end_turn" },
    ],
    [{ type: "tool_call", toolCallId: "x", name: "bash", input: { command: "touch bad" } }],
    [
      { type: "text_delta", text: '{"facts":[]}' },
      { type: "done", stopReason: "max_tokens" },
    ],
    [{ type: "text_delta", text: "{" }],
  ] as ProviderStreamEvent[][]) {
    await expect(
      maintainMemory({
        memory,
        messages,
        model,
        signal: signal(),
        action: "extract",
        onUsage: () => {},
        provider: provider(() =>
          (async function* () {
            yield* events
          })(),
        ),
      }),
    ).rejects.toThrow()
    expect(store?.snapshot()).toEqual(before)
  }
})
test("maintenance deadline settles a noncooperative provider without creating a store", async () => {
  const { memory } = await fixture()
  const stuck = provider(() => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }))
  const start = Date.now()
  await expect(
    maintainMemory({
      memory,
      messages,
      model,
      provider: stuck,
      signal: signal(),
      action: "extract",
      onUsage: () => {},
      timeoutMs: 20,
    }),
  ).rejects.toThrow("timed out")
  expect(Date.now() - start).toBeLessThan(2000)
  expect(existsSync(memory.options.root)).toBe(false)
})
test("consolidation preserves curated facts and stale provider output cannot overwrite a concurrent edit", async () => {
  const { memory } = await fixture()
  const curated = await memory.remember("Curated instruction", signal())
  const p = provider((r) => success(r))
  await maintainMemory({
    memory,
    messages,
    model,
    provider: p,
    signal: signal(),
    action: "extract",
    onUsage: () => {},
  })
  await maintainMemory({
    memory,
    messages: [],
    model,
    provider: p,
    signal: signal(),
    action: "consolidate",
    onUsage: () => {},
  })
  const store = await memory.store(signal())
  expect(store?.snapshot().records.some((r) => r.id === curated.id && r.text === curated.text)).toBe(true)
  const changing = provider((r) =>
    (async function* () {
      await memory.remember("Concurrent write", signal())
      yield* success(r)
    })(),
  )
  await expect(
    maintainMemory({
      memory,
      messages: [{ role: "user", content: [{ type: "text", text: "New evidence" }] }],
      model,
      provider: changing,
      signal: signal(),
      action: "extract",
      onUsage: () => {},
    }),
  ).rejects.toThrow("concurrently")
  expect(store?.snapshot().records.some((r) => r.text === "Concurrent write")).toBe(true)
})
test("notes resume only in their session; no-history notes remain ephemeral and history excludes tool bodies", async () => {
  const { memory, context } = await fixture()
  const notes = required(memoryTools(memory, () => []).find((t) => t.name === "session_notes"))
  await notes.run({ action: "write", id: "todo", text: "Verify parser SECRET_CANARY" }, context)
  const resumed = new MemorySession({ ...memory.options })
  const resumedTool = required(memoryTools(resumed, () => []).find((t) => t.name === "session_notes"))
  expect((await resumedTool.run({ action: "read", id: "todo" }, context)).text).toBe(
    "Verify parser [REDACTED]",
  )
  const other = new MemorySession({ ...memory.options, session: "other" })
  expect(
    (await required(memoryTools(other, () => []).find((t) => t.name === "session_notes")).run({}, context))
      .text,
  ).toBe("No session notes")
  const ephemeral = await fixture(false)
  const tools = memoryTools(ephemeral.memory, () => [
    {
      role: "user",
      content: [
        { type: "text", text: "Session evidence SECRET_CANARY" },
        { type: "tool_result", toolCallId: "x", text: "TOOL_BODY_CANARY" },
      ],
    },
  ])
  await required(tools.find((t) => t.name === "session_notes")).run(
    { action: "write", id: "todo", text: "ephemeral" },
    ephemeral.context,
  )
  expect(existsSync(ephemeral.memory.options.root)).toBe(false)
  const result = await required(tools.find((t) => t.name === "history_read")).run({}, ephemeral.context)
  expect(result.text).toContain("Session evidence [REDACTED]")
  expect(result.text).not.toContain("TOOL_BODY_CANARY")
})
test("embedding transport validates dimensions/count/limits, uses only governed fetch and accounts reported failures", async () => {
  const { context } = await fixture()
  const old = process.env.MEMORY_FIXTURE_KEY
  process.env.MEMORY_FIXTURE_KEY = "fixture-key"
  let usage = 0,
    calls = 0
  const tool = embeddingTool(
    {
      url: "https://embedding.example/v1/embeddings",
      model: "fixture",
      keyEnvVar: "MEMORY_FIXTURE_KEY",
      dimensions: 2,
      inputPerMTok: 1,
    },
    (n) => {
      usage += n
    },
  )
  try {
    await expect(tool.run({ texts: ["text"] }, context)).rejects.toThrow("governed")
    const transport = {
      ...context,
      fetchNetwork: async (_url: string, init?: RequestInit) => {
        calls++
        expect(init?.redirect).toBe("error")
        expect(String(init?.body)).not.toContain("SECRET_CANARY")
        return Response.json({ data: [{ index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 7 } })
      },
    }
    expect((await tool.run({ texts: ["SECRET_CANARY"] }, transport)).text).toContain("[[1,0]]")
    expect(usage).toBe(7)
    await expect(tool.run({ texts: Array(17).fill("x") }, transport)).rejects.toThrow("16 texts")
    expect(calls).toBe(1)
    await expect(
      tool.run(
        { texts: ["x"] },
        {
          ...transport,
          fetchNetwork: async () =>
            Response.json({ data: [{ index: 0, embedding: [1] }], usage: { prompt_tokens: 5 } }),
        },
      ),
    ).rejects.toThrow("dimensions")
    expect(usage).toBe(12)
    await expect(
      tool.run(
        { texts: ["x"] },
        { ...transport, fetchNetwork: async () => new Response("x".repeat(513 * 1024)) },
      ),
    ).rejects.toThrow("512 KiB")
  } finally {
    if (old === undefined) delete process.env.MEMORY_FIXTURE_KEY
    else process.env.MEMORY_FIXTURE_KEY = old
  }
})
test("vector batches report coverage, reject denied/stale writes, and failures preserve keyword retrieval", async () => {
  const { memory } = await fixture()
  memory.options.config = {
    embedding: {
      url: "https://embedding.example/v1/embeddings",
      model: "fixture",
      keyEnvVar: "UNUSED_KEY",
      dimensions: 2,
    },
  }
  for (let i = 0; i < 18; i++) await memory.remember(`Parser fact ${i}`, signal())
  let calls = 0
  const run = async (_name: string, input: unknown) => {
    calls++
    const texts = (input as { texts: string[] }).texts
    expect(texts.length).toBeLessThanOrEqual(16)
    return {
      type: "tool_result" as const,
      toolCallId: "fixture",
      text: JSON.stringify({ vectors: texts.map(() => [1, 0]) }),
    }
  }
  expect(await memory.command("index", signal(), run)).toContain("2 remaining")
  expect(await memory.command("index", signal(), run)).toContain("0 remaining")
  expect(await memory.command("index", signal(), run)).toContain("complete: 18")
  expect(calls).toBe(2)
  expect((await memory.search("unrelated lexical term", signal(), run)).mode).toBe("hybrid")
  const failing = async () => ({
    type: "tool_result" as const,
    toolCallId: "fixture",
    text: "Network denied",
    isError: true,
  })
  const fallback = await memory.search("parser", signal(), failing)
  expect(fallback.mode).toBe("fallback")
  expect(fallback.reason).toContain("Network denied")
  expect(fallback.records.length).toBeGreaterThan(0)
  const readonly = new MemorySession({ ...memory.options, writable: () => false })
  await expect(readonly.command("index", signal(), run)).rejects.toThrow("writes require")
})
test("embedding interruption settles even if the transport ignores its abort signal", async () => {
  const { context } = await fixture(),
    abort = new AbortController(),
    old = process.env.MEMORY_FIXTURE_KEY
  process.env.MEMORY_FIXTURE_KEY = "fixture"
  try {
    const tool = embeddingTool({
      url: "https://embedding.example/v1",
      model: "fixture",
      keyEnvVar: "MEMORY_FIXTURE_KEY",
      dimensions: 2,
    })
    const pending = tool.run(
      { texts: ["query"] },
      { ...context, signal: abort.signal, fetchNetwork: () => new Promise(() => {}) },
    )
    abort.abort(new Error("foreground"))
    await expect(pending).rejects.toThrow("foreground")
  } finally {
    if (old === undefined) delete process.env.MEMORY_FIXTURE_KEY
    else process.env.MEMORY_FIXTURE_KEY = old
  }
})

test("explicit embedding credentials are redacted even with an unconventional environment name", async () => {
  const { memory } = await fixture(),
    old = process.env.VECTOR_AUTH
  process.env.VECTOR_AUTH = "opaque-embedding-canary-928472"
  try {
    const scoped = new MemorySession({
      ...memory.options,
      config: {
        embedding: {
          url: "https://embedding.example/v1",
          model: "fixture",
          keyEnvVar: "VECTOR_AUTH",
          dimensions: 2,
        },
      },
    })
    const fact = await scoped.remember(`Parser ${process.env.VECTOR_AUTH}`, signal())
    expect(fact.text).toBe("Parser [REDACTED]")
    expect(await scoped.command(`show ${fact.id}`, signal())).not.toContain("opaque-embedding-canary")
  } finally {
    if (old === undefined) delete process.env.VECTOR_AUTH
    else process.env.VECTOR_AUTH = old
  }
})
test("redaction affects candidate text without corrupting structured provenance identifiers", async () => {
  const { memory } = await fixture()
  const scoped = new MemorySession({
    ...memory.options,
    sanitize: (s) => clean(s).replace(/[0-9]/g, "[REDACTED]"),
  })
  expect(
    await maintainMemory({
      memory: scoped,
      messages,
      model,
      provider: provider((r) => success(r)),
      signal: signal(),
      action: "extract",
      onUsage: () => {},
    }),
  ).toContain("1 memory candidates saved")
  expect((await scoped.store(signal()))?.snapshot().records[0]?.sources[0]?.id).toMatch(/^[0-9a-f]{32}$/)
})
