import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveConfig } from "../../src/core/config/resolver.ts"
import { validateConfig } from "../../src/core/config.ts"
import { narrowOrchestration } from "../../src/core/orchestration/config.ts"
import { MutationCoordinator } from "../../src/core/orchestration/mutations.ts"
import { TaskOutput } from "../../src/core/orchestration/output.ts"
import { TaskRegistry } from "../../src/core/orchestration/tasks.ts"
import { type FileChanges, FileWatchService } from "../../src/core/orchestration/watch.ts"
import { MemorySessionState } from "../../src/core/session/control.ts"
import { canonicalRoot } from "../../src/core/session/files.ts"

const roots: string[] = []
const fixture = () => {
  const root = canonicalRoot(mkdtempSync(join(tmpdir(), "cs-m7a-")))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Condition did not settle")
    await Bun.sleep(10)
  }
}

test("orchestration limits resolve profiles and managed narrowing without enabling work", async () => {
  const root = fixture(),
    path = join(root, "config.toml")
  writeFileSync(path, "[orchestration]\nmaxRunning=2\n[profiles.work.orchestration]\nmaxDepth=2\n")
  writeFileSync(join(root, "managed.toml"), "[required.orchestration]\nmaxRunning=8\nmaxDepth=1\n")
  const config = await resolveConfig(path, [], { cwd: root, env: {}, profile: "work", strict: true })
  expect(config.orchestration).toMatchObject({ maxRunning: 2, maxDepth: 1, maxQueued: 32 })
  expect(narrowOrchestration({ maxRunning: 8 }, { maxRunning: 3 })).toMatchObject({ maxRunning: 3 })
  expect(() => validateConfig({ orchestration: { maxDepth: 9 } }, "test")).toThrow("maxDepth")
  expect(() => validateConfig({ orchestration: { enabled: true } }, "test")).toThrow("unknown")
})

test("task cancellation retains its slot until the actual callback settles", async () => {
  const state = new MemorySessionState(),
    registry = new TaskRegistry("root", state, { maxRunning: 1, maxQueued: 1 })
  const gate = deferred(),
    order: string[] = []
  const first = registry.submit({ kind: "test", label: "first" }, async () => {
    order.push("first")
    await gate.promise
  })
  const second = registry.submit({ kind: "test", label: "second" }, async () => {
    order.push("second")
  })
  expect(() => registry.submit({ kind: "test", label: "overflow" }, async () => {})).toThrow("queue is full")
  expect(() => new TaskRegistry("root", state)).toThrow("live owner")
  registry.interrupt(first.id)
  expect(registry.list().map((t) => t.status)).toEqual(["running", "queued"])
  expect(order).toEqual(["first"])
  gate.resolve()
  expect((await first.finished).status).toBe("cancelled")
  expect((await second.finished).status).toBe("completed")
  expect(order).toEqual(["first", "second"])
  const copy = registry.list()
  copy[0]!.label = "tampered"
  expect(registry.list()[0]!.label).toBe("first")
  await registry.close()
  expect(state.durable).toBe(false)
  const reopened = new TaskRegistry("root", state)
  expect(reopened.list().map((t) => t.status)).toEqual(["cancelled", "completed"])
  await reopened.close()
})

test("damaged journals fail closed; interrupted old-owner work is never replayed", async () => {
  const state = new MemorySessionState()
  state.update("", "fixture", (value) => {
    value.values.orchestration = { version: 999 }
  })
  expect(() => new TaskRegistry("root", state)).toThrow("Corrupt")
  const fresh = new MemorySessionState()
  fresh.update("", "fixture", (value) => {
    value.values.orchestration = {
      version: 1,
      root: "root",
      tasks: [
        {
          id: crypto.randomUUID(),
          owner: crypto.randomUUID(),
          root: "root",
          kind: "command",
          label: "old",
          depth: 0,
          status: "running",
          created: "",
          updated: "",
        },
      ],
    }
  })
  const registry = new TaskRegistry("root", fresh)
  expect(registry.list()[0]!.status).toBe("execution-uncertain")
  await registry.close()
})

test("output redacts split secrets, strips split controls and reports byte cursor loss", () => {
  const output = new TaskOutput(1024, ["long-secret"])
  output.append("safe long-")
  output.append("secret\x1b]52;c;EVIL")
  output.append("\x07\x1b[31m red\x1b[0m")
  output.close()
  expect(output.read().text).toBe("safe [REDACTED] red")
  const flood = new TaskOutput(1024)
  flood.append("🙂".repeat(1024))
  flood.close()
  const page = flood.read(0, 7)
  expect(page).toMatchObject({ text: "🙂", lost: true, start: 3072, cursor: 3076, end: 4096 })
  expect(flood.read(page.cursor, 8).text).toBe("🙂🙂")
  expect(() => flood.read(999999)).toThrow("cursor")
  expect(() => flood.append("late")).toThrow("closed")
})

test("overlapping and alias claims serialize; disjoint paths proceed and aborted waiters release", async () => {
  const root = fixture(),
    coordinator = new MutationCoordinator(join(root, "coord"))
  mkdirSync(join(root, "a"))
  mkdirSync(join(root, "b"))
  symlinkSync(join(root, "a"), join(root, "alias"))
  const gate = deferred(),
    order: string[] = []
  const first = coordinator.run([join(root, "a")], new AbortController().signal, async () => {
    order.push("first")
    await gate.promise
    order.push("finish")
  })
  await until(() => order.length === 1)
  const abort = new AbortController()
  const cancelled = coordinator
    .run([join(root, "alias/file")], abort.signal, async () => {
      order.push("MUST_NOT_RUN")
    })
    .catch(() => "cancelled")
  await coordinator.run([join(root, "b")], new AbortController().signal, async () => {
    order.push("disjoint")
  })
  abort.abort()
  expect(await cancelled).toBe("cancelled")
  const next = coordinator.run([join(root, "a/file")], new AbortController().signal, async () => {
    order.push("next")
  })
  gate.resolve()
  await Promise.all([first, next])
  expect(order).toEqual(["first", "disjoint", "finish", "next"])
  expect(JSON.parse(readFileSync(join(root, "coord/claims.json"), "utf8"))).toEqual([])
})

test("a killed process loses its OS claim; another process can recover it", async () => {
  const root = fixture(),
    coord = join(root, "coord"),
    ready = join(root, "ready")
  const source = `import {MutationCoordinator} from ${JSON.stringify(join(process.cwd(), "src/core/orchestration/mutations.ts"))}; const c=new MutationCoordinator(${JSON.stringify(coord)}); const release=await c.acquire([${JSON.stringify(join(root, "target"))}],new AbortController().signal); await Bun.write(${JSON.stringify(ready)},'ready'); setInterval(()=>{},1000);`
  const path = join(root, "owner.ts")
  writeFileSync(path, source)
  const processChild = Bun.spawn([process.execPath, path], { stdout: "ignore", stderr: "pipe" })
  try {
    await until(() => {
      try {
        return readFileSync(ready, "utf8") === "ready"
      } catch {
        return false
      }
    })
    const c = new MutationCoordinator(coord)
    const timeout = AbortSignal.timeout(80)
    const refusal = await c.acquire([join(root, "target")], timeout).then(
      () => "admitted",
      () => "refused",
    )
    expect(refusal).toBe("refused")
    processChild.kill("SIGKILL")
    await processChild.exited
    const release = await c.acquire([join(root, "target")], AbortSignal.timeout(2000))
    await release()
  } finally {
    processChild.kill()
    await processChild.exited
  }
})

test("watchers coalesce real writes, discover directories and release all handles", async () => {
  const root = fixture(),
    events: FileChanges[] = [],
    service = new FileWatchService()
  const close = service.subscribe(root, (event) => {
    events.push(event)
  })
  const other = service.subscribe(root, () => {
    throw new Error("observer failure")
  })
  expect(service.status()).toEqual({ roots: 1, handles: 1, subscribers: 2 })
  writeFileSync(join(root, "file"), "one")
  writeFileSync(join(root, "file"), "two")
  await until(() => events.some((e) => e.paths.includes(join(root, "file"))))
  mkdirSync(join(root, "child"))
  await until(() => service.status().handles === 2)
  writeFileSync(join(root, "child/nested"), "three")
  await until(() => events.some((e) => e.paths.includes(join(root, "child/nested"))))
  close()
  expect(service.status().subscribers).toBe(1)
  other()
  expect(service.status()).toEqual({ roots: 0, handles: 0, subscribers: 0 })
  service.close()
  expect(() => service.subscribe(root, () => {})).toThrow("closed")
})

test("output preserves surrogate pairs across producer chunks and retention boundaries", () => {
  const output = new TaskOutput(1024)
  output.append("\ud83d")
  output.append("\ude42")
  output.close()
  expect(output.read().text).toBe("🙂")
  const partial = new TaskOutput(1024)
  partial.append("\ud83d")
  partial.close()
  expect(partial.read().text).toBe("�")
})

test("multi-path reservations do not deadlock and cancelled queued tasks never execute", async () => {
  const root = fixture(),
    coordinator = new MutationCoordinator(join(root, "coord"))
  const gate = deferred(),
    started = deferred(),
    order: string[] = []
  const first = coordinator.run([join(root, "a"), join(root, "b")], AbortSignal.timeout(2000), async () => {
    started.resolve()
    await gate.promise
    order.push("first")
  })
  await started.promise
  const second = coordinator.run([join(root, "b"), join(root, "a")], AbortSignal.timeout(2000), async () => {
    order.push("second")
  })
  gate.resolve()
  await Promise.all([first, second])
  expect(order).toEqual(["first", "second"])
  const registry = new TaskRegistry("root", new MemorySessionState(), { maxRunning: 1, maxQueued: 2 })
  const stop = deferred()
  const running = registry.submit({ kind: "test", label: "running" }, async () => {
    await stop.promise
  })
  const queued = registry.submit({ kind: "test", label: "queued" }, async () => {
    throw new Error("must never execute")
  })
  registry.interrupt(queued.id)
  expect((await queued.finished).status).toBe("cancelled")
  stop.resolve()
  await running.finished
  await registry.close()
})

test("watcher limits fail explicitly and slow subscribers retain one coalesced delivery", async () => {
  const root = fixture(),
    service = new FileWatchService({ roots: 1, handles: 2, subscribers: 1, paths: 1, debounceMs: 10 })
  const gate = deferred(),
    events: FileChanges[] = []
  service.subscribe(root, async (event) => {
    events.push(event)
    await gate.promise
  })
  try {
    expect(() => service.subscribe(root, () => {})).toThrow("subscriber limit")
    writeFileSync(join(root, "first"), "one")
    await until(() => events.length === 1)
    writeFileSync(join(root, "second"), "two")
    writeFileSync(join(root, "third"), "three")
    // Observe handle admission to know the rename rescan/debounce has run.
    mkdirSync(join(root, "nested"))
    await until(() => service.status().handles === 2)
    expect(events).toHaveLength(1)
    gate.resolve()
    await until(() => events.length === 2)
    expect(events[1]!.rescan).toBe(true)
    expect(events[1]!.paths.length).toBeLessThanOrEqual(1)
  } finally {
    gate.resolve()
    service.close()
  }
  expect(service.status().handles).toBe(0)
})

test("unsafe coordination roots and corrupt claim journals fail closed", async () => {
  const root = fixture(),
    linked = join(root, "linked"),
    target = join(root, "target")
  mkdirSync(target)
  symlinkSync(target, linked)
  await expect(new MutationCoordinator(linked).acquire([root], AbortSignal.timeout(1000))).rejects.toThrow(
    "Unsafe",
  )
  const coord = join(root, "coord")
  mkdirSync(coord, { mode: 0o700 })
  writeFileSync(join(coord, "claims.json"), '[{"id":"../../victim"}]')
  await expect(new MutationCoordinator(coord).acquire([root], AbortSignal.timeout(1000))).rejects.toThrow(
    "Corrupt",
  )
})
