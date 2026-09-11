import { assert, fixture, localProvider } from "./fixture.ts"

await fixture(async ({ open }) => {
  const secret = "example-provider-private-credential",
    events: string[] = []
  const provider = localProvider()
  let authenticated = false
  provider.auth = async (signal) => {
    signal.throwIfAborted()
    return secret
  }
  provider.stream = async function* (_request, { credential, signal }) {
    signal.throwIfAborted()
    authenticated = credential === secret
    yield { type: "text_delta", text: `Received ${credential}` }
    yield { type: "usage", usage: { inputTokens: 7, outputTokens: 3 } }
    yield { type: "done", stopReason: "end_turn" }
  }
  const session = await open({
    providers: [provider],
    onEvent: (event) => events.push(JSON.stringify(event)),
  })
  await session.prompt("Exercise the custom provider")
  assert.ok(authenticated)
  assert.ok(!events.join("\n").includes(secret))
  assert.equal(session.usage.inputTokens, 7)
  assert.equal(session.usage.hasUnpricedUsage, true)
})
