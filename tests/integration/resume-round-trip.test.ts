import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AppViewState } from "../../src/core/index.ts"
import {
  initialAppViewState,
  projectIdFor,
  readSessionEvents,
  reduceAgentEvent,
  SessionController,
  SessionRecorder,
  SessionStore,
} from "../../src/core/index.ts"
import { CodexDriver } from "../../src/engines/codex/driver.ts"

const fixture = new URL("../fixtures/fake-codex-app-server.ts", import.meta.url)

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

function createDriver(): CodexDriver {
  return new CodexDriver({
    command: [process.execPath, fixture.pathname],
    shutdownTimeoutMs: 100,
  })
}

function waitFor(
  controller: SessionController,
  predicate: (state: AppViewState) => boolean,
  timeoutMs = 5000,
): Promise<AppViewState> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error("Timed out waiting for expected view state"))
    }, timeoutMs)
    const unsubscribe = controller.subscribe((state) => {
      if (!predicate(state)) return
      clearTimeout(timeout)
      unsubscribe()
      resolve(state)
    })
  })
}

describe("session resume round trip (exit gate 1)", () => {
  test("restores the transcript after restart via thread/resume without replaying the prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "codesplash-agent-roundtrip-"))
    temporaryDirectories.push(root)
    const store = new SessionStore(root)
    const projectPath = "/canonical/roundtrip-project"
    const projectId = projectIdFor(projectPath)
    const localSessionId = "roundtrip-session"
    const now = new Date().toISOString()

    // Phase 1: live session with a streamed turn, recorded to disk.
    const handle = await store.create({
      schemaVersion: 1,
      engine: "codex",
      localSessionId,
      projectPath,
      projectId,
      createdAt: now,
      updatedAt: now,
      lastStatus: "starting",
      lastSequence: -1,
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
    })
    const recorder = new SessionRecorder(handle)
    const session = await createDriver().openSession({
      cwd: process.cwd(),
      localSessionId,
      firstSequence: 0,
    })
    recorder.recordNativeSessionId(session.nativeSessionId ?? "missing")
    const controller = new SessionController(session, { onEvent: recorder.record })
    controller.start()

    await waitFor(controller, (state) => state.sessionStatus === "ready")
    await controller.send({ text: "stream" })
    const liveState = await waitFor(
      controller,
      (state) => state.turnStatus === "completed" && state.transcript.length > 0,
    )
    await controller.close()
    await recorder.close("closed")
    expect(recorder.failure).toBeUndefined()

    // Phase 2: fresh process state — replay from disk, then attach via thread/resume.
    const reopened = await store.open(projectId, localSessionId)
    expect(reopened.meta.nativeSessionId).toBe("thread-1")
    const { events } = await readSessionEvents(reopened.directory)
    expect(events.length).toBeGreaterThan(0)

    let replayed = initialAppViewState
    for (const event of events) replayed = reduceAgentEvent(replayed, event)
    expect(replayed.transcript).toEqual(liveState.transcript)

    const recorder2 = new SessionRecorder(reopened)
    recorder2.seedFromHistory(events)
    expect(recorder2.knownTurnIds).toEqual(["turn-1"])
    const firstSequence = Math.max(reopened.meta.lastSequence, recorder2.lastSequence) + 1

    const resumed = await createDriver().openSession({
      cwd: process.cwd(),
      localSessionId,
      nativeSessionId: reopened.meta.nativeSessionId,
      firstSequence,
      knownTurnIds: recorder2.knownTurnIds,
    })
    const controller2 = new SessionController(resumed, {
      initialState: { ...replayed, sessionStatus: "starting", turnStatus: "idle" },
      onEvent: recorder2.record,
    })
    controller2.start()

    // Warnings replayed from phase 1 include its thread/start echo; only warnings
    // appended after replay describe what phase 2 actually did.
    const replayedWarningCount = replayed.warnings.length
    const readyState = await waitFor(
      controller2,
      (state) => state.sessionStatus === "ready" && state.warnings.length > replayedWarningCount,
    )
    const newWarnings = readyState.warnings.slice(replayedWarningCount)

    // The provider took the resume path and no prompt was replayed as a new turn.
    expect(newWarnings.some((message) => message.startsWith("policy:thread/resume:"))).toBe(true)
    expect(newWarnings.some((message) => message.startsWith("policy:thread/start:"))).toBe(false)
    expect(readyState.turnStatus).toBe("idle")
    expect(readyState.transcript).toEqual(liveState.transcript)

    await controller2.close()
    await recorder2.close("closed")

    // The persisted log stayed monotonic across the restart.
    const finalRead = await readSessionEvents(reopened.directory)
    const sequences = finalRead.events.map((event) => event.sequence)
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences)
    expect(new Set(sequences).size).toBe(sequences.length)
  }, 15000)
})
