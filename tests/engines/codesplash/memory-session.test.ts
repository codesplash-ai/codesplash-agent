import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentEvent, defaultConfig, type EngineSession } from "../../../src/core/index.ts"
import type {
  ProviderClient,
  ProviderRequest,
  ProviderStreamEvent,
} from "../../../src/engines/codesplash/contracts.ts"
import { CodesplashDriver } from "../../../src/engines/codesplash/engine.ts"
import { createProfile } from "../../../src/engines/codesplash/sandbox/profile.ts"
import { NativeSandbox } from "../../../src/engines/codesplash/sandbox/runtime.ts"

const sessions: EngineSession[] = [],
  roots: string[] = []
const oldData = process.env.CODESPLASH_AGENT_DATA_DIR,
  oldConfig = process.env.CODESPLASH_AGENT_CONFIG_DIR
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close()
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
  if (oldData === undefined) delete process.env.CODESPLASH_AGENT_DATA_DIR
  else process.env.CODESPLASH_AGENT_DATA_DIR = oldData
  if (oldConfig === undefined) delete process.env.CODESPLASH_AGENT_CONFIG_DIR
  else process.env.CODESPLASH_AGENT_CONFIG_DIR = oldConfig
})
async function fixture(
  handler?: (r: ProviderRequest, s: AbortSignal) => AsyncIterable<ProviderStreamEvent>,
  autoLearn = false,
) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "memory-session-")))
  roots.push(cwd)
  process.env.CODESPLASH_AGENT_DATA_DIR = join(cwd, "data")
  process.env.CODESPLASH_AGENT_CONFIG_DIR = join(cwd, "config")
  const config = structuredClone(defaultConfig)
  config.memory = { autoLearn }
  config.providers = [
    {
      id: "fixture",
      protocol: "openai",
      baseUrl: "http://127.0.0.1:1",
      displayName: "Fixture",
      keyEnvVar: "UNUSED_MEMORY_KEY",
      requiresKey: false,
      models: [
        {
          id: "fixture",
          displayName: "Fixture",
          contextWindow: 100000,
          maxOutputTokens: 2048,
          isDefault: true,
          supportsReasoning: false,
          pricing: { inputPerMTok: 1, outputPerMTok: 2 },
        },
      ],
    },
  ]
  const requests: ProviderRequest[] = [],
    events: AgentEvent[] = []
  const provider: ProviderClient = {
    id: "openai",
    models: [],
    stream(request, signal) {
      requests.push(request)
      return handler
        ? handler(request, signal)
        : (async function* () {
            yield { type: "text_delta", text: "Done" } as const
            yield { type: "done", stopReason: "end_turn" } as const
          })()
    },
  }
  const driver = new CodesplashDriver({
    config,
    providers: { fixture: provider },
    sandbox: async (options) =>
      new NativeSandbox(createProfile(cwd, options.policy?.sandbox ?? "workspace-write", config.sandbox)),
  })
  const open = async (noHistory = false, readonly = false) => {
    const session = await driver.openSession({
      cwd,
      localSessionId: crypto.randomUUID(),
      model: "fixture",
      workspaceTrusted: true,
      policy: { sandbox: readonly ? "read-only" : "workspace-write", approvalPolicy: "on-request" },
      nativeTranscriptPath: noHistory
        ? undefined
        : join(cwd, "state", crypto.randomUUID(), "transcript.jsonl"),
    })
    sessions.push(session)
    void (async () => {
      for await (const e of session.events) events.push(e)
    })()
    if (!session.memoryCommand || !session.inspectContext || !session.setPermissionMode || !session.setModel)
      throw new Error("Missing native memory controls")
    return Object.assign(session, {
      memoryCommand: session.memoryCommand,
      inspectContext: session.inspectContext,
      setPermissionMode: session.setPermissionMode,
      setModel: session.setModel,
    })
  }
  return { cwd, open, events, requests }
}
async function settled(f: { events: AgentEvent[] }, session: EngineSession, text: string) {
  const count = f.events.filter((e) => e.kind === "turn.completed").length
  await session.send({ text })
  for (let i = 0; i < 1000; i++) {
    if (f.events.filter((e) => e.kind === "turn.completed").length > count) {
      await Bun.sleep(5)
      const error = f.events.findLast((e) => e.kind === "error")
      if (error) throw new Error(JSON.stringify(error.payload))
      return
    }
    await Bun.sleep(2)
  }
  throw new Error("Turn timed out")
}
test("remember survives reopening, appears in budgeted prompt, and forget removes it from subsequent requests", async () => {
  const f = await fixture(),
    first = await f.open()
  const response = await first.memoryCommand("remember Parser uses committed manifests")
  const id = response.split(" ").at(-1) ?? "missing-id"
  await first.close()
  const second = await f.open()
  await settled(f, second, "Explain the parser")
  expect(f.requests.at(-1)?.system).toContain("Remembered reference facts")
  expect(f.requests.at(-1)?.system).toContain("Parser uses committed manifests")
  expect((await second.inspectContext()).memoryTokens).toBeGreaterThan(0)
  await second.memoryCommand(`forget ${id}`)
  expect((await second.inspectContext()).memoryTokens).toBe(0)
  await settled(f, second, "Explain parser again")
  expect(f.requests.at(-1)?.system).not.toContain("Parser uses committed manifests")
  const hidden = f.requests.at(-1)?.tools.map((t) => t.name) ?? []
  expect(hidden).toContain("memory_search")
  expect(hidden).toContain("session_notes")
  expect(hidden).not.toContain("memory_embed")
})
test("no-history disables durable retrieval; plan and read-only permit retrieval but refuse edits", async () => {
  const f = await fixture(),
    one = await f.open()
  await one.memoryCommand("remember Parser memory canary")
  const noHistory = await f.open(true)
  await expect(noHistory.memoryCommand("remember forbidden")).rejects.toThrow()
  await settled(f, noHistory, "Parser")
  expect(f.requests.at(-1)?.system).not.toContain("Parser memory canary")
  const readonly = await f.open(false, true)
  await expect(readonly.memoryCommand("remember forbidden")).rejects.toThrow()
  await settled(f, readonly, "Parser")
  expect(f.requests.at(-1)?.system).toContain("Parser memory canary")
  await one.setPermissionMode("plan")
  await expect(one.memoryCommand("remember forbidden")).rejects.toThrow()
  expect(await one.memoryCommand("search parser")).toContain("Parser memory canary")
})
test("foreground model change cancels and settles a noncooperative idle learner; shutdown leaves no candidate", async () => {
  let learning: AbortSignal | undefined
  const f = await fixture((r, s) => {
    if (r.system.includes("Extract durable")) {
      learning = s
      return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }
    }
    return (async function* () {
      yield { type: "text_delta", text: "A useful durable parser observation" } as const
      yield { type: "done", stopReason: "end_turn" } as const
    })()
  }, true)
  const session = await f.open()
  await settled(f, session, "Remember how the parser works")
  for (let i = 0; i < 500 && !learning; i++) await Bun.sleep(2)
  expect(learning).toBeDefined()
  const start = Date.now()
  await session.setModel("fixture")
  expect(learning?.aborted).toBe(true)
  expect(Date.now() - start).toBeLessThan(1000)
  expect(await session.memoryCommand("list")).toContain("No memories")
  await session.close()
  expect(await readdir(join(f.cwd, "data", "memory")).catch(() => [])).toEqual([])
})

test("generated title shares learner ownership; manual rename cancels it and close settles without late writes", async () => {
  let generating: AbortSignal | undefined
  const f = await fixture((request, signal) => {
    if (request.system.includes("Summarize the reference")) {
      generating = signal
      return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }
    }
    return (async function* () {
      yield { type: "text_delta", text: "Parser fixed" } as const
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } } as const
      yield { type: "done", stopReason: "end_turn" } as const
    })()
  })
  const session = await f.open(true)
  await settled(f, session, "Fix the parser")
  if (!session.sessionPresentation) throw new Error("Missing presentation controls")
  const pending = session.sessionPresentation({ action: "rename", generate: true })
  const failed = pending.catch((error) => error)
  for (let n = 0; n < 100 && !generating; n++) await Bun.sleep(2)
  expect(generating).toBeDefined()
  expect(await session.sessionPresentation({ action: "rename", title: "My title" })).toBe("My title")
  expect(((await failed) as Error).message).toContain("interrupted")
  expect(generating?.aborted).toBe(true)
  expect(await session.sessionPresentation({ action: "info" })).toMatchObject({
    title: "My title",
    manualTitle: true,
    persistence: "memory only",
    usage: { cumulative: { hasUnpricedUsage: true } },
  })
  generating = undefined
  const closing = session.sessionPresentation({ action: "recap", generate: true })
  const closed = closing.catch((error) => error)
  for (let n = 0; n < 100 && !generating; n++) await Bun.sleep(2)
  await session.close()
  expect(await closed).toBeInstanceOf(Error)
  expect((generating as AbortSignal | undefined)?.aborted).toBe(true)
})
