import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "../../src/core/events.ts"
import type { AutomationRecord, WorkflowDefinition } from "../../src/core/orchestration/automation.ts"
import { git } from "../../src/core/orchestration/git.ts"
import type { ScheduleRecord } from "../../src/core/orchestration/scheduler.ts"
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

test("actual task settlement notifies the local event feed and only model-visible tasks reach provider boundaries", async () => {
  const requests: string[] = [],
    events: AgentEvent[] = []
  const f = await fixture(async function* (request) {
    requests.push(JSON.stringify(request.messages))
    yield { type: "text_delta", text: "OBSERVED" }
    yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: "done", stopReason: "end_turn" }
  })
  const unsubscribe = f.session.subscribe((e) => events.push(e))
  try {
    const hidden = result<{ task: { id: string } }>(
        await f.session.runCommand("printf EXCLUDED_TASK_RESULT", false),
      ),
      visible = result<{ task: { id: string } }>(
        await f.session.runCommand("printf VISIBLE_TASK_RESULT", true),
      )
    await f.session.tasks({
      action: "wait",
      ids: [hidden.task.id, visible.task.id],
      all: true,
      timeoutMs: 30000,
    })
    const child = result<{ task: { id: string } }>(
      await f.session.spawnAgent({
        agent: "builtin/explore",
        prompt: "Bounded observed child",
        background: true,
      }),
    )
    await f.session.tasks({ action: "wait", ids: [child.task.id], all: true, timeoutMs: 30000 })
    expect((await f.session.prompt("Inspect completion statuses")).status).toBe("completed")
    const final = requests.at(-1)!
    expect(final).toContain("Owned task status")
    expect(final).toContain(visible.task.id)
    expect(final).toContain(child.task.id)
    expect(final).not.toContain(hidden.task.id)
    expect(final).not.toContain("EXCLUDED_TASK_RESULT")
    const notices = events.filter(
      (e) =>
        e.kind === "item.updated" &&
        [hidden.task.id, visible.task.id, child.task.id].includes(e.payload.id) &&
        e.payload.status === "completed",
    )
    expect(notices).toHaveLength(3)
    expect(
      notices.find((e) => e.kind === "item.updated" && e.payload.id === hidden.task.id)?.payload,
    ).toMatchObject({ output: "EXCLUDED_TASK_RESULT" })
  } finally {
    unsubscribe()
    await f.close()
  }
}, 60000)
test("parallel team writes, checkpoint ownership, workflow command and scheduled child share one native session", async () => {
  const events: AgentEvent[] = []
  const f = await fixture(
    async function* (request) {
      const writer = /integration-writer-(a|b)/.exec(request.system)?.[1],
        observed = request.messages.flatMap((m) => m.content).some((b) => b.type === "tool_result")
      if (writer && !observed)
        yield {
          type: "tool_call",
          id: `write-${writer}`,
          name: "write_file",
          input: { path: "file.txt", content: `writer-${writer}` },
        }
      else yield { type: "text_delta", text: "INTEGRATED_NATIVE_WORK_DONE" }
      yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
      yield { type: "done", stopReason: writer && !observed ? "tool_use" : "end_turn" }
    },
    [],
    true,
  )
  const unsubscribe = f.session.subscribe((e) => events.push(e))
  try {
    const team = result<TeamRecord>(
      await f.session.teams({
        action: "create",
        spec: {
          name: "integration",
          members: ["a", "b"].map((name) => ({
            name,
            agent: "builtin/general",
            role: `integration-writer-${name}`,
            prompt: "Write the result to file.txt",
          })),
        },
      }),
    )
    const ids: string[] = []
    for (const member of team.members)
      ids.push(
        result<{ task: string }>(
          await f.session.teams({ action: "dispatch", team: team.id, member: member.name }),
        ).task,
      )
    const pages = (await f.session.tasks({ action: "wait", ids, all: true, timeoutMs: 30000 })) as {
      task: { status: string }
      output: { text: string }
    }[]
    expect(
      pages.every((p) => p.task.status === "completed"),
      JSON.stringify(pages),
    ).toBe(true)
    expect(await Bun.file(join(f.repo, "file.txt")).text()).toMatch(/^writer-[ab]$/)
    const definition: WorkflowDefinition = {
      version: 1,
      name: "copy",
      enabled: true,
      limits: { tokens: 65536, timeoutMs: 30000, rounds: 1 },
      steps: [{ id: "copy", kind: "command", command: "cat file.txt > reviewed.txt" }],
    }
    const workflow = result<AutomationRecord>(
      await f.session.workflows({
        action: "start",
        definition,
        fingerprint: createHash("sha256").update(JSON.stringify(definition)).digest("hex"),
      }),
    )
    await f.session.tasks({ action: "wait", ids: [workflow.task!], all: true, timeoutMs: 30000 })
    expect(
      result<AutomationRecord[]>(await f.session.workflows({ action: "list" })).find(
        (w) => w.id === workflow.id,
      )?.status,
    ).toBe("complete")
    expect(await Bun.file(join(f.repo, "reviewed.txt")).text()).toBe(
      await Bun.file(join(f.repo, "file.txt")).text(),
    )
    const schedule = result<ScheduleRecord>(
      await f.session.schedules({
        action: "create",
        enabled: true,
        spec: {
          name: "final",
          prompt: "Confirm completion",
          interval: "1m",
          limits: { tokens: 65536, timeoutMs: 30000, rounds: 1 },
          maxOccurrences: 1,
          totalTokens: 65536,
          expiresAfterMs: 3600000,
        },
      }),
    )
    result(await f.session.schedules({ action: "run", id: schedule.id }))
    const deadline = Date.now() + 30000
    for (;;) {
      const state = result<{ worker: boolean; occurrences: { status: string }[] }>(
        await f.session.schedules({ action: "list" }),
      )
      if (!state.worker) {
        expect(state.occurrences[0]?.status).toBe("completed")
        break
      }
      if (Date.now() >= deadline) throw new Error("Integrated scheduler did not settle")
      await Bun.sleep(50)
    }
    expect(result<TeamDashboard>(await f.session.teams({ action: "list" })).usage).toMatchObject({
      inputTokens: 20,
      outputTokens: 10,
    })
    expect(
      events.filter(
        (e) => e.kind === "item.updated" && ids.includes(e.payload.id) && e.payload.status === "completed",
      ),
    ).toHaveLength(2)
    result(await f.session.schedules({ action: "delete", id: schedule.id }))
  } finally {
    unsubscribe()
    await f.close()
  }
}, 60000)
