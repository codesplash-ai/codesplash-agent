import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentEvent, type AgentEventInput, createAgentEvent } from "../../src/core/events.ts"
import { initialAppViewState, reduceAgentEvent } from "../../src/core/reducer.ts"
import { SessionRecorder, serializeEvent } from "../../src/core/session-recorder.ts"
import {
  projectIdFor,
  readSessionEvents,
  readSessionMeta,
  type SessionMeta,
  SessionStore,
} from "../../src/core/sessions.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

let sequence = 0

function makeEvent(input: AgentEventInput, native?: { turnId?: string }): AgentEvent {
  return createAgentEvent(
    {
      engine: "codex",
      localSessionId: "local-1",
      sequence: sequence++,
      native,
      raw: { providerSecret: "sk-super-secret" },
    },
    input,
  )
}

function makeMeta(): SessionMeta {
  return {
    schemaVersion: 1,
    engine: "codex",
    localSessionId: "local-1",
    projectPath: "/canonical/project",
    projectId: projectIdFor("/canonical/project"),
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    lastStatus: "starting",
    lastSequence: -1,
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
  }
}

/** A realistic streamed turn: status, prompt, reasoning + message deltas, tool, completion. */
function scriptedTurn(): AgentEvent[] {
  return [
    makeEvent({ kind: "session.status", payload: { status: "ready", model: "gpt-5-codex" } }),
    makeEvent({ kind: "user.message", payload: { id: "u1", text: "  Fix the   flaky test in auth.ts  " } }),
    makeEvent({ kind: "turn.started", payload: {} }, { turnId: "turn-1" }),
    makeEvent({ kind: "reasoning.delta", payload: { id: "r1", text: "Looking at " } }),
    makeEvent({ kind: "reasoning.delta", payload: { id: "r1", text: "the test." } }),
    makeEvent({ kind: "reasoning.completed", payload: { id: "r1" } }),
    makeEvent({ kind: "message.delta", payload: { id: "m1", text: "The fix " } }),
    makeEvent({ kind: "message.delta", payload: { id: "m1", text: "is simple." } }),
    makeEvent({ kind: "message.completed", payload: { id: "m1", text: "The fix is simple." } }),
    makeEvent({
      kind: "item.updated",
      payload: { id: "t1", label: "bun test", output: "1 pass", status: "completed" },
    }),
    makeEvent({ kind: "turn.completed", payload: { status: "completed" } }, { turnId: "turn-1" }),
  ]
}

describe("session recorder", () => {
  test("persists coalesced events whose replay reproduces the live transcript", async () => {
    sequence = 0
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const handle = await store.create(makeMeta())
    const recorder = new SessionRecorder(handle)

    let liveState = initialAppViewState
    for (const event of scriptedTurn()) {
      recorder.record(event)
      liveState = reduceAgentEvent(liveState, event)
    }
    await recorder.close("closed")

    const read = await readSessionEvents(handle.directory)
    // Delta events survive only as one empty-text ordering marker per item; the
    // streamed text itself is coalesced into the completion events.
    for (const event of read.events) {
      if (event.kind === "message.delta" || event.kind === "reasoning.delta") {
        expect(event.payload.text).toBe("")
      }
    }
    const deltaCounts = new Map<string, number>()
    for (const event of read.events) {
      if (event.kind === "message.delta" || event.kind === "reasoning.delta") {
        deltaCounts.set(event.payload.id, (deltaCounts.get(event.payload.id) ?? 0) + 1)
      }
    }
    for (const count of deltaCounts.values()) expect(count).toBe(1)

    let replayed = initialAppViewState
    for (const event of read.events) replayed = reduceAgentEvent(replayed, event)
    expect(replayed.transcript).toEqual(liveState.transcript)
    expect(replayed.plan).toEqual(liveState.plan)
    expect(replayed.usage).toEqual(liveState.usage)
  })

  test("fills reasoning and message text from accumulated deltas when completion carries none", async () => {
    sequence = 0
    const root = await temporaryDirectory()
    const handle = await new SessionStore(root).create(makeMeta())
    const recorder = new SessionRecorder(handle)

    recorder.record(makeEvent({ kind: "reasoning.delta", payload: { id: "r1", text: "part one " } }))
    recorder.record(makeEvent({ kind: "reasoning.delta", payload: { id: "r1", text: "part two" } }))
    recorder.record(makeEvent({ kind: "reasoning.completed", payload: { id: "r1" } }))
    recorder.record(makeEvent({ kind: "message.delta", payload: { id: "m1", text: "hello " } }))
    recorder.record(makeEvent({ kind: "message.delta", payload: { id: "m1", text: "world" } }))
    recorder.record(makeEvent({ kind: "message.completed", payload: { id: "m1" } }))
    await recorder.close()

    const read = await readSessionEvents(handle.directory)
    expect(read.events.map((event) => event.kind)).toEqual([
      "reasoning.delta",
      "reasoning.completed",
      "message.delta",
      "message.completed",
    ])
    expect(read.events[1]?.payload).toEqual({ id: "r1", text: "part one part two" })
    expect(read.events[3]?.payload).toEqual({ id: "m1", text: "hello world" })
  })

  test("never writes raw payloads and records no secret content", async () => {
    sequence = 0
    const root = await temporaryDirectory()
    const handle = await new SessionStore(root).create(makeMeta())
    const recorder = new SessionRecorder(handle)

    for (const event of scriptedTurn()) recorder.record(event)
    await recorder.close("closed")

    const eventsSource = await readFile(handle.eventsPath, "utf8")
    const metaSource = await readFile(join(handle.directory, "meta.json"), "utf8")
    expect(eventsSource).not.toContain("sk-super-secret")
    expect(metaSource).not.toContain("sk-super-secret")
    for (const line of eventsSource.split("\n").filter((entry) => entry.length > 0)) {
      expect(collectKeys(JSON.parse(line))).not.toContain("raw")
    }
  })

  test("maintains title, status, sequence, and turn ids in metadata", async () => {
    sequence = 0
    const root = await temporaryDirectory()
    const handle = await new SessionStore(root).create(makeMeta())
    const recorder = new SessionRecorder(handle)

    for (const event of scriptedTurn()) recorder.record(event)
    recorder.recordNativeSessionId("thread-42")
    await recorder.close("closed")

    expect(recorder.knownTurnIds).toEqual(["turn-1"])
    const meta = await readSessionMeta(handle.directory)
    expect(meta?.title).toBe("Fix the flaky test in auth.ts")
    expect(meta?.nativeSessionId).toBe("thread-42")
    expect(meta?.lastStatus).toBe("closed")
    expect(meta?.lastSequence).toBe(sequence - 1)
  })

  test("seeds known turn ids and last sequence from replayed history", async () => {
    sequence = 0
    const root = await temporaryDirectory()
    const handle = await new SessionStore(root).create(makeMeta())
    const recorder = new SessionRecorder(handle)

    recorder.seedFromHistory([
      makeEvent({ kind: "turn.started", payload: {} }, { turnId: "old-turn" }),
      makeEvent({ kind: "turn.completed", payload: { status: "completed" } }, { turnId: "old-turn" }),
    ])

    expect(recorder.knownTurnIds).toEqual(["old-turn"])
    await recorder.close()
    const meta = await readSessionMeta(handle.directory)
    expect(meta?.lastSequence).toBe(1)
  })

  test("bounds oversized persisted lines by truncating the largest text field", () => {
    const event = createAgentEvent(
      { engine: "codex", localSessionId: "local-1", sequence: 0 },
      { kind: "message.completed", payload: { id: "m1", text: "x".repeat(400 * 1024) } },
    )

    const line = serializeEvent(event)
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(256 * 1024 + 1024)
    const parsed = JSON.parse(line) as { payload: { text: string } }
    expect(parsed.payload.text.endsWith("…[truncated]")).toBe(true)
  })
})

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (typeof value !== "object" || value === null) return keys
  for (const [key, child] of Object.entries(value)) {
    keys.push(key)
    collectKeys(child, keys)
  }
  return keys
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codesplash-agent-recorder-"))
  temporaryDirectories.push(directory)
  return directory
}
