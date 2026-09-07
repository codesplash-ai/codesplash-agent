import { afterEach, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validateMemoryConfig } from "../../../src/engines/codesplash/memory/config.ts"
import type { MemoryRecord } from "../../../src/engines/codesplash/memory/contracts.ts"
import {
  ensureIdentity,
  linkIdentity,
  memoryHash,
  memoryIdentity,
} from "../../../src/engines/codesplash/memory/identity.ts"
import { MemoryIndex, writeIndex } from "../../../src/engines/codesplash/memory/retrieval.ts"
import { MemorySession } from "../../../src/engines/codesplash/memory/session.ts"
import { MemoryStore } from "../../../src/engines/codesplash/memory/store.ts"
import { createPermissionRuntime } from "../../../src/engines/codesplash/permissions.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "codesplash-memory-")))
  roots.push(path)
  return path
}
const signal = () => new AbortController().signal
function record(text: string, extra: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: crypto.randomUUID(),
    revision: 1,
    scope: "repo",
    worktree: memoryHash("fixture"),
    kind: "fact",
    source: "user",
    session: "fixture",
    sources: [],
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    text,
    ...extra,
  }
}
test("Markdown manifest is authoritative and stale writes cannot overwrite a concurrent change", () => {
  const root = fixture(),
    store = new MemoryStore(root),
    a = record("Remember transaction boundaries")
  const first = store.commit("", [a])
  expect(store.snapshot()).toEqual(first)
  expect(readFileSync(join(root, "objects", readdirSync(join(root, "objects"))[0] ?? ""), "utf8")).toContain(
    a.text,
  )
  store.commit(first.revision, [{ ...a, revision: 2, text: "New text" }])
  expect(() => store.commit(first.revision, [a])).toThrow("concurrently")
  expect(store.snapshot().records[0]?.text).toBe("New text")
})
test("deletion and repair do not resurrect unreferenced crash objects", () => {
  const root = fixture(),
    store = new MemoryStore(root),
    first = store.commit("", [record("DELETE_CANARY")])
  const orphan = `${crypto.randomUUID()}-${crypto.randomUUID()}.md`
  writeFileSync(join(root, "objects", orphan), "ORPHAN_CANARY")
  store.commit(first.revision, [])
  store.repair()
  expect(store.snapshot().records).toEqual([])
  expect(readdirSync(join(root, "objects"))).toEqual([])
})
test("corrupt manifests and symlink records fail without resetting the store", () => {
  const root = fixture(),
    store = new MemoryStore(root)
  store.commit("", [record("CANARY")])
  const object = readdirSync(join(root, "objects"))[0] ?? ""
  rmSync(join(root, "objects", object))
  symlinkSync("/etc/passwd", join(root, "objects", object))
  expect(() => store.snapshot()).toThrow()
  writeFileSync(join(root, "manifest.json"), "broken")
  expect(() => store.snapshot()).toThrow()
  expect(readFileSync(join(root, "manifest.json"), "utf8")).toBe("broken")
})
test("lexical relevance and MMR select useful diverse facts; corrupt indexes fall back without writes", () => {
  const root = fixture(),
    store = new MemoryStore(root),
    a = record("Parser transactions use an atomic manifest"),
    duplicate = record(a.text),
    b = record("Parser validation rejects invalid input"),
    noise = record("The garden needs watering")
  const snapshot = store.commit("", [a, duplicate, b, noise])
  writeIndex(root, snapshot)
  let index = new MemoryIndex(root, snapshot)
  const result = index.search("parser", snapshot.records)
  expect(result.records).toHaveLength(2)
  expect(result.records.every((r) => r.record.id !== noise.id)).toBe(true)
  index.close()
  writeFileSync(join(root, "index.sqlite"), "corrupt")
  index = new MemoryIndex(root, snapshot)
  expect(index.fallback).toBe(true)
  expect(index.search("validation", snapshot.records).records[0]?.record.id).toBe(b.id)
  index.close()
  expect(readFileSync(join(root, "index.sqlite"), "utf8")).toBe("corrupt")
})
test("semantic search retrieves a lexical miss and ignores mismatched model vectors", () => {
  const root = fixture(),
    store = new MemoryStore(root),
    a = record("A cyclist repairs a punctured wheel"),
    noise = record("SQL indexes accelerate queries"),
    snapshot = store.commit("", [a, noise])
  writeIndex(root, snapshot, [
    { id: a.id, hash: memoryHash(a.text), key: "v1", values: [1, 0] },
    { id: noise.id, hash: memoryHash(noise.text), key: "v1", values: [0, 1] },
  ])
  const index = new MemoryIndex(root, snapshot)
  expect(index.search("bicycle", snapshot.records, { key: "v1", values: [1, 0] }).records[0]?.record.id).toBe(
    a.id,
  )
  expect(index.search("bicycle", snapshot.records, { key: "v2", values: [1, 0] }).records).toHaveLength(0)
  index.close()
})
test("identity links are explicit, isolated directories create no state on read", async () => {
  const root = join(fixture(), "memory"),
    one = fixture(),
    two = fixture(),
    a = await memoryIdentity(root, one, signal()),
    b = await memoryIdentity(root, two, signal())
  expect(a.key).not.toBe(b.key)
  expect(a.repository).toBeUndefined()
  const id = ensureIdentity(root, a)
  expect(linkIdentity(root, b, id)).toContain("Preview")
  expect((await memoryIdentity(root, two, signal())).repository).toBeUndefined()
  linkIdentity(root, b, id, true)
  expect((await memoryIdentity(root, two, signal())).repository).toBe(id)
})
test("config refuses plaintext keys and invalid vector limits", () => {
  for (const config of [
    { autoLearn: "yes" },
    { embedding: { apiKey: "CANARY" } },
    { enabled: 1 },
    { embedding: { url: "https://example.com/embeddings", model: "x", keyEnvVar: "KEY", dimensions: 9999 } },
  ])
    expect(() => validateMemoryConfig(config)).toThrow()
  expect(validateMemoryConfig({ enabled: true, autoLearn: false })).toEqual({
    enabled: true,
    autoLearn: false,
  })
})
test("no-history and untrusted sessions never create durable memory; read-only cannot write", async () => {
  for (const state of [
    { history: false, trusted: true, write: true },
    { history: true, trusted: false, write: true },
    { history: true, trusted: true, write: false },
  ]) {
    const parent = fixture(),
      root = join(parent, "memory"),
      cwd = fixture(),
      permissions = await createPermissionRuntime({
        cwd,
        mode: "default",
        workspaceTrusted: false,
        configRules: { allow: [], ask: [], deny: [] },
      })
    const memory = new MemorySession({
      root,
      cwd,
      session: "fixture",
      history: state.history,
      trusted: state.trusted,
      writable: () => state.write,
      permissions,
      sanitize: (s) => s,
    })
    await expect(memory.remember("NO_WRITE", signal())).rejects.toThrow()
    expect(readdirSync(parent)).toEqual([])
  }
})
test("Git worktrees share repo facts, subfolders share worktree identity, clones and moved directories require linking", async () => {
  const parent = fixture(),
    root = join(parent, "memory"),
    repo = join(parent, "repo"),
    branch = join(parent, "branch"),
    clone = join(parent, "clone")
  mkdirSync(repo)
  const git = (args: string[], cwd = repo) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode) throw new Error(result.stderr.toString())
  }
  git(["init", "-q"])
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  ])
  git(["worktree", "add", "-qb", "fixture", branch])
  git(["clone", "-q", repo, clone])
  mkdirSync(join(repo, "sub"))
  const a = await memoryIdentity(root, repo, signal()),
    b = await memoryIdentity(root, branch, signal()),
    c = await memoryIdentity(root, clone, signal()),
    sub = await memoryIdentity(root, join(repo, "sub"), signal())
  expect(a.key).toBe(b.key)
  expect(a.worktree).not.toBe(b.worktree)
  expect(c.key).not.toBe(a.key)
  expect(sub.worktree).toBe(a.worktree)
  const id = ensureIdentity(root, a)
  expect((await memoryIdentity(root, branch, signal())).repository).toBe(id)
  expect((await memoryIdentity(root, clone, signal())).repository).toBeUndefined()
  const permissions = await createPermissionRuntime({
    cwd: repo,
    mode: "default",
    workspaceTrusted: true,
    configRules: { allow: [], ask: [], deny: [] },
  })
  const one = new MemorySession({
    cwd: repo,
    root,
    session: "one",
    history: true,
    trusted: true,
    writable: () => true,
    permissions,
    sanitize: (s) => s,
  })
  await one.remember("Shared parser fact", signal())
  const candidate = await one.remember("Branch parser observation", signal(), { generated: true })
  await one.mutate(candidate.id, "accept", undefined, signal())
  const two = new MemorySession({ ...one.options, cwd: branch })
  expect((await two.search("parser", signal())).records.map((r) => r.record.text)).toEqual([
    "Shared parser fact",
  ])
})
test("selection stays stable until refresh and rechecks source denials; readonly fallback does not repair disk", async () => {
  const cwd = fixture(),
    root = join(fixture(), "memory")
  let denied = false
  const permissions = await createPermissionRuntime({
    cwd,
    mode: "default",
    workspaceTrusted: true,
    configRules: { allow: [], ask: [], deny: [] },
  })
  permissions.isReadDenied = () => (denied ? "denied" : undefined)
  const memory = new MemorySession({
    cwd,
    root,
    session: "one",
    history: true,
    trusted: true,
    writable: () => true,
    permissions,
    sanitize: (s) => s.replaceAll("SECRET_CANARY", "[REDACTED]"),
  })
  await memory.remember("Parser transaction fact", signal(), {
    sources: [{ id: "origin", hash: memoryHash("origin"), path: join(cwd, "origin.txt") }],
  })
  await memory.remember("Database indexing fact", signal())
  const runner = async () => ({
    type: "tool_result" as const,
    toolCallId: "fixture",
    text: "",
    isError: true,
  })
  const first = await memory.prepare("parser", signal(), runner)
  expect(first).toContain("Parser transaction")
  expect(await memory.prepare("database", signal(), runner)).toBe(first)
  denied = true
  expect(await memory.prepare("parser", signal(), runner)).toBe("")
  denied = false
  memory.invalidate()
  expect(await memory.prepare("database", signal(), runner)).toContain("Database indexing")
  const store = await memory.store(signal())
  if (!store) throw new Error("store")
  writeFileSync(join(store.root, "index.sqlite"), "broken")
  const readonly = new MemorySession({ ...memory.options, writable: () => false })
  expect((await readonly.search("parser", signal())).records).toHaveLength(1)
  expect(readFileSync(join(store.root, "index.sqlite"), "utf8")).toBe("broken")
})
test("live locks refuse concurrent writes, dead locks recover, size limits fail before commit", () => {
  const root = fixture(),
    store = new MemoryStore(root),
    r = record("original")
  const before = store.commit("", [r])
  writeFileSync(join(root, "writer.lock"), JSON.stringify({ pid: process.pid }))
  expect(() => store.commit(before.revision, [])).toThrow("busy")
  writeFileSync(join(root, "writer.lock"), JSON.stringify({ pid: 2147483647 }))
  expect(store.commit(before.revision, [r]).records).toHaveLength(1)
  const good = store.snapshot()
  expect(() => store.commit(good.revision, [{ ...r, text: "x".repeat(4097) }])).toThrow()
  expect(store.snapshot()).toEqual(good)
})
