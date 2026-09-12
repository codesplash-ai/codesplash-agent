import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { git } from "../../src/core/orchestration/git.ts"
import { createAgentSession, type ExtensionProvider } from "../../src/sdk/index.ts"

async function fixture(stream: ExtensionProvider["stream"], overrides: string[] = []) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cs-orchestration-sdk-"))),
    repo = join(root, "repo")
  await mkdir(repo)
  await git(repo, ["init", "-q"])
  await Bun.write(join(repo, "file.txt"), "base")
  await git(repo, ["add", "file.txt"])
  await git(repo, ["commit", "-qm", "base"])
  const session = await createAgentSession({
    cwd: repo,
    workspaceTrusted: true,
    trustDataDirectory: join(root, "data"),
    config: { path: join(root, "config.toml"), overrides: ["memory.enabled=false", ...overrides] },
    respond: async () => ({ choice: "accept" }),
    model: "ext_sdk_local/model",
    providers: [
      {
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
        stream,
      },
    ],
  })
  return {
    root,
    repo,
    session,
    close: async () => {
      await session.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}
function result<T>(value: unknown): T {
  const v = value as { text: string; isError?: boolean }
  expect(v.isError, v.text).toBeFalsy()
  return JSON.parse(v.text) as T
}
type Page = { task: { id: string; status: string }; output: { text: string } }
test("SDK forks actual context into isolated worktree children and applies reviewed changes", async () => {
  const f = await fixture(async function* (request) {
    const child = request.system.includes("[Child role"),
      last = request.messages.at(-1)?.content.find((b) => b.type === "tool_result")
    if (!child) yield { type: "text_delta", text: "PARENT_ONLY_CONTEXT" }
    else if (!last)
      yield {
        type: "tool_call",
        id: "write",
        name: "write_file",
        input: { path: "file.txt", content: "child edit" },
      }
    else
      yield {
        type: "text_delta",
        text: `FORK_CONTEXT:${JSON.stringify(request.messages).includes("PARENT_ONLY_CONTEXT")};WRITE:${!last.isError}`,
      }
    yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: "done", stopReason: child && !last ? "tool_use" : "end_turn" }
  })
  try {
    await f.session.prompt("Seed parent context")
    const tree = result<{ id: string; cwd: string }>(await f.session.worktrees({ action: "create" }))
    const page = result<Page>(
      await f.session.spawnAgent({
        agent: "general",
        prompt: "Edit isolated file",
        context: "fork",
        worktree: tree.id,
        directive: "Stay in the worktree",
        yieldMs: 30000,
      }),
    )
    expect(page.task.status, page.output.text).toBe("completed")
    expect(page.output.text).toContain("FORK_CONTEXT:true;WRITE:true")
    expect(await Bun.file(join(f.repo, "file.txt")).text()).toBe("base")
    expect(await Bun.file(join(tree.cwd, "file.txt")).text()).toBe("child edit")
    const preview = result<{ fingerprint: string }>(
      await f.session.worktrees({ action: "preview", id: tree.id }),
    )
    result(await f.session.worktrees({ action: "apply", id: tree.id, fingerprint: preview.fingerprint }))
    expect(await Bun.file(join(f.repo, "file.txt")).text()).toBe("child edit")
  } finally {
    await f.close()
  }
}, 90000)
test("peer messages reach live provider boundaries and idle peers require explicit followup", async () => {
  let enter!: () => void,
    release!: () => void,
    calls = 0
  const entered = new Promise<void>((r) => {
      enter = r
    }),
    gate = new Promise<void>((r) => {
      release = r
    })
  const f = await fixture(async function* (request) {
    calls++
    if (calls === 1) {
      enter()
      await gate
      yield { type: "tool_call", id: "read", name: "read_file", input: { path: "file.txt" } }
    } else yield { type: "text_delta", text: JSON.stringify(request.messages) }
    yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: "done", stopReason: calls === 1 ? "tool_use" : "end_turn" }
  })
  try {
    const first = result<Page>(
      await f.session.spawnAgent({ agent: "explore", prompt: "Wait for data", background: true }),
    )
    await entered
    await f.session.peers({ action: "send", target: first.task.id, text: "LIVE_PEER_DATA" })
    release()
    const pages = (await f.session.tasks({
      action: "wait",
      ids: [first.task.id],
      all: true,
      timeoutMs: 30000,
    })) as Page[]
    expect(pages[0]?.task.status).toBe("completed")
    const page = (await f.session.tasks({ action: "output", id: first.task.id })) as Page
    expect(page.output.text).toContain("LIVE_PEER_DATA")
    const before = calls
    await f.session.peers({ action: "send", target: first.task.id, text: "IDLE_PEER_DATA" })
    await Bun.sleep(30)
    expect(calls).toBe(before)
    const wrapped = result<{ text: string }>(
      await f.session.peers({
        action: "followup",
        target: first.task.id,
        prompt: "Continue with mailbox",
        yieldMs: 30000,
      }),
    )
    const second = JSON.parse(wrapped.text) as Page
    expect(second.task.status, second.output.text).toBe("completed")
    expect(second.output.text).toContain("IDLE_PEER_DATA")
  } finally {
    release()
    await f.close()
  }
}, 90000)

test("standalone SDK sessions hold managed worktree ownership until close", async () => {
  const stream: ExtensionProvider["stream"] = async function* () {
    yield { type: "text_delta", text: "READY" }
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: "done", stopReason: "end_turn" }
  }
  const f = await fixture(stream)
  let standalone: Awaited<ReturnType<typeof createAgentSession>> | undefined
  try {
    const tree = result<{ id: string; cwd: string }>(await f.session.worktrees({ action: "create" }))
    standalone = await createAgentSession({
      cwd: tree.cwd,
      workspaceTrusted: true,
      trustDataDirectory: join(f.root, "data"),
      config: { path: join(f.root, "config.toml"), overrides: ["memory.enabled=false"] },
      model: "ext_sdk_local/model",
      providers: [
        {
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
          stream,
        },
      ],
    })
    await standalone.prompt("Use isolated workspace")
    const blocked = (await f.session.worktrees({ action: "remove", id: tree.id })) as {
      isError?: boolean
      text: string
    }
    expect(blocked.isError).toBe(true)
    expect(blocked.text).toContain("active")
    await standalone.close()
    standalone = undefined
    result(await f.session.worktrees({ action: "remove", id: tree.id }))
  } finally {
    await standalone?.close()
    await f.close()
  }
}, 90000)

test("worktree children cannot use accepted grants to write into their parent's directory", async () => {
  const f = await fixture(async function* (request) {
    const result = request.messages.flatMap((m) => m.content).find((b) => b.type === "tool_result")
    if (!result)
      yield {
        type: "tool_call",
        id: "escape",
        name: "write_file",
        input: { path: "../../escaped.txt", content: "bad" },
      }
    else yield { type: "text_delta", text: `ESCAPE_DENIED:${result.isError}` }
    yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: "done", stopReason: result ? "end_turn" : "tool_use" }
  })
  try {
    const tree = result<{ id: string }>(await f.session.worktrees({ action: "create" }))
    const child = result<Page>(
      await f.session.spawnAgent({
        agent: "general",
        prompt: "Attempt out of scope write",
        worktree: tree.id,
        yieldMs: 30000,
      }),
    )
    expect(child.task.status, child.output.text).toBe("completed")
    expect(child.output.text).toContain("ESCAPE_DENIED:true")
    expect(await Bun.file(join(f.repo, "escaped.txt")).exists()).toBe(false)
  } finally {
    await f.close()
  }
}, 90000)

test("worktree host snapshots and apply preserve explicit ask floors and fresh policy", async () => {
  const stream: ExtensionProvider["stream"] = async function* () {
    yield { type: "done", stopReason: "end_turn" }
  }
  const reader = await fixture(stream, ['permissions.ask=["read_file(file.txt)"]'])
  try {
    const tree = result<{ id: string; cwd: string; excluded: string[] }>(
      await reader.session.worktrees({ action: "create" }),
    )
    expect(tree.excluded).toContain("file.txt")
    expect(await Bun.file(join(tree.cwd, "file.txt")).exists()).toBe(false)
  } finally {
    await reader.close()
  }
  const writer = await fixture(stream, ['permissions.ask=["write_file(file.txt)"]'])
  try {
    const tree = result<{ id: string; cwd: string }>(await writer.session.worktrees({ action: "create" }))
    await Bun.write(join(tree.cwd, "file.txt"), "unapproved write")
    const preview = result<{ fingerprint: string }>(
      await writer.session.worktrees({ action: "preview", id: tree.id }),
    )
    const blocked = (await writer.session.worktrees({
      action: "apply",
      id: tree.id,
      fingerprint: preview.fingerprint,
    })) as { isError?: boolean }
    expect(blocked.isError).toBe(true)
    expect(await Bun.file(join(writer.repo, "file.txt")).text()).toBe("base")
  } finally {
    await writer.close()
  }
  const changed = await fixture(stream)
  try {
    await Bun.write(join(changed.root, "config.toml"), '[permissions]\ndeny=["worktree"]\n')
    const blocked = (await changed.session.worktrees({ action: "create" })) as { isError?: boolean }
    expect(blocked.isError).toBe(true)
  } finally {
    await changed.close()
  }
}, 90000)
