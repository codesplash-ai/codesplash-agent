import { assert, fixture } from "./fixture.ts"

await fixture(async ({ open }) => {
  const session = await open({ respond: async () => ({ choice: "accept" }) })
  const started = (await session.spawnAgent({
    agent: "explore",
    prompt: "Report a short finding",
    background: true,
  })) as { isError?: boolean; text: string }
  assert.ok(!started.isError, started.text)
  const id = JSON.parse(started.text).task.id as string
  const [result] = (await session.tasks({
    action: "wait",
    ids: [id],
    all: true,
    timeoutMs: 10000,
  })) as Array<{ task: { status: string }; output: { text: string } }>
  assert.equal(result?.task.status, "completed")
  assert.match(result?.output.text ?? "", /Local example completed/)
  assert.equal(session.usage.inputTokens, 4)
  const resumed = (await session.spawnAgent({
    agent: "explore",
    resume: id,
    prompt: "Continue this child",
    yieldMs: 10000,
  })) as { isError?: boolean; text: string }
  assert.ok(!resumed.isError, resumed.text)
  assert.equal(JSON.parse(resumed.text).task.status, "completed")
})
