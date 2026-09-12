import type { ScheduleOccurrence, ScheduleRecord, ScheduleSpec } from "codesplash-agent"
import { assert, fixture } from "./fixture.ts"

await fixture(async ({ open }) => {
  const session = await open({ respond: async () => ({ choice: "accept" }) })
  const spec: ScheduleSpec = {
    name: "local-inspection",
    prompt: "Inspect once",
    interval: "1m",
    limits: { tokens: 65536, timeoutMs: 30000, rounds: 1 },
    maxOccurrences: 1,
    totalTokens: 65536,
    expiresAfterMs: 3600000,
  }
  const unpack = (raw: unknown) => {
    const r = raw as { text: string; isError?: boolean }
    assert.ok(!r.isError, r.text)
    return JSON.parse(r.text)
  }
  const schedule = unpack(await session.schedules({ action: "create", spec })) as ScheduleRecord
  assert.equal(schedule.enabled, false)
  unpack(await session.schedules({ action: "enable", id: schedule.id, fingerprint: schedule.fingerprint }))
  // An explicit manual occurrence uses the same journal/budgets without waiting for the cadence.
  unpack(await session.schedules({ action: "run", id: schedule.id }))
  const deadline = Date.now() + 30000
  let state: { worker: boolean; occurrences: ScheduleOccurrence[]; schedules: ScheduleRecord[] }
  do {
    state = unpack(await session.schedules({ action: "list" }))
    if (!state.worker) break
    assert.ok(Date.now() < deadline, "Scheduler did not settle")
    await new Promise((r) => setTimeout(r, 50))
  } while (state.worker)
  assert.equal(state.occurrences[0]?.status, "completed", state.occurrences[0]?.output)
  assert.equal(state.schedules[0]?.enabled, false)
  assert.equal(state.schedules[0]?.used, 6)
  unpack(await session.schedules({ action: "delete", id: schedule.id }))
})
