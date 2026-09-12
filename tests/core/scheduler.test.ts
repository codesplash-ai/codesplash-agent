import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { importSchedules, runSchedulerCommand } from "../../src/commands/scheduler.ts"
import type { AutomationRecord } from "../../src/core/orchestration/automation.ts"
import {
  cadence,
  intervalMs,
  type ScheduleSpec,
  ScheduleStore,
} from "../../src/core/orchestration/scheduler.ts"
import { TaskRegistry } from "../../src/core/orchestration/tasks.ts"
import { MemorySessionState } from "../../src/core/session/control.ts"
import { NativeScheduler } from "../../src/engines/codesplash/orchestration/scheduler.ts"

const spec: ScheduleSpec = {
  name: "inspect",
  prompt: "Inspect the workspace",
  interval: "1m",
  limits: { tokens: 65536, timeoutMs: 30000, rounds: 1 },
  maxOccurrences: 2,
  totalTokens: 131072,
  expiresAfterMs: 86400000,
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cs-schedule-"))),
    cwd = join(root, "repo")
  await mkdir(cwd)
  let clock = Date.now()
  const store = new ScheduleStore(cwd, join(root, "data"), () => clock)
  return {
    root,
    cwd,
    store,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms
    },
    close: async () => {
      store.releaseWorker()
      await rm(root, { recursive: true, force: true })
    },
  }
}
async function until(check: () => boolean | Promise<boolean>, timeout = 8000) {
  const end = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() >= end) throw new Error("Timed out waiting for scheduler fixture")
    await new Promise((r) => setTimeout(r, 25))
  }
}
test("scheduler validates exact recurrence and journals one missed occurrence with lifetime accounting", async () => {
  const f = await fixture()
  try {
    expect(intervalMs("1m")).toBe(60000)
    expect(() => intervalMs("1s")).toThrow()
    expect(() => cadence({ cron: "*/7 * * * *" })).toThrow()
    const s = f.store.create(spec, "identity", true)
    f.store.acquireWorker()
    expect(f.store.due()).toEqual([])
    f.advance(60000 * 5)
    const one = f.store.begin(s.id, "identity")
    expect(f.store.read().schedules[0]!.count).toBe(1)
    expect(f.store.read().schedules[0]!.reserved).toBe(65536)
    expect(() => f.store.begin(s.id, "identity")).toThrow()
    f.store.finish(one.id, { status: "completed", used: 7, output: "observed" })
    expect(f.store.due()).toEqual([])
    f.advance(60000)
    const two = f.store.begin(s.id, "identity")
    f.store.finish(two.id, { status: "completed", used: 9, output: "done" })
    const final = f.store.read().schedules[0]!
    expect(final.enabled).toBe(false)
    expect(final.count).toBe(2)
    expect(final.used).toBe(16)
    expect(final.reserved).toBe(0)
  } finally {
    await f.close()
  }
})
test("competing worker is excluded and restart never replays an uncertain occurrence", async () => {
  const f = await fixture(),
    other = new ScheduleStore(f.cwd, join(f.root, "data"), f.now)
  try {
    const s = f.store.create(spec, "identity", true)
    f.store.acquireWorker()
    expect(() => other.acquireWorker()).toThrow("active")
    f.advance(60000)
    const occurrence = f.store.begin(s.id, "identity")
    f.store.releaseWorker()
    other.acquireWorker()
    const state = other.read()
    expect(state.occurrences[0]!.status).toBe("execution-uncertain")
    expect(state.schedules[0]!.used).toBe(65536)
    expect(state.schedules[0]!.enabled).toBe(false)
    expect(() => other.enable(s.id, s.fingerprint, "identity")).toThrow("Review")
    expect(() => other.remove(s.id)).toThrow("Review")
    other.review(occurrence.id)
    other.enable(s.id, s.fingerprint, "identity")
    expect(other.due()).toEqual([])
    f.advance(60000)
    const future = other.begin(s.id, "identity")
    expect(future.id).not.toBe(occurrence.id)
    other.finish(future.id, { status: "failed", output: "unknown" })
    expect(other.read().schedules[0]!.used).toBe(131072)
  } finally {
    other.releaseWorker()
    await f.close()
  }
})
test("disabled migration preserves only recognized recurring semantics and explicit native budgets", async () => {
  const f = await fixture(),
    budgets = { limits: spec.limits, maxOccurrences: 2, totalTokens: 131072, expiresAfterMs: 86400000 }
  try {
    const imported = importSchedules(
      "claude",
      {
        tasks: [
          { id: "demo", cron: "*/5 * * * *", prompt: "Inspect", createdAt: Date.now(), recurring: true },
        ],
      },
      budgets,
    )
    expect(imported.unsupported).toEqual([])
    expect(imported.specs[0]!.cron).toBe("*/5 * * * *")
    expect(
      importSchedules(
        "claude",
        { tasks: [{ id: "unsafe", cron: "30 9 * * *", prompt: "Inspect", recurring: true }] },
        budgets,
      ).unsupported,
    ).toHaveLength(1)
    expect(
      importSchedules(
        "grok",
        { tasks: [{ id: "demo", interval_secs: 120, prompt: "Inspect", recurring: true, durable: true }] },
        budgets,
      ).specs[0]!.interval,
    ).toBe("120s")
    const source = join(f.root, "schedule.json")
    await Bun.write(source, JSON.stringify(spec))
    await runSchedulerCommand(["create", source, "--write"], {
      cwd: f.cwd,
      dataRoot: join(f.root, "data"),
      configPath: join(f.root, "config.toml"),
      output: () => {},
    })
    expect(f.store.read().schedules[0]!.enabled).toBe(false)
    expect(() => f.store.createMany([spec, { ...spec, name: "new" }], "identity")).toThrow("unique")
    expect(f.store.read().schedules).toHaveLength(1)
  } finally {
    await f.close()
  }
})
test("real coalesced file triggers exclude hidden paths, suppress feedback and release worker ownership", async () => {
  const f = await fixture(),
    tasks = new TaskRegistry(crypto.randomUUID(), new MemorySessionState()),
    records: AutomationRecord[] = []
  let runs = 0
  const scheduler = new NativeScheduler({
    cwd: f.cwd,
    dataRoot: join(f.root, "data"),
    session: crypto.randomUUID(),
    root: true,
    commands: { tasks },
    now: f.now,
    identity: async () => "identity",
    authorize: async () => {},
    observable: (path) => !path.endsWith("denied.txt"),
    automation: {
      control: async (_kind, raw) => {
        const v = raw as { action: string; id?: string; definition?: { limits: ScheduleSpec["limits"] } }
        if (v.action === "list") return structuredClone(records)
        if (v.action === "forget") {
          records.splice(
            records.findIndex((r) => r.id === v.id),
            1,
          )
          return {}
        }
        if (v.action === "pause") {
          const r = records.find((r) => r.id === v.id)!
          tasks.interrupt(r.task!)
          return r
        }
        const r: AutomationRecord = {
          id: crypto.randomUUID(),
          kind: "workflow",
          objective: "trigger",
          status: "running",
          identity: "identity",
          limits: v.definition!.limits,
          used: 0,
          reserved: 0,
          uncertain: false,
          elapsedMs: 0,
          round: 0,
          steps: [],
        }
        const handle = tasks.submit({ kind: "workflow", label: "trigger" }, async () => {
          runs++
          await Bun.write(join(f.cwd, "self.txt"), String(runs))
          await new Promise((resolve) => setTimeout(resolve, 200))
          r.status = "complete"
          r.used = 7
        })
        r.task = handle.id
        records.push(r)
        return structuredClone(r)
      },
    },
  })
  try {
    await mkdir(join(f.cwd, ".hidden"))
    const created = (await scheduler.control({
      action: "create",
      spec: { ...spec, watch: "." },
      enabled: true,
    })) as { id: string }
    await scheduler.control({ action: "start", durationMs: 10000 })
    await until(
      async () =>
        ((await scheduler.control({ action: "list" })) as { watching: string[] }).watching.length === 1,
    )
    f.advance(60000)
    await Bun.write(join(f.cwd, ".hidden", "ignored.txt"), "hidden")
    await new Promise((r) => setTimeout(r, 200))
    expect(runs).toBe(0)
    for (let i = 0; i < 8; i++) await Bun.write(join(f.cwd, "external.txt"), String(i))
    await until(() => f.store.read().occurrences[0]?.status === "completed")
    expect(runs).toBe(1)
    f.advance(60000)
    await new Promise((r) => setTimeout(r, 1500))
    expect(runs).toBe(1)
    await Bun.write(join(f.cwd, "external.txt"), "second external edit")
    await until(
      () => f.store.read().occurrences.length === 2 && f.store.read().occurrences[1]?.status === "completed",
    )
    expect(runs).toBe(2)
    expect(f.store.read().schedules.find((s) => s.id === created.id)?.enabled).toBe(false)
    await scheduler.stop()
    f.store.acquireWorker()
    f.store.releaseWorker()
  } finally {
    await scheduler.close()
    await tasks.close()
    await f.close()
  }
}, 15000)
test("expiry and backward clock movement cannot admit extra occurrences", async () => {
  const f = await fixture()
  try {
    const s = f.store.create({ ...spec, expiresAfterMs: 120000 }, "identity", true)
    f.store.acquireWorker()
    f.advance(-10000)
    expect(f.store.due()).toEqual([])
    f.advance(80000)
    const occurrence = f.store.begin(s.id, "identity")
    f.store.finish(occurrence.id, { status: "completed", used: 10, output: "done" })
    f.advance(50000)
    expect(f.store.due()).toEqual([])
    expect(() => f.store.begin(s.id, "identity", false, true)).toThrow("no longer admissible")
    expect(() => f.store.enable(s.id, s.fingerprint, "identity")).toThrow("expiry")
  } finally {
    await f.close()
  }
})
