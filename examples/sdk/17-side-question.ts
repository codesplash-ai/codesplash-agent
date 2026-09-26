import { assert, fixture, localProvider } from "./fixture.ts"

await fixture(async ({ open }) => {
  const provider = localProvider()
  provider.stream = async function* (request) {
    const side = request.system.includes("separate question")
    if (side) {
      assert.deepEqual(request.tools, [])
      assert.equal(request.model.maxOutputTokens, 512)
    }
    yield { type: "text_delta", text: side ? "Side answer" : "Main answer" }
    yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: "done", stopReason: "end_turn" }
  }
  const session = await open({ providers: [provider] })
  await session.prompt("Main question")
  const transcript = JSON.stringify(session.state.transcript)
  assert.equal(await session.sideQuery({ kind: "question", question: "Explain one detail" }), "Side answer")
  assert.equal(JSON.stringify(session.state.transcript), transcript)
  assert.equal(session.usage.inputTokens, 8)
})
