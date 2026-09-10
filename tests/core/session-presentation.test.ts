import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runSessionCommand } from "../../src/commands/session.ts"
import { type AgentEventInput, createAgentEvent } from "../../src/core/events.ts"
import { BranchStore } from "../../src/core/session/branches.ts"
import { MemorySessionState } from "../../src/core/session/control.ts"
import { OwnedMaintenance } from "../../src/core/session/maintenance.ts"
import { outcomeCacheStatus } from "../../src/core/session/outcome-log.ts"
import { emptyOutcomes, localRecap, projectOutcomes, reduceOutcome } from "../../src/core/session/outcomes.ts"
import { awayRecap, renameSession, titleToken } from "../../src/core/session/presentation.ts"
import { SessionRepository } from "../../src/core/session/repository.ts"
import { SessionRecorder } from "../../src/core/session-recorder.ts"
import { projectIdFor, readSessionEvents, SessionStore } from "../../src/core/sessions.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function event(sequence: number, input: AgentEventInput) {
  return createAgentEvent(
    { engine: "codesplash", localSessionId: "PRIVATE_SESSION_CANARY", sequence, raw: "PRIVATE_RAW_CANARY" },
    input,
  )
}
function events() {
  return [
    event(0, { kind: "usage.updated", payload: { inputTokens: 50, outputTokens: 10 } }),
    event(1, { kind: "turn.started", payload: {} }),
    event(2, { kind: "user.message", payload: { id: "user", text: "PRIVATE_PROMPT_CANARY" } }),
    event(3, {
      kind: "item.updated",
      payload: {
        id: "PRIVATE_TOOL_CANARY",
        label: "read_file /PRIVATE_PATH",
        output: "PRIVATE_OUTPUT_CANARY",
        status: "completed",
      },
    }),
    event(4, {
      kind: "item.updated",
      payload: { id: "PRIVATE_TOOL_CANARY", label: "read_file", status: "completed" },
    }),
    event(5, {
      kind: "request.opened",
      payload: {
        id: "PRIVATE_REQUEST_CANARY",
        requestKind: "approval",
        title: "PRIVATE_TITLE",
        detail: "PRIVATE_DETAIL",
        choices: ["allow", "deny"],
      },
    }),
    event(6, { kind: "request.resolved", payload: { id: "PRIVATE_REQUEST_CANARY", decision: "deny" } }),
    event(7, { kind: "request.resolved", payload: { id: "PRIVATE_REQUEST_CANARY", decision: "deny" } }),
    event(8, { kind: "error", payload: { message: "PRIVATE_ERROR", recoverable: true } }),
    event(9, {
      kind: "usage.updated",
      payload: { inputTokens: 75, outputTokens: 20, hasUnpricedUsage: true },
    }),
    event(10, { kind: "turn.completed", payload: { status: "interrupted" } }),
  ]
}
test("outcomes deduplicate replay and tool/request updates, retain observed deltas, and omit private payloads", () => {
  const source = events(),
    state = projectOutcomes([...source, ...source])
  expect(state.rows).toHaveLength(1)
  expect(state.rows[0]?.tools.read.completed).toBe(1)
  expect(state.rows[0]?.approvals.declined).toBe(1)
  expect(state.rows[0]?.errors).toBe(1)
  expect(state.rows[0]?.usage).toEqual({ inputTokens: 25, outputTokens: 10, hasUnpricedUsage: true })
  expect(state.rows[0]?.status).toBe("interrupted")
  expect(JSON.stringify(state)).not.toContain("PRIVATE_")
  expect(localRecap(state)).toContain("usage/cost incomplete")
  expect(localRecap(state, 10)).toContain("No recorded")
})
test("unfinished ownership stays uncertain; retention and partial usage are explicit", () => {
  let state = emptyOutcomes()
  for (let n = 0; n < 1002; n++) state = reduceOutcome(state, event(n, { kind: "turn.started", payload: {} }))
  expect(state.rows).toHaveLength(1000)
  expect(state.dropped).toBe(2)
  expect(state.rows[0]?.status).toBe("uncertain")
  expect(localRecap(state, -1, false)).not.toContain("running")
  expect(localRecap(state)).toContain("outside the retained range")
  expect(
    projectOutcomes([
      event(0, { kind: "usage.updated", payload: { inputTokens: 1 } }),
      event(1, { kind: "usage.updated", payload: { outputTokens: 2 } }),
    ]).cumulativeUsage,
  ).toEqual({ inputTokens: 1, outputTokens: 2 })
})
test("title CAS ignores unrelated accounting but rejects manual and selected-context races", () => {
  const state = new MemorySessionState(),
    token = titleToken(state)
  state.update(state.read().revision, "usage", (value) => {
    value.values.usage = 2
  })
  expect(renameSession(state, "Generated", false, token)).toBe("Generated")
  const before = titleToken(state)
  renameSession(state, "My manual title")
  expect(() => renameSession(state, "Late generated", false, before)).toThrow("discarded")
  expect(state.read().state.title).toBe("My manual title")
  const branchToken = titleToken(state)
  new BranchStore(state).capture({ kind: "base", label: "base", messages: [], eventSequence: 0, usage: {} })
  expect(() => renameSession(state, "Stale branch", false, branchToken)).toThrow("discarded")
  const modelToken = titleToken(state, "old model")
  expect(() => renameSession(state, "Stale model", false, modelToken, "new model")).toThrow("discarded")
  expect(outcomeCacheStatus(state)).toBe("ephemeral")
  expect(awayRecap(0, 300001, false, 1, 2)).toBe(true)
  expect(awayRecap(0, 300001, true, 1, 2)).toBe(false)
  expect(awayRecap(0, 300001, false, 2, 2)).toBe(false)
})
test("maintenance owns work before invocation, fences overlap, settles cancellation and refuses work after close", async () => {
  const jobs = new OwnedMaintenance()
  const first = jobs.run("test", async (signal) => {
    expect(jobs.busy).toBe(true)
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    signal.throwIfAborted()
  })
  await expect(jobs.run("overlap", async () => 1)).rejects.toThrow("busy")
  await jobs.cancelAndSettle()
  await expect(first).rejects.toThrow("interrupted")
  expect(jobs.busy).toBe(false)
  let ran = false
  const delayed = jobs.run(
    "delayed",
    async () => {
      ran = true
    },
    100,
  )
  await jobs.close()
  await expect(delayed).rejects.toThrow()
  expect(ran).toBe(false)
  await expect(jobs.run("closed", async () => 1)).rejects.toThrow()
})
test("recorder repairs a torn outcome cache from canonical events and CLI inspection never needs a provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "presentation-"))
  roots.push(root)
  const store = new SessionStore(root),
    handle = await store.create({
      schemaVersion: 2,
      engine: "codesplash",
      localSessionId: "fixture",
      projectPath: root,
      projectId: projectIdFor(root),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastStatus: "ready",
      lastSequence: -1,
    })
  const recorder = new SessionRecorder(handle)
  for (const e of events()) recorder.record(e)
  await recorder.close()
  expect(recorder.failure).toBeUndefined()
  expect(outcomeCacheStatus(handle.state, 10)).toBe("verified")
  expect(outcomeCacheStatus(handle.state, 11)).toBe("needs-rebuild")
  const path = join(handle.directory, "outcomes.jsonl")
  expect(readFileSync(path, "utf8")).not.toContain("PRIVATE_")
  writeFileSync(path, "{torn")
  expect(outcomeCacheStatus(handle.state, 10)).toBe("needs-rebuild")
  const reopened = new SessionRecorder(await store.open(handle.meta.projectId, "fixture"))
  await reopened.close()
  expect(outcomeCacheStatus(handle.state, 10)).toBe("verified")
  expect(JSON.parse(readFileSync(path, "utf8")).tools.read.completed).toBe(1)
  let output = ""
  const options = {
    repository: new SessionRepository(root),
    output: (text: string) => {
      output += text
    },
  }
  await runSessionCommand(["info", "fixture", "--json"], options)
  expect(JSON.parse(output).outcomeCache).toBe("verified")
  output = ""
  await runSessionCommand(["recap", "fixture"], options)
  expect(output).toContain("interrupted")
  expect(output).not.toContain("PRIVATE_")
  expect((await readSessionEvents(handle.directory)).events).toHaveLength(events().length)
})

test("malformed historical payloads cannot enter typed outcomes or break replay", () => {
  const source = [
    event(0, { kind: "turn.started", payload: {} }),
    event(1, { kind: "item.updated", payload: { id: "x", label: "read_file", status: "completed" } }),
    event(2, { kind: "request.resolved", payload: { id: "x", decision: "allow" } }),
    event(3, { kind: "turn.completed", payload: { status: "completed" } }),
  ]
  Object.assign(source[1]?.payload ?? {}, { id: null, status: "PRIVATE_MALFORMED" })
  Object.assign(source[2]?.payload ?? {}, { decision: { secret: "PRIVATE_MALFORMED" } })
  Object.assign(source[3]?.payload ?? {}, { status: "PRIVATE_MALFORMED" })
  const state = projectOutcomes(source)
  expect(state.rows[0]?.status).toBe("uncertain")
  expect(state.rows[0]?.incomplete).toBe(true)
  expect(JSON.stringify(state.rows)).not.toContain("PRIVATE_MALFORMED")
})

test("failed outcome materialization leaves canonical recording usable", async () => {
  const root = mkdtempSync(join(tmpdir(), "outcome-failure-"))
  roots.push(root)
  const handle = await new SessionStore(root).create({
    schemaVersion: 2,
    engine: "codesplash",
    localSessionId: "fixture",
    projectPath: root,
    projectId: projectIdFor(root),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastStatus: "ready",
    lastSequence: -1,
  })
  mkdirSync(join(handle.directory, "outcomes.jsonl"))
  const recorder = new SessionRecorder(handle)
  for (const e of events()) recorder.record(e)
  await recorder.close()
  expect(recorder.failure).toBeUndefined()
  expect(recorder.outcomeFailure).toBeInstanceOf(Error)
  expect(projectOutcomes((await readSessionEvents(handle.directory)).events).rows[0]?.status).toBe(
    "interrupted",
  )
})
