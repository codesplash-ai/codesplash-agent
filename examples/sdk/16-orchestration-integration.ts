import { createHash } from "node:crypto"
import type { AutomationRecord, ScheduleRecord, TeamRecord, WorkflowDefinition } from "codesplash-agent"
import { assert, fixture, join, localProvider } from "./fixture.ts"

await fixture(async ({ root, open }) => {
  const provider = localProvider()
  provider.stream = async function* (request) {
    const writer = /integration-writer-(a|b)/.exec(request.system)?.[1]
    const observed = request.messages.flatMap((m) => m.content).some((b) => b.type === "tool_result")
    if (writer && !observed)
      yield {
        type: "tool_call",
        id: `write-${writer}`,
        name: "write_file",
        input: { path: "shared.txt", content: `writer-${writer}` },
      }
    else yield { type: "text_delta", text: "INTEGRATED_NATIVE_WORK_DONE" }
    yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: "done", stopReason: writer && !observed ? "tool_use" : "end_turn" }
  }
  const session = await open({ providers: [provider], respond: async () => ({ choice: "accept" }) })
  const unpack = (raw: unknown) => {
    const v = raw as { text: string; isError?: boolean }
    assert.ok(!v.isError, v.text)
    return JSON.parse(v.text)
  }
  const team = unpack(
    await session.teams({
      action: "create",
      spec: {
        name: "integration",
        members: ["a", "b"].map((name) => ({
          name,
          agent: "builtin/general",
          role: `integration-writer-${name}`,
          prompt: "Write your bounded result to shared.txt",
        })),
      },
    }),
  ) as TeamRecord
  const tasks: string[] = []
  for (const member of team.members)
    tasks.push(
      (
        unpack(await session.teams({ action: "dispatch", team: team.id, member: member.name })) as {
          task: string
        }
      ).task,
    )
  const pages = (await session.tasks({ action: "wait", ids: tasks, all: true, timeoutMs: 30000 })) as {
    task: { status: string }
    output: { text: string }
  }[]
  assert.ok(
    pages.every((p) => p.task.status === "completed"),
    JSON.stringify(pages),
  )
  assert.match(await Bun.file(join(root, "shared.txt")).text(), /^writer-[ab]$/)
  const workflow: WorkflowDefinition = {
    version: 1,
    name: "integration-copy",
    enabled: true,
    limits: { tokens: 65536, timeoutMs: 30000, rounds: 1 },
    steps: [{ id: "copy", kind: "command", command: "cat shared.txt > reviewed.txt" }],
  }
  const record = unpack(
    await session.workflows({
      action: "start",
      definition: workflow,
      fingerprint: createHash("sha256").update(JSON.stringify(workflow)).digest("hex"),
    }),
  ) as AutomationRecord
  assert.ok(record.task)
  await session.tasks({ action: "wait", ids: [record.task!], all: true, timeoutMs: 30000 })
  assert.equal(
    (unpack(await session.workflows({ action: "list" })) as AutomationRecord[]).find(
      (r) => r.id === record.id,
    )?.status,
    "complete",
  )
  assert.equal(
    await Bun.file(join(root, "reviewed.txt")).text(),
    await Bun.file(join(root, "shared.txt")).text(),
  )
  const schedule = unpack(
    await session.schedules({
      action: "create",
      enabled: true,
      spec: {
        name: "integration-final",
        prompt: "Report completion",
        interval: "1m",
        limits: { tokens: 65536, timeoutMs: 30000, rounds: 1 },
        maxOccurrences: 1,
        totalTokens: 65536,
        expiresAfterMs: 3600000,
      },
    }),
  ) as ScheduleRecord
  unpack(await session.schedules({ action: "run", id: schedule.id }))
  const deadline = Date.now() + 30000
  for (;;) {
    const state = unpack(await session.schedules({ action: "list" })) as {
      worker: boolean
      occurrences: { status: string }[]
    }
    if (!state.worker) {
      assert.equal(state.occurrences[0]?.status, "completed")
      break
    }
    assert.ok(Date.now() < deadline, "Integrated schedule did not settle")
    await new Promise((r) => setTimeout(r, 50))
  }
  unpack(await session.schedules({ action: "delete", id: schedule.id }))
  assert.equal(session.usage.inputTokens, 20)
  assert.equal(session.usage.outputTokens, 10)
})
