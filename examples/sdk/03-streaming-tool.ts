import { readFile, writeFile } from "node:fs/promises"
import { extensionToolId } from "codesplash-agent/extensions"
import { assert, fixture, join, localProvider } from "./fixture.ts"

await fixture(async ({ root, open }) => {
  const provider = localProvider()
  let stage = 0,
    approvals = 0,
    progress = 0
  provider.stream = async function* () {
    if (stage++ === 0) {
      yield {
        type: "tool_call",
        id: "write",
        name: extensionToolId("sdk", "write"),
        input: { text: "approved output" },
      }
      yield { type: "done", stopReason: "tool_use" }
    } else {
      yield { type: "text_delta", text: "Written" }
      yield { type: "done", stopReason: "end_turn" }
    }
  }
  const session = await open({
    providers: [provider],
    tools: [
      {
        name: "write",
        description: "Write a single reviewed fixture file",
        effects: "workspace",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string", maxLength: 100 } },
          required: ["text"],
          additionalProperties: false,
        },
        targets: () => ({ paths: [join(root, "result.txt")] }),
        async run(input, context) {
          context.progress("Writing fixture")
          await writeFile(join(root, "result.txt"), (input as { text: string }).text)
          return { text: "written", label: "Fixture write", mutatedPaths: [join(root, "result.txt")] }
        },
      },
    ],
    async respond(request) {
      assert.equal(request.requestKind, "approval")
      approvals++
      return { choice: "accept" }
    },
    onEvent(event) {
      if (event.kind === "item.updated" && event.payload.output === "Writing fixture") progress++
    },
  })
  assert.equal((await session.prompt("Write the fixture")).status, "completed")
  assert.equal(await readFile(join(root, "result.txt"), "utf8"), "approved output")
  assert.equal(approvals, 1)
  assert.ok(progress)
})
