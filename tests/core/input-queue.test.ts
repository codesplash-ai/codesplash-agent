import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemorySessionState, type SessionStateAccess } from "../../src/core/session/control.ts"
import { InputQueue } from "../../src/core/session/input-queue.ts"
import { type InputCompletion, QueueRunner } from "../../src/core/session/queue-runner.ts"

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { resolve, promise }
}
test("submission acknowledgment deduplicates ids and rejects changed input and stale edits", () => {
  const queue = new InputQueue({ cwd: "/project" }),
    id = queue.newSubmissionId()
  const first = queue.submit({ text: "first" }, "follow-up", id)
  expect(queue.submit({ text: "first" }, "follow-up", id)).toEqual(first)
  expect(() => queue.submit({ text: "changed" }, "follow-up", id)).toThrow("different")
  queue.edit(id, { text: "edited" }, first.revision)
  expect(() => queue.remove(id, first.revision)).toThrow("changed")
  expect(queue.history()[0]?.input.text).toBe("edited")
})
test("acknowledgment failure cannot dispatch and does not clear a caller's input", () => {
  const memory = new MemorySessionState()
  let fail = false
  const state: SessionStateAccess = {
    durable: true,
    read: () => memory.read(),
    update: (revision, operation, change) => {
      if (fail) throw new Error("Disk full")
      return memory.update(revision, operation, change)
    },
  }
  const queue = new InputQueue({ cwd: "/project", state }),
    input = { text: "keep this draft" }
  fail = true
  expect(() => queue.submit(input)).toThrow("Disk full")
  expect(input.text).toBe("keep this draft")
  expect(queue.snapshot().items).toHaveLength(0)
})
test("restart holds pending input and marks possibly admitted work uncertain without automatic retry", () => {
  const state = new MemorySessionState(),
    queue = new InputQueue({ cwd: "/project", state })
  const active = queue.submit({ text: "running" }),
    pending = queue.submit({ text: "waiting" })
  queue.admit(active.id)
  queue.running(active.id)
  const recovered = new InputQueue({ cwd: "/project", state })
  expect(recovered.snapshot().paused).toBe(true)
  expect(recovered.snapshot().items[0]?.status).toBe("execution-uncertain")
  expect(recovered.next()).toBeUndefined()
  expect(() => recovered.retry(active.id, recovered.snapshot().revision)).toThrow("repeat external")
  recovered.resume()
  expect(recovered.next()?.id).toBe(pending.id)
  recovered.retry(active.id, recovered.snapshot().revision, true)
  expect(recovered.snapshot().items[0]?.status).toBe("queued")
})
test("structured sanitization preserves ids and admission uses the original in-memory input", () => {
  const memory = new MemorySessionState(),
    state: SessionStateAccess = {
      durable: true,
      read: () => memory.read(),
      update: (...args) => memory.update(...args),
    }
  const queue = new InputQueue({ cwd: "/project", state }),
    text = 'password=reallysecretvalue "quoted"'
  const ack = queue.submit({ text })
  expect(JSON.stringify(memory.read())).not.toContain("reallysecretvalue")
  expect(queue.admit(ack.id).text).toBe(text)
  expect(queue.snapshot().items[0]?.id).toBe(ack.id)
})
test("file references detect same-length metadata changes and are never expanded at enqueue", async () => {
  const root = mkdtempSync(join(tmpdir(), "m5-input-"))
  try {
    const path = join(root, "file.txt")
    writeFileSync(path, "before")
    const queue = new InputQueue({ cwd: root }),
      ack = queue.submit({ text: "!`touch never`", files: ["file.txt"] })
    // Linux may coalesce timestamps for writes within one clock tick. Test an observable metadata change.
    await Bun.sleep(10)
    writeFileSync(path, "after!")
    expect(() => queue.admit(ack.id)).toThrow("changed")
    expect(queue.snapshot().items[0]?.status).toBe("queued")
    queue.edit(ack.id, { text: "revalidated", files: ["file.txt"] }, queue.snapshot().revision)
    expect(queue.admit(ack.id).text).toBe("revalidated")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test("stashes refuse collisions and stale pop; no-history data stays in memory", () => {
  const queue = new InputQueue({ cwd: "/project" })
  const stash = queue.saveStash("draft", { text: "line one\nline two" }, queue.snapshot().revision)
  const previous = queue.snapshot().revision
  expect(() => queue.saveStash("draft", { text: "overwrite" }, previous)).toThrow("exists")
  queue.submit({ text: "accepted typed prompt" })
  expect(() => queue.dropStash(stash.id, previous)).toThrow("changed")
  expect(queue.recall(queue.stash("draft")).text).toBe("line one\nline two")
  queue.dropStash(stash.id, queue.snapshot().revision)
  expect(queue.snapshot().stashes).toHaveLength(0)
  expect(new InputQueue({ cwd: "/project" }).history()).toEqual([])
})
test("input and queue limits fail before acknowledgment", () => {
  const queue = new InputQueue({ cwd: "/project" })
  expect(() => queue.submit({ text: "a".repeat(64 * 1024 + 1) })).toThrow("64 KiB")
  expect(() => queue.submit({ text: "" })).toThrow("requires")
  for (let i = 0; i < 100; i++) queue.submit({ text: `prompt ${i}` })
  expect(() => queue.submit({ text: "overflow" })).toThrow("full")
  expect(queue.snapshot().items).toHaveLength(100)
})
test("serial dispatch waits for complete interject cleanup and preserves queued follow-ups", async () => {
  const queue = new InputQueue({ cwd: "/project" }),
    calls: string[] = [],
    runs = new Map<string, ReturnType<typeof deferred<InputCompletion>>>(),
    cleanup = deferred<void>()
  let active: string | undefined
  const runner = new QueueRunner(queue, {
    busy: () => active !== undefined,
    async run(input) {
      const pending = deferred<InputCompletion>()
      calls.push(input.text)
      runs.set(input.text, pending)
      active = input.text
      try {
        return await pending.promise
      } finally {
        active = undefined
      }
    },
    async interrupt() {
      runs.get(active ?? "")?.resolve("cancelled")
      await cleanup.promise
    },
  })
  queue.submit({ text: "first" })
  await tick()
  queue.submit({ text: "follow-up" })
  await tick()
  expect(calls).toEqual(["first"])
  queue.submit({ text: "interject" }, "interject")
  await tick()
  expect(calls).toEqual(["first"])
  cleanup.resolve()
  await tick()
  expect(calls).toEqual(["first", "interject"])
  runs.get("interject")?.resolve("completed")
  await tick()
  expect(calls).toEqual(["first", "interject", "follow-up"])
  runs.get("follow-up")?.resolve("completed")
  await tick()
  runner.stop()
  await runner.settled()
})
test("queue persistence failure at admission stops execution without an unhandled rejection", async () => {
  const memory = new MemorySessionState()
  let fail = false,
    calls = 0
  const state: SessionStateAccess = {
    durable: true,
    read: () => memory.read(),
    update: (...args) => {
      if (fail) throw new Error("Disk full")
      return memory.update(...args)
    },
  }
  const queue = new InputQueue({ cwd: "/project", state })
  queue.submit({ text: "must not run" })
  const runner = new QueueRunner(queue, {
    busy: () => false,
    async run() {
      calls++
      return "completed"
    },
    async interrupt() {},
  })
  fail = true
  runner.wake()
  await tick()
  expect(calls).toBe(0)
  expect(runner.failure?.message).toBe("Disk full")
  runner.stop()
  await runner.settled()
})

test("explicit inactive review permits one clean resume but never replays admitted input", () => {
  const state = new MemorySessionState(),
    queue = new InputQueue({ cwd: "/project", state })
  const ack = queue.submit({ text: "review me" })
  queue.pause()
  const inactive = new InputQueue({ cwd: "/project", state })
  inactive.resume()
  const opened = new InputQueue({ cwd: "/project", state })
  expect(opened.next()?.id).toBe(ack.id)
  opened.admit(ack.id)
  opened.running(ack.id)
  const crashed = new InputQueue({ cwd: "/project", state })
  expect(crashed.snapshot().paused).toBe(true)
  expect(crashed.snapshot().items[0]?.status).toBe("execution-uncertain")
})
test("redacted uncertain captures become editable only after explicit retry acknowledgment", () => {
  const memory = new MemorySessionState(),
    state: SessionStateAccess = {
      durable: true,
      read: () => memory.read(),
      update: (...args) => memory.update(...args),
    }
  const queue = new InputQueue({ cwd: "/project", state })
  const ack = queue.submit({ text: "password=supersecretvalue" })
  queue.admit(ack.id)
  const recovered = new InputQueue({ cwd: "/project", state })
  recovered.retry(ack.id, recovered.snapshot().revision, true)
  expect(recovered.snapshot().items[0]?.status).toBe("blocked")
  recovered.edit(ack.id, { text: "revised prompt" }, recovered.snapshot().revision)
  expect(recovered.snapshot().items[0]?.status).toBe("queued")
})
test("malformed persisted queue and history are refused before dispatch", () => {
  const state = new MemorySessionState(),
    queue = new InputQueue({ cwd: "/project", state })
  queue.submit({ text: "okay" })
  state.update(state.read().revision, "corrupt", (value) => {
    ;(value.values.inputQueue as { history: unknown[] }).history = [{ id: "fake", input: { text: "bad" } }]
  })
  expect(() => queue.snapshot()).toThrow("Corrupt")
})
