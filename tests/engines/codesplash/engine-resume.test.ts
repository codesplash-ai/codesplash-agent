/**
 * Resume wiring for the CodeSplash engine: a session opened with nativeTranscriptPath seeds the
 * loop from the persisted transcript, appends every turn's messages back to it, and degrades
 * transcript write failures to a single warning instead of crashing the session.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent, EngineSession } from "../../../src/core/index.ts"
import type {
  ChatMessage,
  ProviderClient,
  ProviderRequest,
  ProviderStreamEvent,
} from "../../../src/engines/codesplash/contracts.ts"
import { CodesplashDriver } from "../../../src/engines/codesplash/engine.ts"
import { appendTranscriptMessages, loadTranscript } from "../../../src/engines/codesplash/transcript.ts"

const ANTHROPIC_KEY_VALUE = "unit-test-anthropic-key-value"

const savedEnv: Record<string, string | undefined> = {}
let cwd: string

beforeEach(async () => {
  savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
  savedEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY
  savedEnv.CODESPLASH_AGENT_CONFIG_DIR = process.env.CODESPLASH_AGENT_CONFIG_DIR
  delete process.env.OPENAI_API_KEY
  process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY_VALUE
  process.env.CODESPLASH_AGENT_CONFIG_DIR = join(tmpdir(), `codesplash-resume-config-${randomUUID()}`)
  cwd = await mkdtemp(join(tmpdir(), "codesplash-resume-test-"))
})

afterEach(async () => {
  const temporaryConfigDir = process.env.CODESPLASH_AGENT_CONFIG_DIR
  restoreEnv("ANTHROPIC_API_KEY", savedEnv.ANTHROPIC_API_KEY)
  restoreEnv("OPENAI_API_KEY", savedEnv.OPENAI_API_KEY)
  restoreEnv("CODESPLASH_AGENT_CONFIG_DIR", savedEnv.CODESPLASH_AGENT_CONFIG_DIR)
  if (temporaryConfigDir) await rm(temporaryConfigDir, { recursive: true, force: true })
  await rm(cwd, { recursive: true, force: true })
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function fakeProvider(scripts: ProviderStreamEvent[][]): ProviderClient & {
  requests: ProviderRequest[]
} {
  const remaining = [...scripts]
  const requests: ProviderRequest[] = []
  return {
    id: "anthropic",
    models: [],
    requests,
    stream(request) {
      requests.push(request)
      const script = remaining.shift()
      if (!script) throw new Error("fake provider ran out of responses")
      return (async function* () {
        for (const event of script) yield event
      })()
    },
  }
}

function collectEvents(session: EngineSession): { events: AgentEvent[]; done: Promise<void> } {
  const events: AgentEvent[] = []
  const done = (async () => {
    for await (const event of session.events) events.push(event)
  })()
  return { events, done }
}

async function until<T>(get: () => T | undefined, label: string, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = get()
    if (value !== undefined) return value
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

/** Retries send until the previous turn's finalizers (transcript append included) have run. */
async function sendWhenIdle(session: EngineSession, text: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      await session.send({ text })
      return
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await Bun.sleep(5)
    }
  }
}

function textTurn(text: string): ProviderStreamEvent[] {
  return [
    { type: "text_delta", text },
    { type: "done", stopReason: "end_turn" },
  ]
}

async function openWithTranscript(
  provider: ProviderClient,
  nativeTranscriptPath: string,
  localSessionId = "local-resume-1",
): Promise<{ session: EngineSession; events: AgentEvent[]; done: Promise<void> }> {
  const driver = new CodesplashDriver({ providers: { anthropic: provider } })
  const session = await driver.openSession({ cwd, localSessionId, nativeTranscriptPath })
  const { events, done } = collectEvents(session)
  return { session, events, done }
}

describe("resume capability", () => {
  test("codesplash sessions advertise resume", async () => {
    const { session, done } = await openWithTranscript(fakeProvider([]), join(cwd, "t.jsonl"))
    expect(session.capabilities.resume).toBe(true)
    await session.close()
    await done
  })
})

describe("resume seeding", () => {
  test("a persisted transcript is seeded into the loop and sent to the provider", async () => {
    const transcriptPath = join(cwd, "transcript.jsonl")
    const seeded: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "earlier question" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "prior thinking", signature: "sig-9" },
          { type: "text", text: "earlier answer" },
        ],
      },
    ]
    await appendTranscriptMessages(transcriptPath, seeded)

    const provider = fakeProvider([textTurn("resumed reply")])
    const { session, events, done } = await openWithTranscript(provider, transcriptPath)
    await session.send({ text: "follow-up" })
    await until(() => events.find((event) => event.kind === "turn.completed"), "turn.completed")

    const messages = provider.requests[0]?.messages
    expect(messages).toHaveLength(3)
    expect(messages?.slice(0, 2)).toEqual(seeded)
    expect(messages?.[2]).toEqual({ role: "user", content: [{ type: "text", text: "follow-up" }] })

    await session.close()
    await done
  })

  test("a missing transcript file opens a fresh session", async () => {
    const provider = fakeProvider([textTurn("fresh reply")])
    const { session, events, done } = await openWithTranscript(provider, join(cwd, "absent.jsonl"))
    await session.send({ text: "first" })
    await until(() => events.find((event) => event.kind === "turn.completed"), "turn.completed")

    expect(provider.requests[0]?.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "first" }] },
    ])
    await session.close()
    await done
  })
})

describe("resume usage continuity", () => {
  test("initialUsage seeds the loop so post-resume usage events continue the recorded totals", async () => {
    const provider = fakeProvider([
      [
        { type: "text_delta", text: "resumed" },
        { type: "usage", usage: { inputTokens: 100, outputTokens: 10 } },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const driver = new CodesplashDriver({ providers: { anthropic: provider } })
    const session = await driver.openSession({
      cwd,
      localSessionId: "local-usage-1",
      initialUsage: { inputTokens: 5_000, outputTokens: 600, estimatedCostUsd: 0.75 },
    })
    const { events, done } = collectEvents(session)
    await session.send({ text: "continue" })
    await until(() => events.find((event) => event.kind === "turn.completed"), "turn.completed")
    await session.close()
    await done

    const usage = events.find((event) => event.kind === "usage.updated")
    expect(usage?.kind === "usage.updated" && usage.payload.inputTokens).toBe(5_100)
    expect(usage?.kind === "usage.updated" && usage.payload.outputTokens).toBe(610)
  })
})

describe("per-turn transcript append", () => {
  test("a tool-round turn appends every message it added, and a resumed session continues from them", async () => {
    const transcriptPath = join(cwd, "transcript.jsonl")
    const filePath = join(cwd, "note.txt")
    await Bun.write(filePath, "hello from disk\n")

    const provider = fakeProvider([
      [
        {
          type: "tool_call",
          id: "call-1",
          name: "read_file",
          input: { path: filePath },
        },
        { type: "done", stopReason: "tool_use" },
      ],
      textTurn("done reading"),
    ])
    const { session, events, done } = await openWithTranscript(provider, transcriptPath)
    await session.send({ text: "read the note" })
    await until(() => events.find((event) => event.kind === "turn.completed"), "turn.completed")
    await session.close()
    await done

    const persisted = await loadTranscript(transcriptPath)
    expect(persisted.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"])
    expect(persisted[0]?.content).toEqual([{ type: "text", text: "read the note" }])
    expect(persisted[1]?.content).toEqual([
      { type: "tool_call", id: "call-1", name: "read_file", input: { path: filePath } },
    ])
    expect(persisted[2]?.content[0]?.type).toBe("tool_result")
    expect(persisted[3]?.content).toEqual([{ type: "text", text: "done reading" }])

    // A second session on the same transcript resumes with the full persisted history.
    const resumedProvider = fakeProvider([textTurn("second reply")])
    const resumed = await openWithTranscript(resumedProvider, transcriptPath, "local-resume-2")
    await resumed.session.send({ text: "second turn" })
    await until(
      () => resumed.events.find((event) => event.kind === "turn.completed"),
      "resumed turn.completed",
    )
    await resumed.session.close()
    await resumed.done

    expect(resumedProvider.requests[0]?.messages.slice(0, 4)).toEqual(persisted)
    expect(resumedProvider.requests[0]?.messages).toHaveLength(5)
    expect(await loadTranscript(transcriptPath)).toHaveLength(6)
  })

  test("consecutive turns in one session each append their own messages", async () => {
    const transcriptPath = join(cwd, "transcript.jsonl")
    const provider = fakeProvider([textTurn("one"), textTurn("two")])
    const { session, events, done } = await openWithTranscript(provider, transcriptPath)

    await session.send({ text: "first" })
    await until(() => events.find((event) => event.kind === "turn.completed"), "first turn")
    await sendWhenIdle(session, "second")
    await until(
      () => (events.filter((event) => event.kind === "turn.completed").length >= 2 ? true : undefined),
      "second turn",
    )
    await session.close()
    await done

    const persisted = await loadTranscript(transcriptPath)
    expect(persisted.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"])
    // The second turn's provider request already carried the first turn's messages.
    expect(provider.requests[1]?.messages).toHaveLength(3)
  })

  test("without nativeTranscriptPath nothing is persisted", async () => {
    const provider = fakeProvider([textTurn("ephemeral")])
    const driver = new CodesplashDriver({ providers: { anthropic: provider } })
    const session = await driver.openSession({ cwd, localSessionId: "local-no-transcript" })
    const { events, done } = collectEvents(session)
    await session.send({ text: "hi" })
    await until(() => events.find((event) => event.kind === "turn.completed"), "turn.completed")
    await session.close()
    await done
    expect(await Bun.file(join(cwd, "transcript.jsonl")).exists()).toBe(false)
  })
})

describe("transcript write failures", () => {
  test("degrade to a single warning event per session and never crash the turn", async () => {
    // A read-only parent directory: the missing transcript loads as fresh, every append fails.
    const locked = join(cwd, "locked")
    const { mkdir, chmod } = await import("node:fs/promises")
    await mkdir(locked)
    await chmod(locked, 0o500)
    const brokenPath = join(locked, "transcript.jsonl")
    const provider = fakeProvider([textTurn("one"), textTurn("two")])
    const { session, events, done } = await openWithTranscript(provider, brokenPath)

    await session.send({ text: "first" })
    await until(() => events.find((event) => event.kind === "warning"), "transcript warning")
    await sendWhenIdle(session, "second")
    await until(
      () => (events.filter((event) => event.kind === "turn.completed").length >= 2 ? true : undefined),
      "second turn",
    )
    await session.close()
    await done

    const warnings = events.filter((event) => event.kind === "warning")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.kind === "warning" && warnings[0].payload.message).toContain(
      "Could not persist the session transcript",
    )
    expect(events.filter((event) => event.kind === "error")).toHaveLength(0)
    expect(events.filter((event) => event.kind === "turn.completed")).toHaveLength(2)
    await chmod(locked, 0o700)
  })
})
