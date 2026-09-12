import type { AutomationRecord } from "codesplash-agent"
import { assert, fixture, join, localProvider } from "./fixture.ts"

await fixture(async ({ root, open }) => {
  await Bun.write(join(root, "evidence.txt"), "Observed local evidence")
  const provider = localProvider()
  provider.stream = async function* (request) {
    const verifier = request.system.includes("You are a verifier")
    const last = request.messages.at(-1)?.content.find((block) => block.type === "tool_result")
    if (verifier && !last)
      yield { type: "tool_call", id: "read", name: "read_file", input: { path: "evidence.txt" } }
    else
      yield {
        type: "text_delta",
        text: verifier
          ? '{"complete":true,"evidence":"evidence.txt was read"}'
          : "Worker inspected the objective",
      }
    yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: "done", stopReason: verifier && !last ? "tool_use" : "end_turn" }
  }
  const session = await open({ providers: [provider], respond: async () => ({ choice: "accept" }) })
  const unpack = (raw: unknown): AutomationRecord => {
    const r = raw as { text: string; isError?: boolean }
    assert.ok(!r.isError, r.text)
    return JSON.parse(r.text)
  }
  unpack(
    await session.goals({
      action: "create",
      objective: "Inspect evidence.txt",
      limits: { tokens: 200000, timeoutMs: 30000, rounds: 2 },
    }),
  )
  const started = unpack(await session.goals({ action: "start" }))
  await session.tasks({ action: "wait", ids: [started.task!], all: true, timeoutMs: 30000 })
  const goal = unpack(await session.goals({ action: "get" }))
  assert.equal(goal.status, "complete", goal.reason)
  assert.equal(goal.used, 18)
  assert.equal(goal.steps.at(-1)?.evidence?.length, 1)
})
