import { assert, fixture, join } from "./fixture.ts"

await fixture(async ({ root, open }) => {
  const persistence = { root: join(root, "sessions") }
  const first = await open({ persistence })
  await first.prompt("Remember this conversation")
  await first.close()
  const resumed = await open({ persistence: { ...persistence, resume: first.id } })
  assert.match(JSON.stringify(resumed.state.transcript), /Remember this conversation/)
  await resumed.prompt("Continue")
  assert.equal(resumed.usage.inputTokens, 8)
})
