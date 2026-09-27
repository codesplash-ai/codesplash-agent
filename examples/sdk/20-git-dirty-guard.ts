import { writeFile } from "node:fs/promises"
import { extensionToolId } from "codesplash-agent"
import { assert, fixture, join, localProvider } from "./fixture.ts"
import { exampleGit as git } from "./git-example-helpers.ts"

await fixture(async ({ root, open }) => {
  await git(root, ["init", "-q"])
  await writeFile(join(root, "tracked.txt"), "base\n")
  await git(root, ["add", "--", "tracked.txt"])
  await git(root, ["commit", "-qm", "base"])
  await writeFile(join(root, "tracked.txt"), "uncommitted user work\n")
  const provider = localProvider()
  let round = 0,
    guarded = false
  provider.stream = async function* (request) {
    if (round++ === 0) {
      yield { type: "tool_call", id: "guard", name: extensionToolId("guard", "require_clean"), input: {} }
      yield { type: "done", stopReason: "tool_use" }
    } else {
      guarded = JSON.stringify(request.messages).includes("Dirty tracked files")
      yield { type: "done", stopReason: "end_turn" }
    }
  }
  const session = await open({
    providers: [provider],
    respond: async () => ({ choice: "accept" }),
    extensions: [
      {
        id: "guard",
        factory(api) {
          api.registerTool({
            name: "require_clean",
            description: "Refuse a Git workflow when tracked changes or staged work exist",
            readOnly: true,
            effects: "workspace",
            inputSchema: { type: "object", additionalProperties: false },
            targets: () => ({ paths: [api.cwd] }),
            async run(_, context) {
              if (
                (
                  await git(context.cwd, ["status", "--porcelain=v1", "--untracked-files=no"], context.signal)
                ).trim()
              )
                throw new Error("Dirty tracked files: preserve or commit user work before this workflow")
              return { text: "Tracked files are clean", label: "Git dirty guard" }
            },
          })
        },
      },
    ],
  })
  await session.prompt("Check the Git workflow guard")
  assert.ok(guarded)
  assert.equal(await Bun.file(join(root, "tracked.txt")).text(), "uncommitted user work\n")
})
