import type { TeamDashboard, TeamRecord } from "codesplash-agent"
import { assert, fixture } from "./fixture.ts"

await fixture(async ({ open }) => {
  const session = await open({ respond: async () => ({ choice: "accept" }) })
  const unpack = (raw: unknown) => {
    const result = raw as { text: string; isError?: boolean }
    assert.ok(!result.isError, result.text)
    return JSON.parse(result.text)
  }
  const team = unpack(
    await session.teams({
      action: "create",
      spec: {
        name: "review",
        members: [
          { name: "reader", agent: "builtin/explore", role: "reviewer", prompt: "Inspect the example" },
        ],
      },
    }),
  ) as TeamRecord
  const first = unpack(await session.teams({ action: "dispatch", team: team.id, member: "reader" })) as {
    task: string
  }
  await session.tasks({ action: "wait", ids: [first.task], all: true, timeoutMs: 30000 })
  let view = unpack(await session.teams({ action: "list" })) as TeamDashboard
  const id = view.teams[0]?.members[0]?.peer?.id
  assert.equal(view.teams[0]?.members[0]?.task?.status, "completed")
  const peek = unpack(await session.teams({ action: "peek", team: team.id, member: "reader" })) as {
    output: string
  }
  assert.match(peek.output, /Local example completed/)
  unpack(
    await session.teams({
      action: "reply",
      team: team.id,
      member: "reader",
      text: "This is queued data; it does not start a turn.",
    }),
  )
  const second = unpack(
    await session.teams({
      action: "dispatch",
      team: team.id,
      member: "reader",
      prompt: "Read the queued message",
    }),
  ) as { task: string }
  await session.tasks({ action: "wait", ids: [second.task], all: true, timeoutMs: 30000 })
  view = unpack(await session.teams({ action: "list" })) as TeamDashboard
  assert.equal(view.teams[0]?.members[0]?.peer?.id, id)
  assert.equal(view.teams[0]?.members[0]?.peer?.usage?.inputTokens, 8)
  assert.equal(view.teams[0]?.members[0]?.task?.status, "completed")
  unpack(await session.teams({ action: "coordinator", team: team.id }))
  assert.equal((unpack(await session.teams({ action: "list" })) as TeamDashboard).coordinator, team.id)
  unpack(await session.teams({ action: "coordinator" }))
  unpack(await session.teams({ action: "delete", team: team.id }))
})
