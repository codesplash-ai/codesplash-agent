import { assert, fixture } from "./fixture.ts"

await fixture(async ({ open }) => {
  const session = await open()
  session.subscribe((event) => {
    if (event.kind === "message.delta") process.stdout.write(event.payload.text)
  })
  assert.equal((await session.prompt("Hello from an ephemeral session")).status, "completed")
  assert.equal(session.historyDirectory, undefined)
})
