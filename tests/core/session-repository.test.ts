import { afterEach, expect, test } from "bun:test"
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runSessionCommand } from "../../src/commands/session.ts"
import { createAgentEvent } from "../../src/core/events.ts"
import { compressLogs, logBytes } from "../../src/core/session/compression.ts"
import { control, MemorySessionState, updateControl } from "../../src/core/session/control.ts"
import { atomic, bytes, digest, hostId, lease } from "../../src/core/session/files.ts"
import { SessionRepository } from "../../src/core/session/repository.ts"
import { SessionRecorder } from "../../src/core/session-recorder.ts"
import {
  listProjectSessions,
  readSessionEvents,
  readSessionMeta,
  type SessionMeta,
  SessionStore,
} from "../../src/core/sessions.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
async function fixture(version: 1 | 2 = 2) {
  const root = mkdtempSync(join(tmpdir(), "m5-repository-"))
  roots.push(root)
  const store = new SessionStore(root),
    repository = new SessionRepository(root)
  const meta: SessionMeta = {
    schemaVersion: version,
    engine: "codesplash",
    localSessionId: "one",
    projectId: "project",
    projectPath: "/project",
    title: "Original",
    createdAt: "2026-09-07T00:00:00Z",
    updatedAt: "2026-09-07T00:00:00Z",
    lastStatus: "closed",
    lastSequence: -1,
  }
  const handle = await store.create(meta)
  const event = createAgentEvent(
    { engine: "codesplash", localSessionId: "one", sequence: 0 },
    { kind: "user.message", payload: { id: "u1", text: "Investigate sapphire. password=verysecretvalue" } },
  )
  await handle.appendEventLines([JSON.stringify(event)])
  return { root, store, repository, meta, handle, event }
}
test("control commit is immutable, ignores orphan records and rejects stale revisions", async () => {
  const { handle } = await fixture()
  const first = updateControl(handle.directory, "", "rename", (state) => {
    state.title = "First"
  })
  atomic(join(handle.directory, "control", `${crypto.randomUUID()}.json`), "orphan")
  expect(control(handle.directory)).toEqual(first)
  expect(() => updateControl(handle.directory, "", "stale", () => {})).toThrow("changed")
  expect(control(handle.directory).state.title).toBe("First")
  const path = join(handle.directory, "control", `${first.revision}.json`)
  writeFileSync(path, readFileSync(path, "utf8").replace("First", "Tampered"))
  expect(() => control(handle.directory)).toThrow("Corrupt")
})
test("no-history state supports revisions without writing files", () => {
  const state = new MemorySessionState()
  const first = state.update("", "queue", (s) => {
    s.values.queue = [{ id: "one", text: "hello" }]
  })
  first.state.values.queue = []
  expect(state.read().state.values.queue).toEqual([{ id: "one", text: "hello" }])
  expect(() => state.update("", "stale", () => {})).toThrow()
})
test("live and foreign owners block maintenance; dead same-host owners recover", async () => {
  const { repository, meta, handle } = await fixture()
  const recorder = new SessionRecorder(handle)
  await expect(repository.archive(meta, true)).rejects.toThrow("active")
  await recorder.close("closed")
  const path = join(handle.directory, "writer.lease")
  atomic(path, JSON.stringify({ host: "foreign-host", pid: process.pid, nonce: "foreign" }))
  expect(() => lease(handle.directory)).toThrow("another host")
  atomic(path, JSON.stringify({ host: hostId(), pid: 2147483647, nonce: "dead" }))
  const release = lease(handle.directory)
  expect(existsSync(path)).toBe(true)
  release()
  expect(existsSync(path)).toBe(false)
})
test("lease release never unlinks a replacement owner", async () => {
  const { handle } = await fixture(),
    path = join(handle.directory, "writer.lease")
  const release = lease(handle.directory)
  atomic(path, JSON.stringify({ host: "replacement", pid: 1, nonce: "new" }))
  release()
  expect(existsSync(path)).toBe(true)
})

test("OS lock prevents stale lease reclamation while its original owner is still holding the lock", async () => {
  const { handle } = await fixture()
  const release = lease(handle.directory)
  atomic(
    join(handle.directory, "writer.lease"),
    JSON.stringify({ host: hostId(), pid: 2147483647, nonce: "stale-looking" }),
  )
  expect(() => lease(handle.directory)).toThrow("active")
  release()
  const replacement = lease(handle.directory)
  replacement()
})
test("path, symlink and hardlink reads refuse unsafe session storage", async () => {
  const { root, store, handle } = await fixture()
  await expect(store.open("..", "one")).rejects.toThrow("identifier")
  const target = join(root, "outside"),
    linked = join(handle.directory, "linked")
  atomic(target, "sensitive")
  symlinkSync(target, linked)
  expect(() => bytes(linked)).toThrow()
  rmSync(linked)
  linkSync(target, linked)
  expect(() => bytes(linked)).toThrow("unsafe")
})
test("rename, organization and archive survive deletion of the derived index", async () => {
  const { repository, meta, root } = await fixture()
  await repository.rename(meta, "Session title")
  await repository.move(meta, "Workspace group", "Backlog", 5)
  await repository.archive(meta, true)
  await repository.reindex()
  rmSync(join(root, ".index"), { recursive: true })
  const page = await repository.list({
    archived: true,
    query: "sapphire",
    organization: "Workspace group",
    section: "Backlog",
  })
  expect(page.sessions[0]).toMatchObject({
    title: "Session title",
    archived: true,
    position: 5,
    projectPath: "/project",
    projectId: "project",
  })
  expect(await listProjectSessions("project", root)).toHaveLength(0)
  expect(await listProjectSessions("project", root, true)).toHaveLength(1)
})
test("search redacts credentials, ignores reasoning, refreshes stale rows and repairs a corrupt index", async () => {
  const { repository, meta, handle, root } = await fixture()
  const secret = createAgentEvent(
    { engine: "codesplash", localSessionId: "one", sequence: 1 },
    { kind: "reasoning.completed", payload: { id: "r", text: "reasoningneedle" } },
  )
  await handle.appendEventLines([
    JSON.stringify(secret),
    JSON.stringify({
      ...createAgentEvent(
        { engine: "codesplash", localSessionId: "one", sequence: 2 },
        { kind: "message.completed", payload: { id: "a", text: "Assistant answer" } },
      ),
      sensitive: true,
    }),
  ])
  expect((await repository.list({ query: "sapphire" })).total).toBe(1)
  expect(existsSync(join(root, ".index"))).toBe(false)
  await repository.reindex()
  expect((await repository.list({ query: "verysecretvalue" })).total).toBe(0)
  expect((await repository.list({ query: "reasoningneedle" })).total).toBe(0)
  expect((await repository.list({ query: "Assistant answer" })).total).toBe(1)
  await repository.rename(meta, "Fresh title")
  expect((await repository.list({ query: "Fresh" })).total).toBe(1)
  const file = readdirSync(join(root, ".index")).find((name) => name.endsWith(".sqlite")) as string
  writeFileSync(join(root, ".index", file), "corrupt")
  expect((await repository.list({ query: "sapphire" })).total).toBe(1)
  await repository.reindex()
  expect((await repository.list({ query: "sapphire" })).warnings).toEqual([])
})

test("index metadata excludes credential values and opaque canonical namespace bodies", async () => {
  const { repository, handle } = await fixture()
  await handle.updateMeta({ title: "password=METADATA_SECRET_CANARY" })
  updateControl(handle.directory, "", "fixture", (state) => {
    state.values.privateBody = "OPAQUE_CONTROL_CANARY"
  })
  await repository.reindex()
  const file = readdirSync(repository.indexRoot).find((name) => name.endsWith(".sqlite")) as string
  const bytes = readFileSync(join(repository.indexRoot, file))
  expect(bytes.includes(Buffer.from("METADATA_SECRET_CANARY"))).toBe(false)
  expect(bytes.includes(Buffer.from("OPAQUE_CONTROL_CANARY"))).toBe(false)
  expect((await repository.list()).sessions[0]?.title).toBe("password=[REDACTED]")
})
test("delete tombstone prevents history resurrection and removes indexed content", async () => {
  const { repository, meta, handle, root } = await fixture()
  await repository.reindex()
  await repository.maintenance(meta, "delete", "")
  expect(existsSync(join(root, ".index"))).toBe(false)
  atomic(join(handle.directory, "meta.json"), JSON.stringify(meta))
  expect(await readSessionMeta(handle.directory)).toBeUndefined()
  expect(await repository.all()).toEqual([])
  expect((await repository.reindex()).sessions).toBe(0)
})
test("legacy migration previews, preserves identity and refuses uncertain active metadata", async () => {
  const { repository, meta, handle } = await fixture(1)
  await handle.updateMeta({ lastStatus: "running" })
  await expect(repository.maintenance(meta, "migrate", "")).rejects.toThrow("Legacy session")
  expect((await readSessionMeta(handle.directory))?.schemaVersion).toBe(1)
  await repository.maintenance(meta, "recover", "")
  await repository.maintenance(meta, "migrate", control(handle.directory).revision)
  expect(await readSessionMeta(handle.directory)).toMatchObject({
    schemaVersion: 2,
    localSessionId: "one",
    projectId: "project",
  })
  expect(JSON.parse(readFileSync(join(handle.directory, "meta.v1.backup.json"), "utf8")).schemaVersion).toBe(
    1,
  )
})
test("interrupted migration is explicitly recoverable, but changed legacy data is never discarded", async () => {
  const { repository, meta, handle } = await fixture(1)
  updateControl(handle.directory, "", "migrate", (state) => {
    state.migrated = true
    state.values.migrationMeta = { ...meta, schemaVersion: 2 }
    state.values.migrationSourceHash = digest(JSON.stringify(meta))
  })
  await expect(readSessionMeta(handle.directory)).rejects.toThrow("migration")
  const recovered = await repository.resolve("one", undefined, true)
  await repository.maintenance(recovered, "recover", control(handle.directory).revision)
  expect((await readSessionMeta(handle.directory))?.schemaVersion).toBe(2)
  atomic(join(handle.directory, "meta.json"), JSON.stringify({ ...meta, lastSequence: 999 }))
  await expect(repository.resolve("one", undefined, true)).rejects.toThrow("Legacy session writer")
})
test("gzip compression resumes events and native transcript without losing original bytes", async () => {
  const { repository, meta, handle, store } = await fixture()
  const transcript = join(handle.directory, "transcript.jsonl"),
    source = Buffer.from('{"messages":"unicode ✓"}\n')
  atomic(transcript, source)
  const before = readFileSync(handle.eventsPath)
  await repository.maintenance(meta, "compress", "")
  expect(existsSync(handle.eventsPath)).toBe(false)
  expect(logBytes(transcript)).toEqual(source)
  expect(logBytes(handle.eventsPath)).toEqual(before)
  const reopened = await store.open("project", "one"),
    recorder = new SessionRecorder(reopened)
  expect(existsSync(transcript)).toBe(true)
  recorder.record(
    createAgentEvent(
      { engine: "codesplash", localSessionId: "one", sequence: 1 },
      { kind: "user.message", payload: { id: "u2", text: "next" } },
    ),
  )
  await recorder.close("closed")
  expect((await readSessionEvents(handle.directory)).events).toHaveLength(2)
  expect(readFileSync(transcript)).toEqual(source)
})
test("compression crashes retain recoverable content and conflicting representations fail explicitly", async () => {
  const { handle } = await fixture()
  const original = readFileSync(handle.eventsPath)
  compressLogs(handle.directory)
  atomic(handle.eventsPath, original)
  expect(logBytes(handle.eventsPath)).toEqual(original)
  atomic(handle.eventsPath, "external change")
  expect(() => logBytes(handle.eventsPath)).toThrow("Conflicting")
  rmSync(handle.eventsPath)
  atomic(`${handle.eventsPath}.gz`, "bad gzip")
  expect(() => logBytes(handle.eventsPath)).toThrow()
})
test("query limits and ambiguous titles are explicit", async () => {
  const { repository, store, meta } = await fixture()
  await store.create({ ...meta, localSessionId: "two" })
  await expect(repository.resolve("Original")).rejects.toThrow("Ambiguous")
  await expect(repository.list({ limit: 101 })).rejects.toThrow("limit")
  await expect(repository.list({ query: "x".repeat(1001) })).rejects.toThrow("query")
  expect((await repository.list({ limit: 1 })).next).toBe(1)
})

test("cancelled reindex preserves the published generation and reports its progress cursor", async () => {
  const { repository } = await fixture()
  await repository.reindex()
  const pointer = join(repository.indexRoot, `${hostId()}.json`),
    before = readFileSync(pointer, "utf8"),
    abort = new AbortController()
  await expect(
    repository.reindex({
      signal: abort.signal,
      onProgress: (progress) => {
        expect(progress.cursor).toBe("project/one")
        abort.abort(new Error("Cancelled"))
      },
    }),
  ).rejects.toThrow("Cancelled")
  expect(readFileSync(pointer, "utf8")).toBe(before)
  expect((await repository.list({ query: "sapphire" })).total).toBe(1)
})
test("CLI maintenance defaults to preview and lifecycle changes are visible", async () => {
  const { repository, handle } = await fixture()
  let output = ""
  const options = {
    repository,
    output: (text: string) => {
      output += text
    },
  }
  await runSessionCommand(["compress", "one", "--json"], options)
  expect(JSON.parse(output).apply).toContain("--apply")
  expect(existsSync(handle.eventsPath)).toBe(true)
  output = ""
  await runSessionCommand(["rename", "one", "A renamed session", "--json"], options)
  expect(JSON.parse(output).title).toBe("A renamed session")
  await runSessionCommand(["compress", "one", "--apply"], options)
  expect(existsSync(handle.eventsPath)).toBe(false)
})
test("a stale opened handle refreshes its append boundary when it acquires ownership", async () => {
  const { store, handle } = await fixture()
  const stale = await store.open("project", "one")
  const first = new SessionRecorder(handle)
  first.record(
    createAgentEvent(
      { engine: "codesplash", localSessionId: "one", sequence: 1 },
      { kind: "user.message", payload: { id: "u2", text: "preserve me" } },
    ),
  )
  await first.close("closed")
  const second = new SessionRecorder(stale)
  second.record(
    createAgentEvent(
      { engine: "codesplash", localSessionId: "one", sequence: 2 },
      { kind: "user.message", payload: { id: "u3", text: "after stale open" } },
    ),
  )
  await second.close("closed")
  expect((await readSessionEvents(handle.directory)).events.map((e) => e.sequence)).toEqual([0, 1, 2])
})

test("warm index reconciles new sessions and preserves intents while a writer remains active", async () => {
  const { repository, handle, store, meta } = await fixture()
  await repository.reindex()
  const recorder = new SessionRecorder(handle)
  await repository.reindex()
  recorder.record(
    createAgentEvent(
      { engine: "codesplash", localSessionId: "one", sequence: 1 },
      { kind: "message.completed", payload: { id: "late", text: "Late ultramarine response" } },
    ),
  )
  await recorder.flush()
  expect((await repository.list({ query: "ultramarine" })).total).toBe(1)
  await recorder.close("closed")
  await repository.reindex()
  await store.create({ ...meta, localSessionId: "new", title: "Newest session" })
  expect((await repository.list()).total).toBe(2)
  expect((await repository.list({ query: "Newest" })).sessions[0]?.localSessionId).toBe("new")
})

test("search reports limited excerpts after reindex and does not interpret FTS operators", async () => {
  const { repository, handle } = await fixture()
  const event = createAgentEvent(
    { engine: "codesplash", localSessionId: "one", sequence: 1 },
    { kind: "message.completed", payload: { id: "large", text: `prefix ${"a".repeat(1024 * 1024)}` } },
  )
  await handle.appendEventLines([JSON.stringify(event)])
  expect((await repository.reindex()).truncated).toBe(1)
  expect((await repository.list({ query: "prefix" })).warnings[0]).toContain("truncated")
  expect((await repository.list({ query: 'prefix OR "unknown"' })).total).toBe(0)
})

test("direct handle writes honor competing ownership and a valid unterminated line stays intact", async () => {
  const { store, handle, event } = await fixture()
  const other = await store.open("project", "one"),
    recorder = new SessionRecorder(handle)
  await expect(other.updateMeta({ title: "competing" })).rejects.toThrow("active")
  await recorder.close("closed")
  atomic(handle.eventsPath, JSON.stringify(event))
  await other.appendEventLines([JSON.stringify({ ...event, sequence: 1 })])
  expect((await readSessionEvents(handle.directory)).events.map((e) => e.sequence)).toEqual([0, 1])
})
