import { describe, expect, test } from "bun:test"
import type { AgentEvent, EngineSession } from "../../../src/core/index.ts"
import { CodexDriver } from "../../../src/engines/codex/driver.ts"

const fixture = new URL("../../fixtures/fake-codex-app-server.ts", import.meta.url)

function createDriver(): CodexDriver {
  return new CodexDriver({
    command: [process.execPath, fixture.pathname],
    shutdownTimeoutMs: 100,
  })
}

async function nextEvent(
  iterator: AsyncIterator<AgentEvent>,
  predicate: (event: AgentEvent) => boolean,
): Promise<AgentEvent> {
  for (let count = 0; count < 20; count++) {
    const result = await iterator.next()
    if (result.done) throw new Error("Event stream ended before the expected event")
    if (predicate(result.value)) return result.value
  }
  throw new Error("Expected event was not emitted")
}

async function openSession(nativeSessionId?: string): Promise<EngineSession> {
  return createDriver().openSession({
    cwd: process.cwd(),
    localSessionId: `local-${nativeSessionId ?? "new"}`,
    nativeSessionId,
  })
}

describe("CodexDriver", () => {
  test("starts a thread and round-trips an approval", async () => {
    const session = await openSession()
    const events = session.events[Symbol.asyncIterator]()

    try {
      expect(session.nativeSessionId).toBe("thread-1")
      const ready = await nextEvent(
        events,
        (event) => event.kind === "session.status" && event.payload.status === "ready",
      )
      expect(ready.kind === "session.status" && ready.payload.model).toBe("gpt-test")
      await session.send({ text: "request approval" })

      const request = await nextEvent(events, (event) => event.kind === "request.opened")
      expect(request.kind === "request.opened" && request.payload.detail).toContain("touch approved.txt")

      await session.resolveRequest("approval-1", { choice: "decline" })
      const resolved = await nextEvent(events, (event) => event.kind === "request.resolved")
      expect(resolved.kind === "request.resolved" && resolved.payload.decision).toBe("decline")

      const completed = await nextEvent(events, (event) => event.kind === "turn.completed")
      expect(completed.kind === "turn.completed" && completed.payload.status).toBe("completed")
    } finally {
      await session.close()
    }
  })

  test("interrupts a live turn", async () => {
    const session = await openSession()
    const events = session.events[Symbol.asyncIterator]()

    try {
      await session.send({ text: "interrupt" })
      await nextEvent(events, (event) => event.kind === "turn.started")
      await session.interrupt()

      const completed = await nextEvent(events, (event) => event.kind === "turn.completed")
      expect(completed.kind === "turn.completed" && completed.payload.status).toBe("interrupted")
    } finally {
      await session.close()
    }
  })

  test("resumes a provider-native thread", async () => {
    const session = await openSession("thread-existing")
    try {
      expect(session.nativeSessionId).toBe("thread-existing")
    } finally {
      await session.close()
    }
  })

  test("normalizes streaming output and accepts a second turn", async () => {
    const session = await openSession()
    const events = session.events[Symbol.asyncIterator]()

    try {
      await session.send({ text: "stream" })
      const firstCompleted = await nextEvent(events, (event) => event.kind === "turn.completed")
      expect(firstCompleted.kind === "turn.completed" && firstCompleted.payload.status).toBe("completed")

      await session.send({ text: "stream" })
      const secondCompleted = await nextEvent(events, (event) => event.kind === "turn.completed")
      expect(secondCompleted.kind === "turn.completed" && secondCompleted.payload.status).toBe("completed")
    } finally {
      await session.close()
    }
  })

  test("reports a child crash as a recoverable redacted event", async () => {
    const session = await openSession()
    const events = session.events[Symbol.asyncIterator]()

    await session.send({ text: "crash" })
    const crashed = await nextEvent(events, (event) => event.kind === "error")
    expect(crashed.kind === "error" && crashed.payload.recoverable).toBe(true)
    expect(crashed.kind === "error" && crashed.payload.message).toContain("status 17")
    expect(crashed.kind === "error" && crashed.payload.message).toContain("[REDACTED]")
    expect(crashed.kind === "error" && crashed.payload.message).not.toContain("fake-secret-token-value")

    await session.close()
  })
})
