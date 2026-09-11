import { assert, fixture } from "./fixture.ts"

await fixture(async ({ open }) => {
  const updates: string[] = []
  let composer = ""
  const session = await open({
    interactive: true,
    onComposer: (text) => {
      composer = text
      return true
    },
    async respond(request) {
      assert.equal(request.requestKind, "elicitation")
      return { choice: "accept", data: { answer: "yes" } }
    },
    onEvent: (event) => {
      if (event.kind === "extension.ui") updates.push(event.payload.text)
    },
    extensions: [
      {
        id: "ui",
        factory(api) {
          api.ui.status("ready", "Ready")
          api.registerCommand({
            name: "show",
            description: "Show an owned dialog",
            async run() {
              api.ui.widget("example", "Example widget")
              api.ui.composer("Suggested prompt")
              return JSON.stringify(
                await api.ui.dialog({
                  message: "Continue?",
                  fields: [
                    {
                      name: "answer",
                      label: "Answer",
                      type: "string",
                      required: true,
                      choices: ["yes", "no"],
                    },
                  ],
                }),
              )
            },
          })
        },
      },
    ],
  })
  const result = await session.extensionsCommand("run ui/show")
  assert.match(JSON.stringify(result), /yes/)
  assert.equal(composer, "Suggested prompt")
  assert.ok(updates.includes("Example widget"))
})
