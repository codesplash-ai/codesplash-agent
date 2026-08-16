import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentEvent, createAgentEvent } from "../../src/core/events.ts"
import {
  listProjectSessions,
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

  test("returns an empty list for a project with no sessions", async () => {
    const root = await temporaryDirectory()
    expect(await listProjectSessions(projectIdFor("/nowhere"), root)).toEqual([])
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codesplash-agent-sessions-"))
  temporaryDirectories.push(directory)
  return directory
}
