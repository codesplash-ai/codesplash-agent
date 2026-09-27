import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { extensionToolId } from "codesplash-agent"
import { assert, fixture, join, localProvider } from "./fixture.ts"
import { exampleGit as git } from "./git-example-helpers.ts"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
// Opt-in and exact staged-diff approval. Never stages files, pushes, or commits changed approval content.
await fixture(async ({ root, open }) => {
  await git(root, ["init", "-q"])
  await writeFile(join(root, "tracked.txt"), "base\n")
  await git(root, ["add", "--", "tracked.txt"])
  await git(root, ["commit", "-qm", "base"])
  await writeFile(join(root, "tracked.txt"), "approved update\n")
  await git(root, ["add", "--", "tracked.txt"])
  const provider = localProvider()
  let round = 0,
    committed = false,
    approvals = 0
  provider.stream = async function* () {
    if (round++ === 0) {
      yield { type: "tool_call", id: "arm", name: extensionToolId("exitcommit", "arm"), input: {} }
      yield { type: "done", stopReason: "tool_use" }
    } else yield { type: "done", stopReason: "end_turn" }
  }
  const session = await open({
    providers: [provider],
    respond: async () => {
      approvals++
      return { choice: "accept" }
    },
    extensions: [
      {
        id: "exitcommit",
        flags: { enabled: true },
        factory(api) {
          const enabled = api.registerFlag("enabled", { type: "boolean", default: false }) === true
          let approved: { head: string; patch: string; tree: string; branch: string } | undefined
          api.registerTool({
            name: "arm",
            description: "Approve committing the current exact staged diff on graceful session exit",
            effects: "workspace",
            inputSchema: { type: "object", additionalProperties: false },
            targets: () => ({ paths: [api.cwd] }),
            async run(_, context) {
              if (!enabled) throw new Error("Auto-commit is not explicitly enabled")
              const patch = await git(
                api.cwd,
                ["diff", "--cached", "--binary", "--no-ext-diff"],
                context.signal,
              )
              if (!patch.trim()) throw new Error("No staged diff to approve")
              approved = {
                head: (await git(api.cwd, ["rev-parse", "HEAD"], context.signal)).trim(),
                patch: hash(patch),
                tree: (await git(api.cwd, ["write-tree"], context.signal)).trim(),
                branch: (await git(api.cwd, ["symbolic-ref", "HEAD"], context.signal)).trim(),
              }
              return {
                text: "Approved exact staged diff for graceful exit; later edits invalidate it",
                label: "Arm exit commit",
              }
            },
          })
          api.on("session.end", async (_, signal) => {
            if (!enabled || !approved) return
            const approval = approved
            approved = undefined
            if (
              approval.head !== (await git(api.cwd, ["rev-parse", "HEAD"], signal)).trim() ||
              approval.patch !==
                hash(await git(api.cwd, ["diff", "--cached", "--binary", "--no-ext-diff"], signal))
            )
              throw new Error("Staged content changed after approval; auto-commit refused")
            const commit = (
              await git(
                api.cwd,
                ["commit-tree", approval.tree, "-p", approval.head, "-m", "Approved SDK session update"],
                signal,
              )
            ).trim()
            await git(api.cwd, ["update-ref", approval.branch, commit, approval.head], signal)
            committed = true
          })
        },
      },
    ],
  })
  await session.prompt("Approve the staged fixture update for commit on exit")
  await session.close()
  assert.equal(approvals, 1)
  assert.ok(committed)
  assert.match(await git(root, ["log", "-1", "--format=%s"]), /Approved SDK/)
})
