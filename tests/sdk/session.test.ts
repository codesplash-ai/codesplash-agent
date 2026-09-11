import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventFeed } from "../../src/sdk/event-feed.ts"
import {
  type CreateAgentSessionOptions,
  createAgentSession,
  type ExtensionProvider,
  extensionToolId,
} from "../../src/sdk/index.ts"

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sdk-test-")))
  await mkdir(join(root, "config"))
  const options: CreateAgentSessionOptions = {
    cwd: root,
    trustDataDirectory: join(root, "data"),
    config: { path: join(root, "config", "config.toml"), overrides: ["memory.enabled=false"] },
    model: "ext_sdk_local/model",
  }
  return { root, options, close: () => rm(root, { recursive: true, force: true }) }
}
const provider = (text = "SDK fixture"): ExtensionProvider => ({
  name: "local",
  displayName: "Local",
  protocol: "openai",
  models: [
    {
      id: "model",
      displayName: "Local",
      contextWindow: 32768,
      maxOutputTokens: 1024,
      isDefault: true,
      supportsReasoning: false,
    },
  ],
  async *stream() {
    yield { type: "text_delta", text }
    yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: "done", stopReason: "end_turn" }
  },
})

test("SDK owns independent sessions, isolates observers, records and resumes with monotonic usage", async () => {
  const f = await fixture()
  try {
    const a = await createAgentSession({
      ...f.options,
      providers: [provider("first")],
      persistence: { root: join(f.root, "sessions") },
      async onEvent() {
        throw new Error("observer")
      },
    })
    const b = await createAgentSession({ ...f.options, providers: [provider("second")] })
    try {
      expect((await a.prompt("one")).status).toBe("completed")
      expect((await b.prompt("two")).status).toBe("completed")
      expect(a.usage.inputTokens).toBe(4)
      expect(JSON.stringify(a.state.transcript)).toContain("first")
      expect(JSON.stringify(b.state.transcript)).toContain("second")
      await expect(
        createAgentSession({
          ...f.options,
          providers: [provider()],
          persistence: { root: join(f.root, "sessions"), resume: a.id },
        }),
      ).rejects.toThrow()
    } finally {
      await Promise.all([a.close(), b.close()])
    }
    const resumed = await createAgentSession({
      ...f.options,
      providers: [provider("resumed")],
      persistence: { root: join(f.root, "sessions"), resume: a.id },
    })
    try {
      expect(JSON.stringify(resumed.state.transcript)).toContain("first")
      expect((await resumed.prompt("three")).status).toBe("completed")
      expect(resumed.usage.inputTokens).toBe(8)
    } finally {
      await resumed.close()
    }
  } finally {
    await f.close()
  }
})

test("SDK injected tools require native approval, stream progress and redact provider credentials", async () => {
  const f = await fixture()
  let calls = 0
  try {
    for (const allow of [false, true]) {
      const events: string[] = []
      const p = provider()
      p.auth = async () => "sdk-fixture-secret"
      p.stream = async function* (request, { credential }) {
        if (!request.messages.some((m) => m.content.some((b) => b.type === "tool_result"))) {
          yield { type: "tool_call", id: "call", name: extensionToolId("sdk", "write"), input: {} }
          yield { type: "done", stopReason: "tool_use" }
        } else {
          yield { type: "text_delta", text: `done ${credential}` }
          yield { type: "done", stopReason: "end_turn" }
        }
      }
      const session = await createAgentSession({
        ...f.options,
        workspaceTrusted: true,
        providers: [p],
        tools: [
          {
            name: "write",
            description: "Write",
            inputSchema: { type: "object", additionalProperties: false },
            effects: "workspace",
            targets: () => ({ paths: [join(f.root, "result")] }),
            async run(_, ctx) {
              calls++
              ctx.progress("progress")
              await writeFile(join(f.root, "result"), "ok")
              return { text: "ok", label: "Written", mutatedPaths: [join(f.root, "result")] }
            },
          },
        ],
        respond: allow ? async () => ({ choice: "accept" }) : undefined,
        onEvent: (e) => events.push(JSON.stringify(e)),
      })
      try {
        await session.prompt("write")
        expect(calls).toBe(allow ? 1 : 0)
        expect(events.join("\n")).not.toContain("sdk-fixture-secret")
        if (allow) expect(events.join("\n")).toContain("progress")
      } finally {
        await session.close()
      }
    }
  } finally {
    await f.close()
  }
})

test("SDK managed constraints, disabled history and failed-open factory cleanup stay enforced", async () => {
  const f = await fixture()
  let cleaned = 0
  try {
    await writeFile(join(f.root, "config", "managed.toml"), "[constraints]\nextensionIds=[]\n")
    await expect(createAgentSession({ ...f.options, providers: [provider()] })).rejects.toThrow("managed")
    await writeFile(join(f.root, "config", "managed.toml"), "[required.history]\nenabled=false\n")
    await expect(
      createAgentSession({
        ...f.options,
        providers: [provider()],
        persistence: { root: join(f.root, "sessions") },
      }),
    ).rejects.toThrow("disabled")
    await writeFile(join(f.root, "config", "managed.toml"), "")
    await expect(
      createAgentSession({
        ...f.options,
        extensions: [
          {
            id: "owner",
            factory() {
              return () => {
                cleaned++
              }
            },
          },
        ],
        model: "unknown/model",
      }),
    ).rejects.toThrow()
    expect(cleaned).toBe(1)
  } finally {
    await f.close()
  }
})

test("SDK interruption and close settle a waiting responder and revoke late host work", async () => {
  const f = await fixture()
  let signal: AbortSignal | undefined
  try {
    const p = provider()
    p.stream = async function* () {
      yield { type: "tool_call", id: "call", name: extensionToolId("sdk", "ask"), input: {} }
      yield { type: "done", stopReason: "tool_use" }
    }
    const session = await createAgentSession({
      ...f.options,
      workspaceTrusted: true,
      providers: [p],
      tools: [
        {
          name: "ask",
          description: "Ask",
          effects: "external",
          inputSchema: { type: "object" },
          async run() {
            throw new Error("must not execute")
          },
        },
      ],
      respond: async (_, s) => {
        signal = s
        return new Promise(() => {})
      },
    })
    const ack = await session.submit({ text: "ask" })
    if (!ack) throw new Error("missing ack")
    for (let i = 0; i < 100 && !signal; i++) await Bun.sleep(10)
    expect(signal).toBeDefined()
    const waiter = session.waitForInput(ack.id).catch(() => undefined)
    await Promise.all([session.close(), session.close()])
    await waiter
    expect(signal?.aborted).toBe(true)
  } finally {
    await f.close()
  }
})

test("event feeds bound buffering and fail only the slow consumer", async () => {
  let disposed = 0
  const feed = new EventFeed(() => disposed++)
  const event = {
    schemaVersion: 1,
    kind: "warning",
    payload: { message: "x" },
    engine: "codesplash",
    localSessionId: "fixture",
    sequence: 0,
    timestamp: new Date().toISOString(),
  } as const
  for (let i = 0; i < 1025; i++) feed.push(event)
  await expect(feed.next()).rejects.toThrow("overflow")
  expect(disposed).toBe(1)
})

test("SDK resumes pending inputs only after explicit review and preserves non-bypass mode", async () => {
  const f = await fixture()
  try {
    const persistence = { root: join(f.root, "sessions") }
    const first = await createAgentSession({
      ...f.options,
      config: { ...f.options.config, overrides: ['permissions.mode="plan"', "memory.enabled=false"] },
      providers: [provider()],
      persistence,
    })
    first.inputs.pause(first.queue.revision)
    const ack = await first.submit({ text: "Held prompt" })
    expect(ack).toBeDefined()
    await first.close()
    const resumed = await createAgentSession({
      ...f.options,
      providers: [provider()],
      persistence: { ...persistence, resume: first.id },
    })
    try {
      expect(resumed.queue.paused).toBe(true)
      expect(resumed.queue.items.find((item) => item.id === ack?.id)?.status).toBe("blocked")
      await expect(resumed.prompt("should not enqueue")).rejects.toThrow("paused")
      resumed.inputs.resume(resumed.queue.revision)
      expect((await resumed.waitForInput(ack?.id ?? "")).status).toBe("completed")
      expect(resumed.state.permissionMode).toBe("plan")
    } finally {
      await resumed.close()
    }
  } finally {
    await f.close()
  }
})

test("SDK startup abort closes a late factory and releases recording ownership", async () => {
  const f = await fixture(),
    abort = new AbortController()
  let entered = () => {},
    release = () => {},
    cleaned = 0
  const started = new Promise<void>((resolve) => {
      entered = resolve
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve
    })
  try {
    const opening = createAgentSession({
      ...f.options,
      providers: [provider()],
      signal: abort.signal,
      persistence: { root: join(f.root, "sessions") },
      extensions: [
        {
          id: "slow",
          async factory() {
            entered()
            await gate
            return () => {
              cleaned++
            }
          },
        },
      ],
    })
    await started
    abort.abort(new Error("cancelled startup"))
    release()
    await expect(opening).rejects.toThrow("cancelled startup")
    expect(cleaned).toBe(1)
  } finally {
    release()
    await f.close()
  }
})

test("SDK concurrent prompt results correlate with their own input IDs", async () => {
  const f = await fixture()
  try {
    const session = await createAgentSession({ ...f.options, providers: [provider()] })
    try {
      const results = await Promise.all([session.prompt("first"), session.prompt("second")])
      expect(new Set(results.map((result) => result.id)).size).toBe(2)
      expect(results.map((result) => result.status)).toEqual(["completed", "completed"])
      expect(session.usage.inputTokens).toBe(8)
      const feeds = Array.from({ length: 8 }, () => session.events())
      expect(() => session.events()).toThrow("limit")
      for (const feed of feeds) await feed.return?.()
      await session.events().return?.()
    } finally {
      await session.close()
    }
  } finally {
    await f.close()
  }
})

test("SDK invalid form responses fall back to cancellation without stranding a command", async () => {
  const f = await fixture()
  try {
    const session = await createAgentSession({
      ...f.options,
      providers: [provider()],
      interactive: true,
      respond: async () => ({ choice: "accept", data: { count: "invalid" } }),
      extensions: [
        {
          id: "dialog",
          factory(api) {
            api.registerCommand({
              name: "ask",
              description: "Ask",
              async run() {
                return JSON.stringify(
                  await api.ui.dialog({
                    message: "Count",
                    fields: [{ name: "count", label: "Count", type: "number", required: true }],
                  }),
                )
              },
            })
          },
        },
      ],
    })
    try {
      expect(JSON.stringify(await session.extensionsCommand("run dialog/ask"))).toContain("cancel")
      expect((await session.prompt("Still usable")).status).toBe("completed")
    } finally {
      await session.close()
    }
  } finally {
    await f.close()
  }
})
