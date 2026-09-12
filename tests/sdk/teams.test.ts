import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { git } from "../../src/core/orchestration/git.ts"
import type { TeamDashboard, TeamRecord } from "../../src/core/orchestration/teams.ts"
import {
  type CreateAgentSessionOptions,
  createAgentSession,
  type ExtensionProvider,
} from "../../src/sdk/index.ts"

async function fixture(
  stream: ExtensionProvider["stream"],
  overrides: string[] = [],
  recorded = false,
  respond: CreateAgentSessionOptions["respond"] = async () => ({ choice: "accept" }),
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cs-orchestration-sdk-"))),
    repo = join(root, "repo")
  await mkdir(repo)
  await git(repo, ["init", "-q"])
  await Bun.write(join(repo, "file.txt"), "base")
  await git(repo, ["add", "file.txt"])
  await git(repo, ["commit", "-qm", "base"])
  const options: CreateAgentSessionOptions = {
    ...(recorded ? { persistence: { root: join(root, "sessions") } } : {}),
    cwd: repo,
    workspaceTrusted: true,
    trustDataDirectory: join(root, "data"),
    config: { path: join(root, "config.toml"), overrides: ["memory.enabled=false", ...overrides] },
    respond,
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
  }
  const session = await createAgentSession(options)
  const sessions = [session]
  return {
    reopen: async () => {
      const next = await createAgentSession({
        ...options,
        persistence: { root: join(root, "sessions"), resume: session.id },
      })
      sessions.push(next)
      return next
    },
    root,
    repo,
    session,
    close: async () => {
      await Promise.all(sessions.map((s) => s.close()))
      await rm(root, { recursive: true, force: true })
    },
  }
}
function result<T>(value: unknown): T {
  const v = value as { text: string; isError?: boolean }
  expect(v.isError, v.text).toBeFalsy()
  return JSON.parse(v.text) as T
}

const spec = {
  name: "review",
  members: [{ name: "worker", agent: "builtin/general", role: "reviewer", prompt: "Inspect evidence" }],
}
const done = async (session: Awaited<ReturnType<typeof fixture>>["session"], task: string) => {
  const [page] = (await session.tasks({ action: "wait", ids: [task], all: true, timeoutMs: 30000 })) as {
    task: { status: string }
    output: { text: string }
  }[]
  expect(page?.task.status, page?.output.text).toBe("completed")
}
test("native teams dispatch, peek, reply without admission and resume durable named identities", async () => {
  let calls = 0
  const f = await fixture(
    async function* (request) {
      calls++
      yield {
        type: "text_delta",
        text: JSON.stringify(request.messages).includes("TEAM_REPLY")
          ? "TEAM_REPLY observed"
          : "TEAM_WORK_DONE",
      }
      yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
      yield { type: "done", stopReason: "end_turn" }
    },
    [],
    true,
  )
  try {
    const team = result<TeamRecord>(await f.session.teams({ action: "create", spec }))
    const first = result<{ task: string }>(
      await f.session.teams({ action: "dispatch", team: team.id, member: "worker" }),
    )
    await done(f.session, first.task)
    const view = result<TeamDashboard>(await f.session.teams({ action: "list" })),
      identity = view.teams[0]!.members[0]!.peer!.id
    expect(view.teams[0]?.members[0]?.peer?.usage).toMatchObject({ inputTokens: 4, outputTokens: 2 })
    expect(
      result<{ output: string }>(await f.session.teams({ action: "peek", team: team.id, member: "worker" }))
        .output,
    ).toContain("TEAM_WORK_DONE")
    result(await f.session.teams({ action: "reply", team: team.id, member: "worker", text: "TEAM_REPLY" }))
    await Bun.sleep(50)
    expect(calls).toBe(1)
    const next = result<{ task: string }>(
      await f.session.teams({
        action: "dispatch",
        team: team.id,
        member: "worker",
        prompt: "Read queued data",
      }),
    )
    await done(f.session, next.task)
    expect(
      result<{ output: string }>(await f.session.teams({ action: "peek", team: team.id, member: "worker" }))
        .output,
    ).toContain("TEAM_REPLY")
    result(await f.session.teams({ action: "coordinator", team: team.id }))
    await f.session.close()
    const reopened = await f.reopen(),
      restored = result<TeamDashboard>(await reopened.teams({ action: "list" }))
    expect(restored.coordinator).toBe(team.id)
    expect(restored.teams[0]?.members[0]?.peer).toMatchObject({
      id: identity,
      usage: { inputTokens: 8, outputTokens: 4 },
    })
    expect(restored.panes.windows).toHaveLength(0)
    expect(calls).toBe(2)
    result(await reopened.teams({ action: "coordinator" }))
  } finally {
    await f.close()
  }
}, 60000)
test("root coordinator catalog restricts forged direct tools while actual native delegation remains available", async () => {
  let stage = 0,
    teamId = "",
    task = "",
    restricted = false
  const f = await fixture(async function* (request) {
    const root = request.system.includes("You are a coordinator for team")
    if (root) {
      restricted =
        !request.tools.some((t) => t.name === "write_file" || t.name === "bash") &&
        request.tools.some((t) => t.name === "teams")
      const last = request.messages
        .flatMap((m) => m.content)
        .filter((b) => b.type === "tool_result")
        .at(-1)
      if (stage === 0)
        yield {
          type: "tool_call",
          id: "forged",
          name: "write_file",
          input: { path: "forged.txt", content: "bad" },
        }
      else if (stage === 1) {
        expect(last?.type === "tool_result" && last.isError).toBe(true)
        yield {
          type: "tool_call",
          id: "dispatch",
          name: "teams",
          input: { action: "dispatch", team: teamId, member: "worker" },
        }
      } else if (stage === 2) {
        if (last?.type === "tool_result") task = JSON.parse(last.text).task
        yield {
          type: "tool_call",
          id: "wait",
          name: "task_wait",
          input: { ids: [task], all: true, timeoutMs: 30000 },
        }
      } else yield { type: "text_delta", text: "COORDINATED" }
      stage++
    } else yield { type: "text_delta", text: "DELEGATED_WORK" }
    yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: "done", stopReason: root && stage <= 3 ? "tool_use" : "end_turn" }
  })
  try {
    teamId = result<TeamRecord>(await f.session.teams({ action: "create", spec })).id
    result(await f.session.teams({ action: "coordinator", team: teamId }))
    expect((await f.session.prompt("Coordinate the review")).status).toBe("completed")
    expect(restricted).toBe(true)
    expect(await Bun.file(join(f.repo, "forged.txt")).exists()).toBe(false)
    expect(result<TeamDashboard>(await f.session.teams({ action: "list" })).teams[0]?.edges).toHaveLength(1)
    await done(f.session, task)
  } finally {
    await f.close()
  }
}, 60000)
test("allowed team control cannot bypass native child denial", async () => {
  let calls = 0
  const f = await fixture(
    async function* () {
      calls++
      yield { type: "done", stopReason: "end_turn" }
    },
    ['permissions.deny=["agent"]'],
  )
  try {
    const team = result<TeamRecord>(await f.session.teams({ action: "create", spec }))
    expect(
      (
        (await f.session.teams({ action: "dispatch", team: team.id, member: "worker" })) as {
          isError: boolean
        }
      ).isError,
    ).toBe(true)
    expect(calls).toBe(0)
    expect(result<TeamDashboard>(await f.session.teams({ action: "list" })).teams[0]?.edges).toHaveLength(0)
  } finally {
    await f.close()
  }
}, 30000)
test("coordinator children delegate with inherited team edges and inclusive usage without double counting root", async () => {
  const f = await fixture(async function* (request) {
    const coordinator = request.system.includes("[Child role builtin/coordinator]"),
      results = request.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result")
    if (coordinator && results.length === 0)
      yield {
        type: "tool_call",
        id: "nested",
        name: "agent",
        input: { agent: "builtin/general", prompt: "Nested bounded work", background: true },
      }
    else if (coordinator && results.length === 1)
      yield {
        type: "tool_call",
        id: "nested-wait",
        name: "task_wait",
        input: { ids: [JSON.parse(results[0]!.text).task.id], all: true, timeoutMs: 30000 },
      }
    else yield { type: "text_delta", text: coordinator ? "COORDINATOR_FINISHED" : "NESTED_FINISHED" }
    yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: "done", stopReason: coordinator && results.length < 2 ? "tool_use" : "end_turn" }
  })
  try {
    const team = result<TeamRecord>(
      await f.session.teams({
        action: "create",
        spec: {
          name: "nested",
          members: [
            { name: "lead", agent: "builtin/coordinator", role: "coordinator", prompt: "Delegate and wait" },
          ],
        },
      }),
    )
    const dispatch = result<{ task: string }>(
      await f.session.teams({ action: "dispatch", team: team.id, member: "lead" }),
    )
    await done(f.session, dispatch.task)
    const view = result<TeamDashboard>(await f.session.teams({ action: "list" })),
      edges = view.teams[0]!.edges
    expect(edges).toHaveLength(2)
    const lead = edges.find((e) => e.member === "lead")!,
      child = edges.find((e) => e.member !== "lead")!
    expect(child.parent).toBe(lead.id)
    expect(child.team).toBe(team.id)
    expect(lead.usage).toMatchObject({ inputTokens: 16, outputTokens: 8 })
    expect(child.usage).toMatchObject({ inputTokens: 4, outputTokens: 2 })
    expect(view.usage).toMatchObject({ inputTokens: 16, outputTokens: 8 })
  } finally {
    await f.close()
  }
}, 60000)
test("native peer calls cannot cross team boundaries and close drains blocked children plus panes", async () => {
  let target = "",
    phase = 0,
    entered!: () => void
  const ready = new Promise<void>((r) => {
    entered = r
  })
  const f = await fixture(async function* (request, { signal }) {
    if (request.system.includes("ATTACKER")) {
      const tools = ["send_message", "interrupt_agent", "wait_agent"]
      if (phase < tools.length) {
        const name = tools[phase++]!
        yield {
          type: "tool_call",
          id: `attempt-${phase}`,
          name,
          input: name === "send_message" ? { target, text: "cross team" } : { target },
        }
      } else {
        const results = request.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result")
        expect(results.every((r) => r.isError)).toBe(true)
        yield { type: "text_delta", text: "ALL_CROSS_TEAM_CALLS_DENIED" }
      }
      yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
      yield {
        type: "done",
        stopReason:
          phase <= 3 &&
          request.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result").length < 3
            ? "tool_use"
            : "end_turn",
      }
    } else {
      entered()
      await new Promise<void>((r) => {
        signal.addEventListener("abort", () => r(), { once: true })
        if (signal.aborted) r()
      })
      yield { type: "done", stopReason: "end_turn" }
    }
  })
  try {
    const other = result<TeamRecord>(await f.session.teams({ action: "create", spec }))
    const first = result<{ task: string }>(
      await f.session.teams({ action: "dispatch", team: other.id, member: "worker" }),
    )
    await ready
    target = first.task
    const attack = result<TeamRecord>(
      await f.session.teams({
        action: "create",
        spec: { name: "attack", members: [{ ...spec.members[0]!, role: "ATTACKER" }] },
      }),
    )
    const second = result<{ task: string }>(
      await f.session.teams({ action: "dispatch", team: attack.id, member: "worker" }),
    )
    await done(f.session, second.task)
    expect(
      result<{ output: string }>(await f.session.teams({ action: "peek", team: attack.id, member: "worker" }))
        .output,
    ).toContain("ALL_CROSS_TEAM_CALLS_DENIED")
    expect(
      result<TeamDashboard>(await f.session.teams({ action: "list" })).teams[0]?.members[0]?.task?.status,
    ).toBe("running")
    if (Bun.which("tmux")) result(await f.session.teams({ action: "panes", team: other.id }))
    await f.session.close()
  } finally {
    await f.close()
  }
}, 60000)
