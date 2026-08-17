import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { AgentEvent, EngineSession } from "../../../src/core/index.ts"
import { CodexDriver } from "../../../src/engines/codex/driver.ts"

const fixture = new URL("../../fixtures/fake-codex-app-server.ts", import.meta.url)

function createDriver(): CodexDriver {
  return new CodexDriver({
    command: [process.execPath, fileURLToPath(fixture)],
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

  test("passes the configured policy to thread/start and defaults when omitted", async () => {
    const configured = await createDriver().openSession({
      cwd: process.cwd(),
      localSessionId: "local-policy",
      policy: { sandbox: "read-only", approvalPolicy: "untrusted" },
    })
    try {
      const echo = await nextEvent(
        configured.events[Symbol.asyncIterator](),
        (event) => event.kind === "warning" && event.payload.message.startsWith("policy:"),
      )
      expect(echo.kind === "warning" && echo.payload.message).toBe("policy:thread/start:read-only:untrusted")
    } finally {
      await configured.close()
    }

    const defaulted = await openSession()
    try {
      const echo = await nextEvent(
        defaulted.events[Symbol.asyncIterator](),
        (event) => event.kind === "warning" && event.payload.message.startsWith("policy:"),
      )
      expect(echo.kind === "warning" && echo.payload.message).toBe(
        "policy:thread/start:workspace-write:on-request",
      )
    } finally {
      await defaulted.close()
    }
  })

  test("passes the configured policy to thread/resume", async () => {
    const session = await createDriver().openSession({
      cwd: process.cwd(),
      localSessionId: "local-policy-resume",
      nativeSessionId: "thread-existing",
      policy: { sandbox: "danger-full-access", approvalPolicy: "on-request" },
    })
    try {
      const echo = await nextEvent(
        session.events[Symbol.asyncIterator](),
        (event) => event.kind === "warning" && event.payload.message.startsWith("policy:"),
      )
      expect(echo.kind === "warning" && echo.payload.message).toBe(
        "policy:thread/resume:danger-full-access:on-request",
      )
    } finally {
      await session.close()
    }
  })

  test("synthesizes events for provider turns missing from local history on resume", async () => {
    const session = await openSession("thread-existing")
    const events = session.events[Symbol.asyncIterator]()

    try {
      const started = await nextEvent(events, (event) => event.kind === "turn.started")
      expect(started.native?.turnId).toBe("turn-past")
      expect(started.providerEvent).toBe("thread/resume")

      const user = await nextEvent(events, (event) => event.kind === "user.message")
      expect(user.kind === "user.message" && user.payload.text).toBe("earlier prompt")

      const reply = await nextEvent(events, (event) => event.kind === "message.completed")
      expect(reply.kind === "message.completed" && reply.payload.text).toBe("earlier reply")

      const completed = await nextEvent(events, (event) => event.kind === "turn.completed")
      expect(completed.kind === "turn.completed" && completed.payload.status).toBe("completed")
    } finally {
      await session.close()
    }
  })

  test("does not re-synthesize turns already present in local history", async () => {
    const session = await createDriver().openSession({
      cwd: process.cwd(),
      localSessionId: "local-known-turns",
      nativeSessionId: "thread-existing",
      knownTurnIds: ["turn-past"],
    })
    const events = session.events[Symbol.asyncIterator]()

    // Reconciliation events are queued synchronously right after the ready status, so
    // consuming through ready, closing, and draining sees everything that was synthesized.
    await nextEvent(events, (event) => event.kind === "session.status" && event.payload.status === "ready")
    await session.close()

    const collected: AgentEvent[] = []
    while (true) {
      const result = await events.next()
      if (result.done) break
      collected.push(result.value)
    }
    expect(collected.map((event) => event.kind)).not.toContain("turn.started")
    expect(collected.map((event) => event.kind)).not.toContain("message.completed")
  })

  test("rejects resume of a thread the provider no longer has", async () => {
    expect(openSession("thread-gone")).rejects.toThrow("thread not found")
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

  test("lists models across pages, dropping hidden entries", async () => {
    const session = await openSession()
    try {
      expect(await session.listModels?.()).toEqual([
        { id: "gpt-test", displayName: "GPT Test", description: "Default model", isDefault: true },
        { id: "gpt-test-mini", displayName: "GPT Test Mini", description: "Fast", isDefault: false },
      ])
    } finally {
      await session.close()
    }
  })

  test("applies a switched model to the next turn and reports it in session status", async () => {
    const session = await openSession()
    const events = session.events[Symbol.asyncIterator]()

    try {
      await nextEvent(events, (event) => event.kind === "session.status" && event.payload.status === "ready")
      await session.setModel?.("gpt-test-mini")
      const statusUpdate = await nextEvent(
        events,
        (event) => event.kind === "session.status" && event.payload.model === "gpt-test-mini",
      )
      expect(statusUpdate.providerEvent).toBe("client/modelSelected")

      await session.send({ text: "stream" })
      const modelEcho = await nextEvent(
        events,
        (event) => event.kind === "warning" && event.payload.message.startsWith("model:"),
      )
      expect(modelEcho.kind === "warning" && modelEcho.payload.message).toBe("model:gpt-test-mini")
    } finally {
      await session.close()
    }
  })

  test("normalizes rate-limit updates into usage events", async () => {
    const session = await openSession()
    const events = session.events[Symbol.asyncIterator]()

    try {
      await session.send({ text: "rate-limit" })
      const usage = await nextEvent(
        events,
        (event) => event.kind === "usage.updated" && event.payload.rateLimit !== undefined,
      )
      expect(usage.kind === "usage.updated" && usage.payload.rateLimit).toEqual({
        usedPercent: 42,
        label: "weekly",
        resetsAt: new Date(1_755_400_000 * 1000).toISOString(),
      })
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
