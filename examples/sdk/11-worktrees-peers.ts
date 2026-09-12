/** A disposable worktree and explicit fork/mailbox flow using a local provider. */
import { mkdir } from "node:fs/promises"
import type { ExtensionProvider } from "codesplash-agent"
import { assert, fixture, join } from "./fixture.ts"

function unpack<T>(value: unknown): T {
  const result = value as { isError?: boolean; text: string }
  assert.ok(!result.isError, result.text)
  return JSON.parse(result.text) as T
}
type Page = { task: { id: string; status: string }; output: { text: string } }
await fixture(async ({ root, open }) => {
  const cwd = join(root, "repo")
  await mkdir(cwd)
  async function git(args: string[]) {
    const child = Bun.spawn(["git", ...args], {
      cwd,
      env: {
        PATH: process.env.PATH,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@local.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@local.invalid",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    assert.equal(await child.exited, 0, await new Response(child.stderr).text())
  }
  await git(["init", "-q"])
  await Bun.write(join(cwd, "input.txt"), "input\n")
  await git(["add", "input.txt"])
  await git(["commit", "-qm", "base"])
  const provider: ExtensionProvider = {
    name: "local",
    displayName: "Local",
    protocol: "openai",
    models: [
      {
        id: "model",
        displayName: "Local",
        contextWindow: 131072,
        maxOutputTokens: 1024,
        isDefault: true,
        supportsReasoning: false,
      },
    ],
    async *stream(request) {
      yield { type: "text_delta", text: JSON.stringify(request.messages) }
      yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
      yield { type: "done", stopReason: "end_turn" }
    },
  }
  const session = await open({ cwd, providers: [provider], respond: async () => ({ choice: "accept" }) })
  await session.prompt("EXPLICIT_FORK_SEED")
  const tree = unpack<{ id: string }>(await session.worktrees({ action: "create" }))
  const child = unpack<Page>(
    await session.spawnAgent({
      agent: "explore",
      prompt: "Inspect independently",
      context: "fork",
      worktree: tree.id,
      yieldMs: 30000,
    }),
  )
  assert.equal(child.task.status, "completed")
  assert.ok(child.output.text.includes("EXPLICIT_FORK_SEED"))
  await session.peers({ action: "send", target: child.task.id, text: "QUEUED_PEER_DATA" })
  const followup = unpack<{ text: string }>(
    await session.peers({
      action: "followup",
      target: child.task.id,
      prompt: "Read pending peer data",
      yieldMs: 30000,
    }),
  )
  assert.ok((JSON.parse(followup.text) as Page).output.text.includes("QUEUED_PEER_DATA"))
  const graph = (await session.peers({ action: "graph" })) as unknown[]
  assert.equal(graph.length, 1)
  unpack(await session.worktrees({ action: "remove", id: tree.id }))
})
