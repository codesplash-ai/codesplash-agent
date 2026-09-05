import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentEvent, createAgentEvent } from "../../src/core/events.ts"
import {
  listProjectSessions,
  permissionGrantsPathFor,
  projectIdFor,
  readSessionEvents,
  readSessionMeta,
  type SessionMeta,
  SessionStore,
  transcriptPathFor,
} from "../../src/core/sessions.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    schemaVersion: 1,
    engine: "codex",
    localSessionId: "local-1",
    projectPath: "/canonical/project",
    projectId: projectIdFor("/canonical/project"),
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    lastStatus: "ready",
    lastSequence: -1,
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    ...overrides,
  }
}

function makeEvent(sequence: number, text: string): AgentEvent {
  return createAgentEvent(
    { engine: "codex", localSessionId: "local-1", sequence, timestamp: "2026-08-16T00:00:00.000Z" },
    { kind: "user.message", payload: { id: `u${sequence}`, text } },
  )
}

describe("session store", () => {
  test("derives a stable 16-character project id from the canonical path", () => {
    expect(projectIdFor("/canonical/project")).toBe(projectIdFor("/canonical/project"))
    expect(projectIdFor("/canonical/project")).not.toBe(projectIdFor("/canonical/other"))
    expect(projectIdFor("/canonical/project")).toMatch(/^[0-9a-f]{16}$/)
  })

  test("creates sessions with private permissions and lists them newest first", async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const projectId = projectIdFor("/canonical/project")

    const older = await store.create(
      makeMeta({ localSessionId: "older", updatedAt: "2026-08-15T00:00:00.000Z" }),
    )
    await store.create(makeMeta({ localSessionId: "newer", updatedAt: "2026-08-16T12:00:00.000Z" }))
    await older.appendEventLines(['{"noop":true}'])

    const sessions = await listProjectSessions(projectId, root)
    expect(sessions.map((meta) => meta.localSessionId)).toEqual(["newer", "older"])

    if (process.platform !== "win32") {
      const directoryMode = (await stat(older.directory)).mode & 0o777
      const metaMode = (await stat(join(older.directory, "meta.json"))).mode & 0o777
      const eventsMode = (await stat(older.eventsPath)).mode & 0o777
      expect(directoryMode).toBe(0o700)
      expect(metaMode).toBe(0o600)
      expect(eventsMode).toBe(0o600)
    }
  })

  test("replaces metadata atomically and leaves no temp file behind", async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const handle = await store.create(makeMeta())

    await handle.updateMeta({ title: "First prompt", lastSequence: 12 })

    const reread = await readSessionMeta(handle.directory)
    expect(reread?.title).toBe("First prompt")
    expect(reread?.lastSequence).toBe(12)
    expect(reread?.updatedAt).not.toBe("2026-08-16T00:00:00.000Z")
    const { readdir } = await import("node:fs/promises")
    expect((await readdir(handle.directory)).sort()).toEqual(["meta.json"])
  })

  test("drops a torn final line on read and heals it before the next append", async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const created = await store.create(makeMeta())
    await created.appendEventLines([JSON.stringify(makeEvent(0, "one")), JSON.stringify(makeEvent(1, "two"))])
    const torn = `${JSON.stringify(makeEvent(2, "three")).slice(0, 25)}`
    await writeFile(created.eventsPath, torn, { flag: "a" })

    const read = await readSessionEvents(created.directory)
    expect(read.events.map((event) => event.sequence)).toEqual([0, 1])
    expect(read.truncatedLineRecovered).toBe(true)
    expect(read.skippedLineCount).toBe(0)

    const reopened = await store.open(makeMeta().projectId, "local-1")
    await reopened.appendEventLines([JSON.stringify(makeEvent(2, "three"))])

    const healed = await readSessionEvents(created.directory)
    expect(healed.events.map((event) => event.sequence)).toEqual([0, 1, 2])
    expect(healed.truncatedLineRecovered).toBe(false)
    const lines = (await readFile(created.eventsPath, "utf8")).split("\n").filter((line) => line.length > 0)
    expect(lines).toHaveLength(3)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  })

  test("skips corrupt interior lines without discarding intact history after them", async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const handle = await store.create(makeMeta())
    await writeFile(
      handle.eventsPath,
      [JSON.stringify(makeEvent(0, "one")), "{ not json", JSON.stringify(makeEvent(2, "three")), ""].join(
        "\n",
      ),
    )

    const read = await readSessionEvents(handle.directory)
    expect(read.events.map((event) => event.sequence)).toEqual([0, 2])
    expect(read.skippedLineCount).toBe(1)
    expect(read.truncatedLineRecovered).toBe(false)
  })

  test("tolerates unreadable sibling session directories when listing", async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const projectId = projectIdFor("/canonical/project")
    await store.create(makeMeta({ localSessionId: "good" }))
    const { mkdir } = await import("node:fs/promises")
    await mkdir(join(root, projectId, "no-meta"), { recursive: true })
    await mkdir(join(root, projectId, "invalid"), { recursive: true })
    await writeFile(join(root, projectId, "invalid", "meta.json"), "not json")

    const sessions = await listProjectSessions(projectId, root)
    expect(sessions.map((meta) => meta.localSessionId)).toEqual(["good"])
  })

  test("reads back and lists metas for every engine, including codesplash", async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const projectId = projectIdFor("/canonical/project")
    await store.create(makeMeta({ localSessionId: "codex-session", engine: "codex" }))
    await store.create(
      makeMeta({
        localSessionId: "codesplash-session",
        engine: "codesplash",
        updatedAt: "2026-08-17T00:00:00.000Z",
      }),
    )

    const sessions = await listProjectSessions(projectId, root)
    expect(sessions.map((meta) => meta.localSessionId)).toEqual(["codesplash-session", "codex-session"])
    expect(sessions[0]?.engine).toBe("codesplash")

    const reread = await readSessionMeta(join(root, projectId, "codesplash-session"))
    expect(reread?.engine).toBe("codesplash")
  })

  test("returns an empty list for a project with no sessions", async () => {
    const root = await temporaryDirectory()
    expect(await listProjectSessions(projectIdFor("/nowhere"), root)).toEqual([])
  })

  test("open returns a handle that appends to the same log and updates the same meta", async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const created = await store.create(makeMeta({ engine: "codesplash" }))
    await created.appendEventLines([JSON.stringify(makeEvent(0, "one"))])

    const reopened = await store.open(makeMeta().projectId, "local-1")
    expect(reopened.directory).toBe(created.directory)
    expect(reopened.meta.engine).toBe("codesplash")
    await reopened.appendEventLines([JSON.stringify(makeEvent(1, "two"))])
    await reopened.updateMeta({ lastStatus: "closed", lastSequence: 1 })

    const events = await readSessionEvents(created.directory)
    expect(events.events.map((event) => event.sequence)).toEqual([0, 1])
    const meta = await readSessionMeta(created.directory)
    expect(meta?.lastStatus).toBe("closed")
    expect(meta?.lastSequence).toBe(1)
    expect(meta?.updatedAt).not.toBe("2026-08-16T00:00:00.000Z")
  })

  test("open rejects a session that does not exist", async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    await expect(store.open(projectIdFor("/canonical/project"), "missing")).rejects.toThrow(
      "No session metadata",
    )
  })

  test("transcriptPathFor places transcript.jsonl next to events.jsonl", async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const handle = await store.create(makeMeta({ engine: "codesplash" }))
    expect(transcriptPathFor(handle)).toBe(join(handle.directory, "transcript.jsonl"))
    expect(join(transcriptPathFor(handle), "..")).toBe(join(handle.eventsPath, ".."))
  })

  test("permissionMode round-trips through meta writes, reads, and updates", async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const handle = await store.create(makeMeta({ engine: "codesplash", permissionMode: "accept-edits" }))

    const reread = await readSessionMeta(handle.directory)
    expect(reread?.permissionMode).toBe("accept-edits")

    // Resume-style update: a later run may switch the recorded mode.
    await handle.updateMeta({ permissionMode: "plan" })
    const updated = await readSessionMeta(handle.directory)
    expect(updated?.permissionMode).toBe("plan")

    // Absent stays absent: metas written before the field existed keep validating.
    const legacy = await store.create(makeMeta({ localSessionId: "legacy" }))
    expect((await readSessionMeta(legacy.directory))?.permissionMode).toBeUndefined()
  })

  test("a non-string permissionMode fails the loose meta validation", async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const handle = await store.create(makeMeta())
    const raw = JSON.parse(await readFile(join(handle.directory, "meta.json"), "utf8")) as Record<
      string,
      unknown
    >
    raw.permissionMode = 42
    await writeFile(join(handle.directory, "meta.json"), JSON.stringify(raw))

    expect(await readSessionMeta(handle.directory)).toBeUndefined()
  })

  test("permissionGrantsPathFor builds <dataDir>/permissions/<projectId>.toml without creating it", async () => {
    const dataDir = await temporaryDirectory()
    const projectId = projectIdFor("/canonical/project")
    const path = permissionGrantsPathFor(dataDir, projectId)
    expect(path).toBe(join(dataDir, "permissions", `${projectId}.toml`))
    expect(await stat(join(dataDir, "permissions")).catch(() => undefined)).toBeUndefined()
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codesplash-agent-sessions-"))
  temporaryDirectories.push(directory)
  return directory
}
