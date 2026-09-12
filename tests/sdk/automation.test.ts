import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AutomationRecord, WorkflowDefinition } from "../../src/core/orchestration/automation.ts"
import { workflowFingerprint } from "../../src/core/orchestration/automation.ts"
import { git } from "../../src/core/orchestration/git.ts"
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

const limits = { tokens: 1000000, timeoutMs: 60000, rounds: 3 }
async function settled(session: Awaited<ReturnType<typeof fixture>>["session"], record: AutomationRecord) {
  const deadline = Date.now() + 80000
  while (Date.now() < deadline) {
    const pages = (await session.tasks({
      action: "wait",
      ids: [record.task!],
      all: true,
      timeoutMs: 1000,
    })) as Array<{ task: { status: string } }>
    if (!["running", "queued"].includes(pages[0]!.task.status)) break
  }
  return record.kind === "goal"
    ? result<AutomationRecord>(await session.goals({ action: "get" }))
    : result<AutomationRecord[]>(await session.workflows({ action: "list" })).find((r) => r.id === record.id)!
}
const usage = { inputTokens: 4, cachedInputTokens: 1, outputTokens: 2 }
test("explicit goal runs worker, evidence verifier and strategist with cumulative native accounting", async () => {
  let workers = 0,
    strategies = 0
  const f = await fixture(async function* (request) {
    const verifier = request.system.includes("You are a verifier"),
      strategist = request.system.includes("You are a strategist")
    const last = request.messages.at(-1)?.content.find((b) => b.type === "tool_result")
    if (verifier && !last)
      yield { type: "tool_call", id: "evidence", name: "read_file", input: { path: "file.txt" } }
    else if (verifier)
      yield {
        type: "text_delta",
        text: JSON.stringify({ complete: workers >= 2, evidence: "Observed file.txt" }),
      }
    else if (strategist) {
      strategies++
      yield { type: "text_delta", text: "Make another bounded inspection" }
    } else {
      workers++
      yield { type: "text_delta", text: "Worker finished" }
    }
    yield { type: "usage", usage }
    yield { type: "done", stopReason: verifier && !last ? "tool_use" : "end_turn" }
  })
  try {
    result(await f.session.goals({ action: "create", objective: "Inspect the file twice", limits }))
    const r = await settled(f.session, result(await f.session.goals({ action: "start" })))
    expect(r.status, r.reason).toBe("complete")
    expect(r.round).toBe(2)
    expect(workers).toBe(2)
    expect(strategies).toBe(1)
    expect(r.used).toBe(49)
    expect(r.reserved).toBe(0)
    expect(r.uncertain).toBe(false)
    expect(r.steps.filter((s) => s.id.endsWith("verifier")).every((s) => s.evidence?.length === 1)).toBe(true)
    const tasks = (await f.session.tasks({ action: "list" })) as Array<{
      id: string
      parent?: string
      kind: string
    }>
    expect(tasks.filter((t) => t.parent === r.task && t.kind === "agent")).toHaveLength(5)
  } finally {
    await f.close()
  }
}, 90000)
test("model-only completion is rejected and unknown provider usage pauses conservatively", async () => {
  let unknown = false
  const f = await fixture(async function* (request) {
    yield {
      type: "text_delta",
      text: request.system.includes("You are a verifier")
        ? '{"complete":true,"evidence":"trust me"}'
        : "claimed complete",
    }
    if (!unknown) yield { type: "usage", usage }
    yield { type: "done", stopReason: "end_turn" }
  })
  try {
    result(await f.session.goals({ action: "create", objective: "Require actual evidence", limits }))
    let r = await settled(f.session, result(await f.session.goals({ action: "start" })))
    expect(r.status).toBe("paused")
    expect(r.reason).toContain("observed read-only tool evidence")
    unknown = true
    r = await settled(f.session, result(await f.session.goals({ action: "resume" })))
    expect(r.status).toBe("paused")
    expect(r.uncertain).toBe(true)
    expect(r.used).toBeGreaterThan(100)
    const denied = (await f.session.goals({ action: "resume" })) as { isError: boolean; text: string }
    expect(denied.isError).toBe(true)
    expect(denied.text).toContain("usage review")
  } finally {
    await f.close()
  }
}, 90000)
test("workflow executes guarded command and parallel child steps, verifies, and skips successful work on resume", async () => {
  let prompts = 0
  const f = await fixture(async function* (request) {
    const verifier = request.system.includes("You are a verifier"),
      last = request.messages.at(-1)?.content.find((b) => b.type === "tool_result")
    if (verifier && !last)
      yield { type: "tool_call", id: "read", name: "read_file", input: { path: "generated.txt" } }
    else if (verifier)
      yield { type: "text_delta", text: '{"complete":true,"evidence":"generated.txt exists"}' }
    else {
      prompts++
      yield { type: "text_delta", text: "parallel report" }
    }
    yield { type: "usage", usage }
    yield { type: "done", stopReason: verifier && !last ? "tool_use" : "end_turn" }
  })
  const definition: WorkflowDefinition = {
    version: 1,
    name: "native",
    enabled: true,
    limits,
    steps: [
      { id: "first", kind: "prompt", prompt: "Inspect once" },
      { id: "second", kind: "prompt", prompt: "Inspect concurrently" },
      { id: "join", kind: "parallel", needs: ["first", "second"] },
      { id: "write", kind: "command", needs: ["join"], command: "printf created > generated.txt" },
      { id: "verify", kind: "verification", needs: ["write"], prompt: "Read generated.txt" },
      { id: "fail", kind: "command", needs: ["verify"], command: "exit 9" },
    ],
  }
  try {
    let r = await settled(
      f.session,
      result(
        await f.session.workflows({
          action: "start",
          definition,
          fingerprint: workflowFingerprint(definition),
        }),
      ),
    )
    expect(r.status, r.reason).toBe("paused")
    expect(r.steps.find((s) => s.id === "verify")?.status).toBe("completed")
    expect(await Bun.file(join(f.repo, "generated.txt")).text()).toBe("created")
    expect(prompts).toBe(2)
    expect(
      ((await f.session.workflows({ action: "resume", id: r.id })) as { isError: boolean }).isError,
    ).toBe(true)
    result(await f.session.workflows({ action: "review", id: r.id, step: "fail", outcome: "completed" }))
    r = await settled(f.session, result(await f.session.workflows({ action: "resume", id: r.id })))
    expect(r.status, r.reason).toBe("complete")
    expect(prompts).toBe(2)
  } finally {
    await f.close()
  }
}, 90000)
test("explicit budgets pause instead of success and pause/close cancels owned provider work", async () => {
  let entered!: () => void
  const gate = new Promise<void>((r) => {
    entered = r
  })
  const f = await fixture(async function* (_request, { signal }) {
    entered()
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true })
      if (signal.aborted) resolve()
    })
    yield { type: "done", stopReason: "end_turn" }
  })
  try {
    result(
      await f.session.goals({
        action: "create",
        objective: "Wait within explicit limits",
        limits: { ...limits, tokens: 1000 },
      }),
    )
    let r = await settled(f.session, result(await f.session.goals({ action: "start" })))
    expect(r.status).toBe("paused")
    expect(r.used).toBe(0)
    const started = result<AutomationRecord>(await f.session.goals({ action: "resume", limits }))
    await gate
    result(await f.session.goals({ action: "pause" }))
    r = await settled(f.session, started)
    expect(r.status).toBe("paused")
    expect(r.uncertain).toBe(true)
    expect(
      ((await f.session.tasks({ action: "list" })) as Array<{ status: string }>).some((t) =>
        ["queued", "running"].includes(t.status),
      ),
    ).toBe(false)
  } finally {
    await f.close()
  }
}, 90000)
test("durable workflow restart retains successful steps and rejects replay until explicit review", async () => {
  const f = await fixture(
    async function* () {
      yield { type: "text_delta", text: "unused" }
      yield { type: "usage", usage }
      yield { type: "done", stopReason: "end_turn" }
    },
    [],
    true,
  )
  const definition: WorkflowDefinition = {
    version: 1,
    name: "durable",
    enabled: true,
    limits,
    steps: [
      { id: "write", kind: "command", command: "printf x >> count.txt" },
      { id: "fail", kind: "command", needs: ["write"], command: "exit 2" },
    ],
  }
  try {
    const original = await settled(
      f.session,
      result(
        await f.session.workflows({
          action: "start",
          definition,
          fingerprint: workflowFingerprint(definition),
        }),
      ),
    )
    expect(original.status).toBe("paused")
    await f.session.close()
    const resumed = await f.reopen()
    const records = result<AutomationRecord[]>(await resumed.workflows({ action: "list" }))
    expect(records[0]?.steps[0]?.status).toBe("completed")
    expect(
      ((await resumed.workflows({ action: "resume", id: original.id })) as { isError: boolean }).isError,
    ).toBe(true)
    result(await resumed.workflows({ action: "review", id: original.id, step: "fail", outcome: "completed" }))
    const final = await settled(
      resumed,
      result(await resumed.workflows({ action: "resume", id: original.id })),
    )
    expect(final.status, final.reason).toBe("complete")
    expect(await Bun.file(join(f.repo, "count.txt")).text()).toBe("x")
  } finally {
    await f.close()
  }
}, 90000)
test("foreground input wins before goal continuation and nested child usage belongs to the goal", async () => {
  let enterWorker!: () => void,
    releaseWorker!: () => void,
    enterForeground!: () => void,
    releaseForeground!: () => void,
    verifiers = 0
  const workerEntered = new Promise<void>((r) => {
      enterWorker = r
    }),
    workerGate = new Promise<void>((r) => {
      releaseWorker = r
    }),
    foregroundEntered = new Promise<void>((r) => {
      enterForeground = r
    }),
    foregroundGate = new Promise<void>((r) => {
      releaseForeground = r
    })
  const f = await fixture(async function* (request) {
    const child = request.system.includes("[Child role"),
      verifier = request.system.includes("You are a verifier"),
      last = request.messages.at(-1)?.content.find((b) => b.type === "tool_result"),
      nested = JSON.stringify(request.messages).includes("NESTED_INSPECT")
    if (!child) {
      enterForeground()
      await foregroundGate
      yield { type: "text_delta", text: "Foreground done" }
    } else if (verifier && !last) {
      verifiers++
      yield { type: "tool_call", id: "read", name: "read_file", input: { path: "file.txt" } }
    } else if (verifier)
      yield { type: "text_delta", text: '{"complete":true,"evidence":"file.txt observed"}' }
    else if (!nested && !last) {
      enterWorker()
      await workerGate
      yield {
        type: "tool_call",
        id: "nested",
        name: "agent",
        input: { agent: "builtin/explore", prompt: "NESTED_INSPECT", yieldMs: 30000 },
      }
    } else yield { type: "text_delta", text: "Worker done" }
    yield { type: "usage", usage }
    yield {
      type: "done",
      stopReason: child && ((verifier && !last) || (!verifier && !nested && !last)) ? "tool_use" : "end_turn",
    }
  })
  try {
    result(await f.session.goals({ action: "create", objective: "Inspect with a nested child", limits }))
    const started = result<AutomationRecord>(await f.session.goals({ action: "start" }))
    await workerEntered
    const foreground = f.session.prompt("Foreground work")
    await foregroundEntered
    releaseWorker()
    await new Promise((r) => setTimeout(r, 500))
    expect(verifiers).toBe(0)
    releaseForeground()
    await foreground
    const final = await settled(f.session, started)
    expect(final.status, final.reason).toBe("complete")
    expect(final.used).toBe(35)
    expect(
      (f.session.usage.inputTokens ?? 0) +
        (f.session.usage.cachedInputTokens ?? 0) +
        (f.session.usage.outputTokens ?? 0),
    ).toBe(42)
  } finally {
    releaseWorker()
    releaseForeground()
    await f.close()
  }
}, 90000)
test("ordinary allow rules cannot turn unrequested model goals into executable work", async () => {
  let reviews = 0
  const f = await fixture(
    async function* () {
      yield {
        type: "tool_call",
        id: "goal",
        name: "goal",
        input: { action: "create", objective: "Unrequested goal", limits },
      }
      yield { type: "usage", usage }
      yield { type: "done", stopReason: "end_turn" }
    },
    ['permissions.allow=["goal"]'],
    false,
    async () => {
      reviews++
      return { choice: "decline" }
    },
  )
  try {
    const value = (await f.session.goals({ action: "create", objective: "Unapproved goal", limits })) as {
      isError: boolean
    }
    expect(value.isError).toBe(true)
    expect(reviews).toBe(1)
    expect(result(await f.session.goals({ action: "get" }))).toBeNull()
  } finally {
    await f.close()
  }
}, 90000)
