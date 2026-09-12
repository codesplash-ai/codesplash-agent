import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runWorkflowsCommand } from "../../src/commands/workflows.ts"
import {
  AutomationJournal,
  type AutomationRecord,
  workflowFingerprint,
  workflowOf,
} from "../../src/core/orchestration/automation.ts"
import { MemorySessionState } from "../../src/core/session/control.ts"
import { ChildBudget } from "../../src/engines/codesplash/orchestration/scope.ts"

const limits = { tokens: 65536, timeoutMs: 60000, rounds: 3 }
test("workflow graph rejects cycles, unknown effects and changed content", () => {
  const def = {
    version: 1,
    name: "test",
    enabled: false,
    limits,
    steps: [
      { id: "first", kind: "prompt", prompt: "Inspect", needs: ["second"] },
      { id: "second", kind: "parallel", needs: ["first"] },
    ],
  }
  expect(() => workflowOf(def)).toThrow("cycle")
  expect(() => workflowOf({ ...def, steps: [{ id: "x", kind: "eval", code: "evil" }] })).toThrow()
  const parsed = workflowOf({ ...def, steps: [{ id: "x", kind: "prompt", prompt: "Inspect" }] })
  expect(workflowFingerprint(parsed)).not.toBe(workflowFingerprint({ ...parsed, enabled: true }))
  expect(() => workflowOf({ ...parsed, limits: { ...limits, timeoutMs: Infinity } })).toThrow()
})
test("new automation owner preserves uncertain intents and conservatively debits reserved usage", () => {
  const state = new MemorySessionState(),
    journal = new AutomationJournal(state)
  const record: AutomationRecord = {
    id: crypto.randomUUID(),
    kind: "goal",
    objective: "Inspect",
    status: "running",
    identity: "fixture",
    limits,
    used: 12,
    reserved: 999,
    uncertain: false,
    elapsedMs: 2,
    started: Date.now() - 100,
    round: 1,
    steps: [{ id: "worker", status: "running", task: crypto.randomUUID() }],
  }
  journal.update((rows) => rows.push(record))
  new AutomationJournal(state).recover()
  const after = journal.list()[0]!
  expect(after.status).toBe("paused")
  expect(after.steps[0]!.status).toBe("execution-uncertain")
  expect(after.used).toBe(1011)
  expect(after.reserved).toBe(0)
  expect(after.uncertain).toBe(true)
  expect(after.elapsedMs).toBeGreaterThanOrEqual(102)
})
test("ancestor auxiliary reservations persist before dispatch and unknown debit cannot be refunded", () => {
  const snapshots: Array<{ used: number; reserved: number; uncertain: boolean }> = []
  const parent = new ChildBudget(1000, 10000, undefined, (b) =>
      snapshots.push({ used: b.used, reserved: b.reserved, uncertain: b.uncertain }),
    ),
    child = new ChildBudget(900, 10000, parent)
  const finish = child.reserveAuxiliary(600)
  expect(snapshots[0]).toEqual({ used: 0, reserved: 600, uncertain: false })
  expect(() => child.reserveAuxiliary(301)).toThrow()
  finish(22)
  expect(parent.used).toBe(22)
  expect(parent.reserved).toBe(0)
  child.reserveAuxiliary(500)()
  expect(parent.used).toBe(522)
  expect(parent.uncertain).toBe(true)
  expect(() => child.reserveAuxiliary(1)).toThrow()
})
test("saved workflows require exact-source activation and migration remains inactive", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "cs-workflow-definition-")))
  let text = ""
  const run = async (args: string[]) => {
    text = ""
    await runWorkflowsCommand(args, {
      cwd,
      output: (value) => {
        text += value
      },
    })
    return JSON.parse(text)
  }
  try {
    await run(["create", "demo", "--write"])
    const first = await run(["show", "demo"])
    expect(first.definition.enabled).toBe(false)
    await expect(run(["enable", "demo", "--fingerprint", "0".repeat(64), "--apply"])).rejects.toThrow(
      "changed",
    )
    const enabled = await run(["enable", "demo", "--fingerprint", first.sourceFingerprint, "--apply"])
    expect(enabled.definition.enabled).toBe(true)
    const source = join(cwd, "literal.rhai")
    await Bun.write(
      source,
      'let meta = #{ name: "t", description: "d" }; let r = agent("work"); complete(r.output);',
    )
    const imported = await run(["import", source, "--name", "converted", "--write"])
    expect(imported.definition.enabled).toBe(false)
    expect(imported.definition.steps[0].prompt).toBe("work")
    await Bun.write(source, 'import "evil"; complete(run("rm"));')
    await expect(run(["import", source, "--name", "refused", "--write"])).rejects.toThrow(
      "Unsupported workflow semantics",
    )
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
