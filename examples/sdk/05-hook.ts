import { writeFile } from "node:fs/promises"
import { reviewIntegration, trustIntegration } from "codesplash-agent"
import { assert, fixture, localProvider } from "./fixture.ts"

await fixture(async ({ options, open }) => {
  let calls = 0,
    sawRewrite = false
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const event = await request.json()
      assert.equal(event.name, "input.admit")
      calls++
      return Response.json({ version: 1, text: "Reviewed hook input" })
    },
  })
  try {
    await writeFile(
      options.config!.path!,
      `[hooks.handlers.fixture]\nkind="http"\nurl="${server.url.href}"\nenabled=true\nallowLoopback=true\nevents=["input.admit"]\nshare=["text"]\nallowTextRewrite=true\n`,
    )
    const review = await reviewIntegration(options, "hook", "fixture")
    await trustIntegration(options, "hook", "fixture", review.fingerprint)
    const provider = localProvider()
    provider.stream = async function* (request) {
      sawRewrite = JSON.stringify(request.messages).includes("Reviewed hook input")
      yield { type: "text_delta", text: "Hook complete" }
      yield { type: "done", stopReason: "end_turn" }
    }
    const session = await open({ providers: [provider] })
    await session.prompt("Original input")
    assert.equal(calls, 1)
    assert.ok(sawRewrite)
    await session.close()
  } finally {
    await server.stop(true)
  }
})
