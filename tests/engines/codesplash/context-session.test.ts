import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type AgentEvent,
  defaultConfig,
  type EngineSession,
  loadConfig,
  saveConfig,
  validateConfig,
} from "../../../src/core/index.ts"
import type {
  ChatMessage,
  ProviderClient,
  ProviderRequest,
  ProviderStreamEvent,
} from "../../../src/engines/codesplash/contracts.ts"
import { CodesplashDriver } from "../../../src/engines/codesplash/engine.ts"
import { appendTranscriptMessages, loadTranscript } from "../../../src/engines/codesplash/transcript.ts"

const directories: string[] = []
const sessions: EngineSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})
const user = (text: string): ChatMessage => ({ role: "user", content: [{ type: "text", text }] })
async function fixture(
  handler?: (request: ProviderRequest, signal: AbortSignal) => AsyncIterable<ProviderStreamEvent>,
  noHistory = false,
) {
  const cwd = await mkdtemp(join(tmpdir(), "codesplash-context-session-"))
  directories.push(cwd)
  const path = join(cwd, "state", "native.jsonl")
  const seed: ChatMessage[] = [
    user("Never publish; implement parser"),
    { role: "assistant", content: [{ type: "text", text: "evidence ".repeat(2500) }] },
    user("Continue"),
  ]
  if (!noHistory) await appendTranscriptMessages(path, seed)
  const config = structuredClone(defaultConfig)
  config.providers = [
    {
      id: "test-context",
      protocol: "anthropic",
      baseUrl: "http://127.0.0.1:1",
      displayName: "Test",
      keyEnvVar: "CONTEXT_TEST_UNUSED",
      requiresKey: false,
      models: [
        {
          id: "context-fixture",
          displayName: "Fixture",
          contextWindow: 100_000,
          maxOutputTokens: 2048,
          isDefault: true,
          supportsReasoning: false,
        },
      ],
    },
  ]
  const requests: ProviderRequest[] = []
  const provider: ProviderClient = {
    id: "anthropic",
    models: [],
    stream(request, signal) {
      requests.push(request)
      return handler
        ? handler(request, signal)
        : (async function* () {
            yield {
              type: "text_delta",
              text: "The parser is implemented. Verify it offline. Do not publish.",
            } as const
            yield { type: "done", stopReason: "end_turn" } as const
          })()
    },
  }
  const driver = new CodesplashDriver({
    config,
    providers: { "test-context": provider },
    sandbox: async () => ({
      profile: {
        version: 1,
        hash: "test",
        cwd,
        mode: "read-only",
        readRoots: [cwd],
        writeRoots: [],
        protectedPaths: [],
        deniedReadPaths: [],
        allowedHosts: [],
        environment: [],
      },
      runTool: async () => {
        throw new Error("A summary must not execute tools")
      },
      execute: async () => {
        throw new Error("No execution")
      },
      validateGrant: (grant) => grant,
      grant: () => {},
      endTurn: () => {},
      close: async () => {},
      sanitize: (text) => text.replaceAll("CANARY", "[REDACTED]"),
    }),
  })
  const events: AgentEvent[] = []
  async function open() {
    const session = await driver.openSession({
      cwd,
      localSessionId: crypto.randomUUID(),
      model: "context-fixture",
      workspaceTrusted: false,
      nativeTranscriptPath: noHistory ? undefined : path,
    })
    sessions.push(session)
    void (async () => {
      for await (const event of session.events) events.push(event)
    })()
    return session
  }
  return { cwd, path, seed, requests, events, open }
}
async function settle(session: EngineSession) {
  for (let i = 0; i < 100; i++) {
    try {
      await session.inspectContext?.()
      return
    } catch {
      await Bun.sleep(2)
    }
  }
  throw new Error("Session did not release admission")
}

test("manual compaction persists a v1 snapshot and resume sees it without duplicate turn messages", async () => {
  const f = await fixture()
  const session = await f.open()
  const before = await session.inspectContext?.()
  expect(f.requests).toHaveLength(0)
  await session.compact?.("Keep the publication restriction")
  const compacted = await loadTranscript(f.path)
  expect(JSON.stringify(compacted)).toContain("Generated summary")
  expect((await session.inspectContext?.())?.messageTokens).toBeLessThan(before?.messageTokens ?? 0)
  expect(f.events.some((event) => event.kind === "user.message")).toBe(false)
  await session.send({ text: "next task" })
  await settle(session)
  const stored = await loadTranscript(f.path)
  expect(stored).toHaveLength(compacted.length + 2)
  await session.close()
  const resumed = await f.open()
  expect((await resumed.inspectContext?.())?.messageCount).toBe(stored.length)
})

test("failed compaction persistence forces full recovery on the next turn", async () => {
  const f = await fixture()
  const session = await f.open()
  await rename(f.path, `${f.path}.backup`)
  await mkdir(f.path)
  await session.compact?.()
  expect(
    f.events.some((event) => event.kind === "warning" && event.payload.message.includes("Could not persist")),
  ).toBe(true)
  await rm(f.path, { recursive: true })
  await rename(`${f.path}.backup`, f.path)
  await session.send({ text: "next" })
  await settle(session)
  const recovered = JSON.stringify(await loadTranscript(f.path))
  expect(recovered).toContain("Generated summary")
  expect(recovered).not.toContain("evidence evidence")
})

test("maintenance rejects concurrent sends and close aborts an unresponsive summary", async () => {
  let started!: () => void
  const active = new Promise<void>((resolve) => {
    started = resolve
  })
  const f = await fixture(async function* () {
    started()
    await new Promise(() => {})
  })
  const session = await f.open()
  const operation = session.compact?.().catch((error: unknown) => error)
  await active
  await expect(session.send({ text: "race" })).rejects.toThrow("already running")
  await expect(session.setModel?.("context-fixture")).rejects.toThrow("current turn")
  await session.close()
  expect(await operation).toBeInstanceOf(Error)
  expect(await loadTranscript(f.path)).toEqual(f.seed)
})

test("no-history compaction and context inspection create no native state", async () => {
  const f = await fixture(undefined, true)
  const session = await f.open()
  await session.send({ text: "x".repeat(10_000) })
  await settle(session)
  await session.send({ text: "Continue with tests" })
  await settle(session)
  await session.compact?.()
  expect(await Bun.file(f.path).exists()).toBe(false)
  expect(
    f.events.some((event) => event.kind === "warning" && event.payload.message.includes("Compacted")),
  ).toBe(true)
})

test("interrupt during maintenance preparation never starts the summary provider", async () => {
  const f = await fixture()
  const session = await f.open()
  const operation = session.compact?.().catch((error: unknown) => error)
  await session.interrupt()
  expect(await operation).toBeInstanceOf(Error)
  expect(f.requests).toHaveLength(0)
  expect(await loadTranscript(f.path)).toEqual(f.seed)
})

test("context settings validate and survive unrelated config saves", async () => {
  const f = await fixture()
  const config = validateConfig(
    { codesplash: { autoCompact: false, compactionStrategy: "prune", fallbackModel: "fixture" } },
    "test.toml",
  )
  const path = join(f.cwd, "config.toml")
  await saveConfig(config, path)
  expect((await loadConfig(path)).codesplash).toEqual(config.codesplash)
  expect(() => validateConfig({ codesplash: { autoCompact: "yes" } }, "test")).toThrow("autoCompact")
  expect(() => validateConfig({ codesplash: { compactionStrategy: "erase" } }, "test")).toThrow(
    "compactionStrategy",
  )
})
