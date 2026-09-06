import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "../../../src/core/index.ts"
import { compactMessages } from "../../../src/engines/codesplash/compaction.ts"
import {
  ContextTracker,
  compactionBoundary,
  estimateMessages,
  inspectContext,
  isContextOverflow,
  pruneToolResults,
  safeBoundaries,
} from "../../../src/engines/codesplash/context.ts"
import {
  type ChatMessage,
  type ModelInfo,
  type ProviderClient,
  ProviderHttpError,
  type ProviderRequest,
  type ProviderStreamEvent,
} from "../../../src/engines/codesplash/contracts.ts"
import {
  CodesplashEventFactory,
  CodesplashLoop,
  type TurnRequest,
} from "../../../src/engines/codesplash/loop.ts"
import { readToolOutputTool, ToolOutputStore } from "../../../src/engines/codesplash/tool-output-store.ts"
import { createToolRegistry } from "../../../src/engines/codesplash/tools/registry.ts"
import {
  appendTranscriptMessages,
  loadTranscript,
  writeTranscriptSnapshot,
} from "../../../src/engines/codesplash/transcript.ts"

const MODEL: ModelInfo = {
  id: "test",
  displayName: "Test",
  provider: "anthropic",
  protocol: "anthropic",
  contextWindow: 20_000,
  maxOutputTokens: 1000,
  isDefault: true,
  supportsReasoning: false,
  pricing: { inputPerMTok: 1, outputPerMTok: 1 },
}
const user = (text: string): ChatMessage => ({ role: "user", content: [{ type: "text", text }] })
const assistant = (text: string): ChatMessage => ({ role: "assistant", content: [{ type: "text", text }] })
const history = (count = 20): ChatMessage[] =>
  Array.from({ length: count }, (_, i) =>
    i % 2 ? assistant(`Evidence ${i}: ${"x".repeat(1500)}`) : user(`Task ${i}: ${"y".repeat(1500)}`),
  )
const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "codesplash-context-"))
  dirs.push(dir)
  return dir
}
function provider(
  handler?: (request: ProviderRequest, signal: AbortSignal) => AsyncIterable<ProviderStreamEvent>,
) {
  const requests: ProviderRequest[] = []
  const client: ProviderClient = {
    id: "anthropic",
    models: [MODEL],
    stream(request, signal) {
      requests.push(request)
      return handler
        ? handler(request, signal)
        : (async function* () {
            yield {
              type: "text_delta",
              text: "Task: finish the implementation. Evidence: files inspected. Next: run the tests.",
            } as const
            yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } } as const
            yield { type: "done", stopReason: "end_turn" } as const
          })()
    },
  }
  return { client, requests }
}
function compact(
  client: ProviderClient,
  messages = history(),
  extra: Partial<Parameters<typeof compactMessages>[0]> = {},
) {
  return compactMessages({
    provider: client,
    model: MODEL,
    messages,
    keepTokens: 2000,
    signal: new AbortController().signal,
    sanitize: (text) => text,
    onUsage: () => {},
    ...extra,
  })
}
function loop(
  client: ProviderClient,
  options: Partial<ConstructorParameters<typeof CodesplashLoop>[0]> = {},
) {
  const events: AgentEvent[] = []
  const instance = new CodesplashLoop({
    cwd: "/tmp",
    policy: { sandbox: "read-only", approvalPolicy: "on-request" },
    registry: createToolRegistry([readToolOutputTool]),
    events: new CodesplashEventFactory("test"),
    emit: (event) => events.push(event),
    ...options,
  })
  const request: TurnRequest = {
    provider: client,
    model: MODEL,
    system: "Coding assistant",
    userText: "Continue with the tests",
    userContent: [{ type: "text", text: "Continue with the tests" }],
  }
  return { instance, request, events }
}

describe("context estimates and boundaries", () => {
  test("reserves actual output capacity and handles impossible windows", () => {
    const value = inspectContext(MODEL, "system", [], history(2))
    expect(value.outputReserve).toBe(1000)
    expect(value.inputBudget).toBe(17_000)
    expect(value.totalTokens).toBe(value.systemTokens + value.toolTokens + value.messageTokens)
    expect(inspectContext({ ...MODEL, maxOutputTokens: 30_000 }, "", [], []).inputBudget).toBe(0)
  })
  test("cuts outside complete multi-call exchanges and rejects malformed pairings", () => {
    const messages: ChatMessage[] = [
      user("task"),
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "a", name: "read", input: {} },
          { type: "tool_call", id: "b", name: "read", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolCallId: "a", text: "a" },
          { type: "tool_result", toolCallId: "b", text: "b" },
        ],
      },
      assistant("done"),
      user("next"),
    ]
    expect(safeBoundaries(messages)).toEqual([1, 3, 4])
    expect(compactionBoundary(messages, 1000)).toBe(4)
    expect(safeBoundaries(messages.slice(0, 2))).toEqual([])
    expect(safeBoundaries(messages.slice(2))).toEqual([])
  })
  test("prunes old results without touching the latest two or mutating source", () => {
    const messages: ChatMessage[] = Array.from({ length: 4 }, (_, i) => ({
      role: "user",
      content: [{ type: "tool_result", toolCallId: String(i), text: "z".repeat(8000), isError: true }],
    }))
    const pruned = pruneToolResults(messages)
    expect(estimateMessages(pruned)).toBeLessThan(estimateMessages(messages))
    expect(pruned.slice(-2)).toEqual(messages.slice(-2))
    expect(JSON.stringify(messages)).not.toContain("truncated")
    expect(pruned[0]?.content[0]).toMatchObject({ toolCallId: "0", isError: true })
  })
  test("calibrates actual input and resets on prefix/epoch changes without retaining prompt text", () => {
    const tracker = new ContextTracker()
    const request: ProviderRequest = {
      model: MODEL,
      system: "secret prompt",
      tools: [],
      messages: history(2),
    }
    const first = tracker.inspect(request)
    tracker.observe(first.totalTokens * 2, first.totalTokens)
    expect(tracker.inspect(request).totalTokens).toBe(first.totalTokens * 2)
    expect(tracker.inspect({ ...request, system: "changed" }).prefixChanges).toEqual(["system"])
    tracker.reset()
    expect(tracker.inspect(request).observedInputTokens).toBeUndefined()
    expect(tracker.epoch).toBe(1)
    expect(JSON.stringify(tracker)).not.toContain("secret prompt")
  })
  test("only recognizes input/context overflow responses", () => {
    expect(isContextOverflow(new ProviderHttpError("context_length_exceeded", 400))).toBe(true)
    expect(isContextOverflow(new ProviderHttpError("prompt is too long", 413))).toBe(true)
    for (const error of [
      new ProviderHttpError("bad schema", 400),
      new ProviderHttpError("maximum context", 401),
      new Error("context length"),
      new ProviderHttpError("max_tokens", 400),
    ])
      expect(isContextOverflow(error)).toBe(false)
  })
})

describe("transactional summarization", () => {
  test("reduces old context, preserves the latest task and makes no tool-capable requests", async () => {
    const fake = provider()
    const messages = [...history(), user("Keep tests offline; finish the parser")]
    const result = await compact(fake.client, messages)
    expect(result.at(-1)).toEqual(messages.at(-1))
    expect(estimateMessages(result)).toBeLessThan(estimateMessages(messages))
    expect(
      fake.requests.every((request) => request.tools.length === 0 && request.reasoningEffort === undefined),
    ).toBe(true)
    expect(messages).toHaveLength(21)
  })
  test("split turns carry the original user request verbatim", async () => {
    const messages = [
      user("DO NOT publish"),
      ...Array.from({ length: 20 }, () => assistant("evidence ".repeat(400))),
    ]
    const result = await compact(provider().client, messages)
    expect(result).toContainEqual(user("DO NOT publish"))
    expect(result.at(-1)).toEqual(messages.at(-1))
  })
  test("bounded chunks carry the previous summary and account for every request", async () => {
    const fake = provider()
    const usage: unknown[] = []
    await compact(fake.client, history(60), { onUsage: (value) => usage.push(value) })
    expect(fake.requests.length).toBeGreaterThan(1)
    expect(fake.requests.length).toBeLessThanOrEqual(4)
    expect(usage).toHaveLength(fake.requests.length)
    expect(JSON.stringify(fake.requests[1]?.messages)).toContain("Previous handoff")
  })
  test("refuses excessive chunk counts before spending any requests", async () => {
    const fake = provider()
    await expect(compact(fake.client, history(500))).rejects.toThrow("four-request limit")
    expect(fake.requests).toHaveLength(0)
  })
  test("does not send oversized individual messages or drop their contents", async () => {
    const fake = provider()
    await expect(
      compact(fake.client, [user("z".repeat(300_000)), assistant("answer"), user("next")]),
    ).rejects.toThrow("too large")
    expect(fake.requests).toHaveLength(0)
  })
  test("truncated, empty and tool-call summaries preserve input", async () => {
    for (const events of [
      [{ type: "done", stopReason: "end_turn" }],
      [
        { type: "text_delta", text: "cut" },
        { type: "done", stopReason: "max_tokens" },
      ],
      [{ type: "tool_call", id: "x", name: "bash", input: { command: "touch bad" } }],
    ] as ProviderStreamEvent[][]) {
      const fake = provider(async function* () {
        yield* events
      })
      const messages = history()
      const copy = structuredClone(messages)
      await expect(compact(fake.client, messages)).rejects.toThrow()
      expect(messages).toEqual(copy)
    }
  })
  test("timeout releases an unresponsive adapter and accounts for usage already emitted", async () => {
    const usage: unknown[] = []
    const fake = provider(async function* () {
      yield { type: "usage", usage: { inputTokens: 99 } }
      await new Promise(() => {})
    })
    await expect(
      compact(fake.client, history(), { timeoutMs: 20, onUsage: (value) => usage.push(value) }),
    ).rejects.toThrow("timed out")
    expect(usage).toEqual([{ inputTokens: 99 }])
  })
  test("interrupt releases summary without changing history", async () => {
    const abort = new AbortController()
    const fake = provider(async function* () {
      abort.abort(new Error("cancelled"))
      await new Promise(() => {})
    })
    await expect(compact(fake.client, history(), { signal: abort.signal })).rejects.toThrow("cancelled")
  })
})

describe("loop integration", () => {
  test("auto compaction preserves the new request and folds summary costs into usage", async () => {
    const fake = provider()
    const { instance, request, events } = loop(fake.client)
    instance.seedHistory(history(60))
    await instance.runTurn(request)
    expect(events.filter((e) => e.kind === "turn.completed").at(-1)?.payload).toMatchObject({
      status: "completed",
    })
    expect(fake.requests.length).toBeGreaterThan(1)
    expect(instance.historyRevision).toBeGreaterThan(0)
    expect(JSON.stringify(fake.requests.at(-1)?.messages)).toContain("Continue with the tests")
    const usage = events.filter((e) => e.kind === "usage.updated").at(-1)
    expect(usage?.payload).toMatchObject({
      inputTokens: fake.requests.length * 100,
      outputTokens: fake.requests.length * 20,
    })
  })
  test("disabled auto-compaction refuses an oversized request without provider calls", async () => {
    const fake = provider()
    const { instance, request, events } = loop(fake.client, { context: { autoCompact: false } })
    instance.seedHistory(history(60))
    await instance.runTurn(request)
    expect(fake.requests).toHaveLength(0)
    expect(events.some((e) => e.kind === "error" && e.payload.message.includes("/compact"))).toBe(true)
  })
  test("recovers zero-event overflow once and never executes tools during the retry", async () => {
    let normal = 0
    const fake = provider(async function* (request) {
      if (request.tools.length && ++normal === 1) throw new ProviderHttpError("context_length_exceeded", 400)
      yield { type: "text_delta", text: "Summary or final answer" }
      yield { type: "done", stopReason: "end_turn" }
    })
    const { instance, request, events } = loop(fake.client)
    instance.seedHistory(history(12))
    await instance.runTurn(request)
    expect(normal).toBe(2)
    expect(events.some((e) => e.kind === "item.updated")).toBe(false)
    expect(events.filter((e) => e.kind === "turn.completed").at(-1)?.payload).toMatchObject({
      status: "completed",
    })
  })
  test("manual failure releases admission for another turn", async () => {
    const fake = provider()
    const { instance, request } = loop(fake.client)
    await expect(instance.compact(request)).rejects.toThrow("No complete")
    expect(instance.isTurnActive).toBe(false)
    await instance.runTurn(request)
    expect(instance.history).toHaveLength(2)
  })
})

describe("persistence and retained output", () => {
  test("atomic compact snapshot replaces native context while remaining v1 compatible", async () => {
    const path = join(await temp(), "native.jsonl")
    await appendTranscriptMessages(path, history(10))
    const snapshot = [user("summary"), assistant("recent")]
    await writeTranscriptSnapshot(path, snapshot)
    await appendTranscriptMessages(path, [user("next")])
    expect(await loadTranscript(path)).toEqual([...snapshot, user("next")])
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
  test("failed snapshot rename cleans temporary file without damaging destination", async () => {
    const dir = await temp()
    const path = join(dir, "existing-directory")
    await mkdir(path)
    await expect(writeTranscriptSnapshot(path, history(2))).rejects.toThrow()
    expect(await readdir(dir)).toEqual(["existing-directory"])
  })
  test("retained output is paged and reloadable, with ids confined to its session", async () => {
    const dir = join(await temp(), "outputs")
    const source = `start\n${"evidence 🐬\n".repeat(2500)}end`
    const short = await new ToolOutputStore(dir).retain(source)
    const id = short.match(/Retained output: ([a-f0-9-]+)/)?.[1]
    expect(id).toBeDefined()
    expect(Buffer.byteLength(short)).toBeLessThanOrEqual(8192)
    const store = new ToolOutputStore(dir)
    expect(await store.read({ id, offset: 0 })).toContain("start")
    await expect(store.read({ id: "../../native.jsonl" })).rejects.toThrow("Invalid output id")
    await expect(new ToolOutputStore().read({ id })).rejects.toThrow("unavailable")
  })
  test("no-history output stays in memory and obeys the retention cap", async () => {
    const store = new ToolOutputStore()
    const first = await store.retain("a".repeat(100_000))
    const id = first.match(/Retained output: ([a-f0-9-]+)/)?.[1]
    for (let i = 0; i < 170; i++) await store.retain("b".repeat(100_000))
    await expect(store.read({ id })).rejects.toThrow("expired")
  })
  test("does not load symlinks as output references", async () => {
    const dir = await temp()
    const target = join(dir, "source")
    await Bun.write(target, "PRIVATE")
    const outputs = join(dir, "outputs")
    await mkdir(outputs)
    const id = crypto.randomUUID()
    await symlink(target, join(outputs, id))
    await expect(new ToolOutputStore(outputs).read({ id })).rejects.toThrow("unavailable")
    expect(await readFile(target, "utf8")).toBe("PRIVATE")
  })
})
