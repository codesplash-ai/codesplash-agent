import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_STATS_DAYS,
  formatStatsTable,
  parseStatsArguments,
  runStatsCommand,
  type StatsRow,
} from "../../src/commands/stats.ts"
import { UsageError } from "../../src/commands/usage-error.ts"
import type { EngineId, SessionMeta } from "../../src/core/index.ts"
import { SessionStore } from "../../src/core/index.ts"

const NOW = new Date("2026-03-01T12:00:00.000Z")

class Sink {
  text = ""

  write(chunk: string): boolean {
    this.text += chunk
    return true
  }
}

const cleanups: string[] = []

afterAll(async () => {
  for (const path of cleanups) await rm(path, { recursive: true, force: true })
})

async function makeStore(): Promise<SessionStore> {
  const root = join(await mkdtemp(join(tmpdir(), "codesplash-stats-")), "sessions")
  cleanups.push(root)
  return new SessionStore(root)
}

type SessionSpec = {
  engine: EngineId
  projectId: string
  localSessionId: string
  updatedAt: string
  /** Serialized as raw event-log lines (strings pass through unparsed for corruption tests). */
  events?: Array<Record<string, unknown> | string>
}

async function writeSession(store: SessionStore, spec: SessionSpec): Promise<void> {
  const meta: SessionMeta = {
    schemaVersion: 1,
    engine: spec.engine,
    localSessionId: spec.localSessionId,
    projectPath: `/projects/${spec.projectId}`,
    projectId: spec.projectId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: spec.updatedAt,
    lastStatus: "closed",
    lastSequence: (spec.events?.length ?? 0) - 1,
  }
  const handle = await store.create(meta)
  const lines = (spec.events ?? []).map((event) =>
    typeof event === "string" ? event : JSON.stringify(event),
  )
  await handle.appendEventLines(lines)
}

function makeEvent(
  spec: Pick<SessionSpec, "engine" | "localSessionId">,
  sequence: number,
  kind: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sequence,
    timestamp: "2026-02-20T00:00:00.000Z",
    engine: spec.engine,
    localSessionId: spec.localSessionId,
    kind,
    payload,
  }
}

/** A codesplash session with a model status and two cumulative usage events (the last wins). */
function codesplashSession(
  projectId: string,
  localSessionId: string,
  updatedAt: string,
  model: string,
  usage: { inputTokens: number; outputTokens: number; estimatedCostUsd?: number },
): SessionSpec {
  const spec = { engine: "codesplash" as const, localSessionId }
  return {
    engine: "codesplash",
    projectId,
    localSessionId,
    updatedAt,
    events: [
      makeEvent(spec, 0, "session.status", { status: "ready", model }),
      makeEvent(spec, 1, "usage.updated", { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.001 }),
      makeEvent(spec, 2, "usage.updated", usage),
    ],
  }
}

describe("parseStatsArguments", () => {
  test("defaults to a 30-day human table", () => {
    expect(parseStatsArguments([])).toEqual({ days: DEFAULT_STATS_DAYS, json: false })
  })

  test("accepts --days and --json in both flag styles", () => {
    expect(parseStatsArguments(["--days", "7", "--json"])).toEqual({ days: 7, json: true })
    expect(parseStatsArguments(["--days=90"])).toEqual({ days: 90, json: false })
  })

  test("rejects non-positive, fractional, and missing --days values", () => {
    for (const bad of [["--days", "0"], ["--days", "-3"], ["--days", "2.5"], ["--days", "x"], ["--days"]]) {
      expect(() => parseStatsArguments(bad)).toThrow(UsageError)
    }
  })

  test("rejects unknown flags and stray positionals", () => {
    expect(() => parseStatsArguments(["--verbose"])).toThrow(UsageError)
    expect(() => parseStatsArguments(["yesterday"])).toThrow(UsageError)
  })
})

describe("runStatsCommand", () => {
  test("aggregates the last cumulative usage per session across projects, per engine+model", async () => {
    const store = await makeStore()
    await writeSession(
      store,
      codesplashSession("project-a", "s1", "2026-02-25T00:00:00.000Z", "claude-fable-5:high", {
        inputTokens: 1200,
        outputTokens: 340,
        estimatedCostUsd: 0.5,
      }),
    )
    await writeSession(
      store,
      codesplashSession("project-b", "s2", "2026-02-20T00:00:00.000Z", "claude-fable-5", {
        inputTokens: 800,
        outputTokens: 60,
        estimatedCostUsd: 0.25,
      }),
    )
    // A codex session with usage but no model in any session.status groups under "unknown".
    await writeSession(store, {
      engine: "codex",
      projectId: "project-a",
      localSessionId: "s3",
      updatedAt: "2026-02-27T00:00:00.000Z",
      events: [
        makeEvent({ engine: "codex", localSessionId: "s3" }, 0, "usage.updated", {
          inputTokens: 50,
          outputTokens: 5,
        }),
      ],
    })

    const stdout = new Sink()
    const exitCode = await runStatsCommand(["--json"], { store, stdout, now: () => NOW })

    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout.text)).toEqual([
      {
        engine: "codesplash",
        model: "claude-fable-5",
        sessions: 2,
        inputTokens: 2000,
        outputTokens: 400,
        estimatedCostUsd: 0.75,
      },
      {
        engine: "codex",
        model: "unknown",
        sessions: 1,
        inputTokens: 50,
        outputTokens: 5,
        estimatedCostUsd: 0,
      },
    ])
  })

  test("codex sessions sum per-request token counts instead of taking the final request's", async () => {
    const store = await makeStore()
    const spec = { engine: "codex" as const, localSessionId: "c1" }
    await writeSession(store, {
      engine: "codex",
      projectId: "project-a",
      localSessionId: "c1",
      updatedAt: "2026-02-25T00:00:00.000Z",
      events: [
        // The codex normalizer fills inputTokens/outputTokens from tokenUsage.last (one request)
        // and puts the cumulative sum in totalTokens; only the per-request values are split.
        makeEvent(spec, 0, "usage.updated", {
          inputTokens: 1000,
          outputTokens: 100,
          contextTokens: 1100,
          totalTokens: 1100,
        }),
        makeEvent(spec, 1, "usage.updated", {
          inputTokens: 2000,
          outputTokens: 50,
          contextTokens: 2050,
          totalTokens: 3150,
        }),
      ],
    })

    const stdout = new Sink()
    expect(await runStatsCommand(["--json"], { store, stdout, now: () => NOW })).toBe(0)
    const [row] = JSON.parse(stdout.text)
    expect(row.inputTokens).toBe(3000)
    expect(row.outputTokens).toBe(150)
  })

  test("a trailing rate-limit-only usage event never zeroes the session's tokens or cost", async () => {
    const store = await makeStore()
    const spec = { engine: "codex" as const, localSessionId: "c2" }
    await writeSession(store, {
      engine: "codex",
      projectId: "project-a",
      localSessionId: "c2",
      updatedAt: "2026-02-25T00:00:00.000Z",
      events: [
        makeEvent(spec, 0, "usage.updated", {
          inputTokens: 500,
          outputTokens: 40,
          totalTokens: 540,
        }),
        // Codex emits usage.updated events that carry ONLY a rateLimit payload; they routinely
        // arrive after the token update and must not reset the running totals.
        makeEvent(spec, 1, "usage.updated", { rateLimit: { usedPercent: 12.5, label: "weekly" } }),
      ],
    })
    const splash = { engine: "codesplash" as const, localSessionId: "s9" }
    await writeSession(store, {
      engine: "codesplash",
      projectId: "project-a",
      localSessionId: "s9",
      updatedAt: "2026-02-25T00:00:00.000Z",
      events: [
        makeEvent(splash, 0, "usage.updated", {
          inputTokens: 700,
          outputTokens: 30,
          estimatedCostUsd: 0.2,
        }),
        makeEvent(splash, 1, "usage.updated", { rateLimit: { usedPercent: 50 } }),
      ],
    })

    const stdout = new Sink()
    expect(await runStatsCommand(["--json"], { store, stdout, now: () => NOW })).toBe(0)
    const rows = JSON.parse(stdout.text) as Array<Record<string, unknown>>
    const codex = rows.find((row) => row.engine === "codex")
    const codesplash = rows.find((row) => row.engine === "codesplash")
    expect(codex).toMatchObject({ inputTokens: 500, outputTokens: 40 })
    expect(codesplash).toMatchObject({ inputTokens: 700, outputTokens: 30, estimatedCostUsd: 0.2 })
  })

  test("the --days window excludes older sessions by meta.updatedAt", async () => {
    const store = await makeStore()
    await writeSession(
      store,
      codesplashSession("project-a", "recent", "2026-02-25T00:00:00.000Z", "claude-fable-5", {
        inputTokens: 10,
        outputTokens: 1,
      }),
    )
    await writeSession(
      store,
      codesplashSession("project-a", "old", "2026-01-01T00:00:00.000Z", "claude-fable-5", {
        inputTokens: 999_999,
        outputTokens: 999_999,
      }),
    )

    const within30 = new Sink()
    expect(await runStatsCommand(["--json"], { store, stdout: within30, now: () => NOW })).toBe(0)
    expect(JSON.parse(within30.text)).toHaveLength(1)
    expect(JSON.parse(within30.text)[0].sessions).toBe(1)
    expect(JSON.parse(within30.text)[0].inputTokens).toBe(10)

    const within90 = new Sink()
    expect(
      await runStatsCommand(["--days", "90", "--json"], { store, stdout: within90, now: () => NOW }),
    ).toBe(0)
    expect(JSON.parse(within90.text)[0].sessions).toBe(2)
  })

  test("corrupt metas, corrupt event lines, and foreign files are skipped, never fatal", async () => {
    const store = await makeStore()
    await writeSession(store, {
      engine: "codesplash",
      projectId: "project-a",
      localSessionId: "good",
      updatedAt: "2026-02-25T00:00:00.000Z",
      events: [
        "{ not json",
        makeEvent({ engine: "codesplash", localSessionId: "good" }, 0, "session.status", {
          status: "ready",
          model: "gpt-5.1",
        }),
        makeEvent({ engine: "codesplash", localSessionId: "good" }, 1, "usage.updated", {
          inputTokens: 7,
          outputTokens: 3,
          estimatedCostUsd: 0.01,
        }),
      ],
    })
    // A session directory with an unparsable meta.json is skipped entirely.
    const corruptDirectory = join(store.root, "project-a", "corrupt")
    await mkdir(corruptDirectory, { recursive: true })
    await writeFile(join(corruptDirectory, "meta.json"), "{{{{")
    // A stray file at the projects level is ignored by the directory scan.
    await writeFile(join(store.root, "junk.txt"), "not a project")

    const stdout = new Sink()
    const exitCode = await runStatsCommand(["--json"], { store, stdout, now: () => NOW })

    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout.text)).toEqual([
      {
        engine: "codesplash",
        model: "gpt-5.1",
        sessions: 1,
        inputTokens: 7,
        outputTokens: 3,
        estimatedCostUsd: 0.01,
      },
    ])
  })

  test("an empty store prints a friendly line instead of an empty table", async () => {
    const store = await makeStore()
    const stdout = new Sink()
    expect(await runStatsCommand([], { store, stdout, now: () => NOW })).toBe(0)
    expect(stdout.text).toBe("No sessions in the last 30 days.\n")

    const json = new Sink()
    expect(await runStatsCommand(["--json"], { store, stdout: json, now: () => NOW })).toBe(0)
    expect(json.text).toBe("[]\n")
  })

  test("the human table aligns columns and ends with a totals row", async () => {
    const store = await makeStore()
    await writeSession(
      store,
      codesplashSession("project-a", "s1", "2026-02-25T00:00:00.000Z", "claude-fable-5", {
        inputTokens: 12_000,
        outputTokens: 3_400,
        estimatedCostUsd: 0.435,
      }),
    )

    const stdout = new Sink()
    expect(await runStatsCommand([], { store, stdout, now: () => NOW })).toBe(0)

    const lines = stdout.text.trimEnd().split("\n")
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/^Engine\s+Model\s+Sessions\s+Input\s+Output\s+Est\. cost$/)
    expect(lines[1]).toContain("codesplash")
    expect(lines[1]).toContain("claude-fable-5")
    expect(lines[1]).toContain("$0.4350")
    expect(lines[2]).toStartWith("Total")
    expect(lines[2]).toContain("12000")
    expect(lines[2]).toContain("3400")
    expect(lines[2]).toContain("$0.4350")
  })
})

describe("formatStatsTable", () => {
  test("right-aligns numeric columns so every value ends under its header", () => {
    const rows: StatsRow[] = [
      {
        engine: "codesplash",
        model: "m",
        sessions: 2,
        inputTokens: 10,
        outputTokens: 5,
        estimatedCostUsd: 1,
      },
      {
        engine: "codex",
        model: "long-model-name",
        sessions: 100,
        inputTokens: 123_456,
        outputTokens: 7,
        estimatedCostUsd: 0,
      },
    ]
    const lines = formatStatsTable(rows).trimEnd().split("\n")
    const header = lines[0] as string
    const start = header.indexOf("Sessions")
    const end = start + "Sessions".length
    expect(lines[1]?.slice(start, end)).toBe("       2")
    expect(lines[2]?.slice(start, end)).toBe("     100")
    expect(lines[3]?.slice(start, end)).toBe("     102")
    expect(lines[2]).toContain("123456")
  })
})
