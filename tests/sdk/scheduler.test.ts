import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { git } from "../../src/core/orchestration/git.ts"
import type {
  ScheduleOccurrence,
  ScheduleRecord,
  ScheduleSpec,
} from "../../src/core/orchestration/scheduler.ts"
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

const spec: ScheduleSpec = {
  name: "native",
  prompt: "Inspect the workspace",
  interval: "1m",
  limits: { tokens: 65536, timeoutMs: 30000, rounds: 1 },
  maxOccurrences: 2,
  totalTokens: 131072,
  expiresAfterMs: 86400000,
}
type Status = { worker: boolean; schedules: ScheduleRecord[]; occurrences: ScheduleOccurrence[] }
async function finished(session: Awaited<ReturnType<typeof fixture>>["session"]) {
  const end = Date.now() + 45000
  while (Date.now() < end) {
    const state = result<Status>(await session.schedules({ action: "list" }))
    if (!state.worker) return state
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error("Scheduler did not settle")
}
test("SDK schedules execute actual bounded native children and retain occurrence accounting", async () => {
  let calls = 0
  const stream: ExtensionProvider["stream"] = async function* () {
    calls++
    yield { type: "text_delta", text: "Native occurrence completed" }
    yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: "done", stopReason: "end_turn" }
  }
  const f = await fixture(stream)
  try {
    const created = result<ScheduleRecord>(await f.session.schedules({ action: "create", spec }))
    expect(created.enabled).toBe(false)
    expect(
      ((await f.session.schedules({ action: "run", id: created.id })) as { isError?: boolean }).isError,
    ).toBe(true)
    let state = await finished(f.session)
    expect(calls).toBe(0)
    expect(state.schedules[0]!.enabled).toBe(false)
    result(await f.session.schedules({ action: "enable", id: created.id, fingerprint: created.fingerprint }))
    result(await f.session.schedules({ action: "run", id: created.id }))
    state = await finished(f.session)
    expect(calls).toBe(1)
    expect(state.occurrences[0]!.status, state.occurrences[0]!.output).toBe("completed")
    expect(state.schedules[0]!.used).toBe(6)
    expect(state.schedules[0]!.reserved).toBe(0)
    expect(state.occurrences[0]!.session).toBe(f.session.id)
    expect(state.occurrences[0]!.task).toBeDefined()
    result(await f.session.schedules({ action: "run", id: created.id }))
    state = await finished(f.session)
    expect(calls).toBe(2)
    expect(state.schedules[0]!.enabled).toBe(false)
    expect(state.schedules[0]!.used).toBe(12)
    result(await f.session.schedules({ action: "delete", id: created.id }))
    expect(result<Status>(await f.session.schedules({ action: "list" })).schedules).toEqual([])
  } finally {
    await f.close()
  }
}, 60000)
test("SDK scheduler stop drains active native work and preserves unknown usage for review", async () => {
  let entered!: () => void
  const ready = new Promise<void>((r) => {
    entered = r
  })
  const f = await fixture(async function* (_request, { signal }) {
    entered()
    await new Promise<void>((r) => {
      signal.addEventListener("abort", () => r(), { once: true })
      if (signal.aborted) r()
    })
    yield { type: "done", stopReason: "end_turn" }
  })
  try {
    const created = result<ScheduleRecord>(
      await f.session.schedules({ action: "create", spec, enabled: true }),
    )
    result(await f.session.schedules({ action: "run", id: created.id }))
    await ready
    result(await f.session.schedules({ action: "stop" }))
    const state = await finished(f.session)
    expect(state.occurrences[0]!.status).toBe("execution-uncertain")
    expect(state.schedules[0]!.used).toBe(65536)
    expect(state.schedules[0]!.enabled).toBe(false)
    expect(
      (
        (await f.session.schedules({
          action: "enable",
          id: created.id,
          fingerprint: created.fingerprint,
        })) as { isError: boolean }
      ).isError,
    ).toBe(true)
    result(await f.session.schedules({ action: "review", occurrence: state.occurrences[0]!.id }))
    result(await f.session.schedules({ action: "delete", id: created.id }))
  } finally {
    await f.close()
  }
}, 60000)
test("current scheduler deny rules and watch read floors are enforced before persistent creation", async () => {
  // biome-ignore lint/correctness/useYield: every invocation is a test failure
  const stream: ExtensionProvider["stream"] = async function* () {
    throw new Error("Must not call provider")
  }
  const f = await fixture(stream, ['permissions.deny=["scheduler_create"]'])
  try {
    expect(((await f.session.schedules({ action: "create", spec })) as { isError: boolean }).isError).toBe(
      true,
    )
    expect(result<Status>(await f.session.schedules({ action: "list" })).schedules).toEqual([])
  } finally {
    await f.close()
  }
  const second = await fixture(stream, ['permissions.deny=["read_file"]'])
  try {
    expect(
      (
        (await second.session.schedules({ action: "create", spec: { ...spec, watch: "." } })) as {
          isError: boolean
        }
      ).isError,
    ).toBe(true)
  } finally {
    await second.close()
  }
}, 60000)
test("closing a scheduler owner during native execution preserves the occurrence and releases its lease", async () => {
  let entered!: () => void
  const ready = new Promise<void>((r) => {
    entered = r
  })
  const f = await fixture(async function* (_request, { signal }) {
    entered()
    await new Promise<void>((r) => {
      signal.addEventListener("abort", () => r(), { once: true })
      if (signal.aborted) r()
    })
    yield { type: "done", stopReason: "end_turn" }
  })
  try {
    const created = result<ScheduleRecord>(
      await f.session.schedules({ action: "create", spec, enabled: true }),
    )
    result(await f.session.schedules({ action: "run", id: created.id }))
    await ready
    await f.session.close()
    const { ScheduleStore } = await import("../../src/core/orchestration/scheduler.ts")
    const store = new ScheduleStore(f.repo, join(f.root, "data"))
    expect(store.read().occurrences[0]?.status, JSON.stringify(store.read())).toBe("execution-uncertain")
    store.acquireWorker()
    store.releaseWorker()
  } finally {
    await f.close()
  }
}, 60000)
