import { writeFile } from "node:fs/promises"
import { extensionToolId } from "codesplash-agent"
import { assert, fixture, join, localProvider } from "./fixture.ts"
import { exampleGit as git } from "./git-example-helpers.ts"

await fixture(async ({ root, open }) => {
  await git(root, ["init", "-q"])
  await writeFile(join(root, "conflict.txt"), "base\n")
  await git(root, ["add", "--", "conflict.txt"])
  await git(root, ["commit", "-qm", "base"])
  await git(root, ["checkout", "-qb", "incoming"])
  await writeFile(join(root, "conflict.txt"), "incoming\n")
  await git(root, ["commit", "-qam", "incoming"])
  await git(root, ["checkout", "-qb", "current", "HEAD~1"])
  await writeFile(join(root, "conflict.txt"), "current\n")
  await git(root, ["commit", "-qam", "current"])
  const provider = localProvider()
  let round = 0,
    conflict = false,
    approvals = 0
  provider.stream = async function* (request) {
    if (round++ === 0) {
      yield { type: "tool_call", id: "merge", name: extensionToolId("merge", "attempt"), input: {} }
      yield { type: "done", stopReason: "tool_use" }
    } else {
      conflict = JSON.stringify(request.messages).includes("unresolved paths")
      yield { type: "done", stopReason: "end_turn" }
    }
  }
  const session = await open({
    providers: [provider],
    respond: async () => {
      approvals++
      return { choice: "accept" }
    },
    extensions: [
      {
        id: "merge",
        factory(api) {
          api.registerTool({
            name: "attempt",
            description:
              "Try the reviewed incoming branch merge and report unresolved paths; never pick a conflict side automatically",
            effects: "workspace",
            inputSchema: { type: "object", additionalProperties: false },
            targets: () => ({ paths: [api.cwd] }),
            async run(_, context) {
              if (
                (await git(api.cwd, ["status", "--porcelain", "--untracked-files=no"], context.signal)).trim()
              )
                throw new Error("Dirty repository; merge refused")
              try {
                await git(api.cwd, ["merge", "--no-commit", "--no-ff", "incoming"], context.signal)
              } catch (error) {
                const paths = await git(api.cwd, ["diff", "--name-only", "--diff-filter=U"], context.signal)
                if (!paths.trim()) throw error
                return {
                  text: `Merge has unresolved paths:\n${paths}Review and edit them, then explicitly approve staging and completing or aborting the merge.`,
                  label: "Merge conflicts",
                }
              }
              return { text: "Merge staged; review before committing", label: "Merge preview" }
            },
          })
        },
      },
    ],
  })
  await session.prompt("Try merging the reviewed fixture branch")
  assert.ok(conflict)
  assert.equal(approvals, 1)
  // Human-reviewed resolution in this isolated fixture; an application must request a fresh approval.
  await writeFile(join(root, "conflict.txt"), "reviewed combined resolution\n")
  await git(root, ["add", "--", "conflict.txt"])
  await git(root, ["commit", "-qm", "Resolve reviewed merge"])
  assert.equal((await git(root, ["diff", "--name-only", "--diff-filter=U"])).trim(), "")
})
