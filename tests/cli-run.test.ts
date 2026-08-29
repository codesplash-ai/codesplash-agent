import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runRunCommand, UsageError } from "../src/cli.ts"
import {
  type AgentEvent,
  type AgentEventInput,
  AsyncQueue,
  createAgentEvent,
  type EngineCapabilities,
  type EngineDecision,
  type EngineDriver,
  type EngineProbe,
  type EngineSession,
  listProjectSessions,
  type OpenSessionOptions,
  projectIdFor,
  readSessionEvents,
  type SessionMeta,
  SessionStore,
  serializeEvent,
  sessionDirectory,
  transcriptPathFor,
  type UserInput,
} from "../src/core/index.ts"

const TIMESTAMP = "2026-01-01T00:00:00.000Z"

const capabilities: EngineCapabilities = {
  nativeTranscript: true,
  approvals: true,
  interrupt: true,
  resume: false,
  usage: "tokens",
  surface: "native",
}

/* ----------------------- scripted fake driver (mirrors runner.test.ts) ----------------------- */

type Script = (session: ScriptedSession, input: UserInput) => Promise<void>

class ScriptedSession implements EngineSession {
  readonly localSessionId: string
  readonly nativeSessionId: string
  readonly capabilities = capabilities
  readonly queue = new AsyncQueue<AgentEvent>()
  readonly events = this.queue
  readonly inputs: UserInput[] = []
  readonly decisions: Array<{ requestId: string; decision: EngineDecision }> = []
  closed = false
  readonly #script: Script
  readonly #pendingDecisions = new Map<string, (choice: string) => void>()

  constructor(script: Script, options: OpenSessionOptions) {
    this.#script = script
    this.localSessionId = options.localSessionId
    this.nativeSessionId = options.localSessionId
  }

  emit(event: AgentEvent): void {
    if (!this.closed) this.queue.push(event)
  }

  /** Emits a request.opened event and waits for the runner's decision on it. */
  ask(event: AgentEvent & { kind: "request.opened" }): Promise<string> {
    this.emit(event)
    return new Promise((resolve) => this.#pendingDecisions.set(event.payload.id, resolve))
  }

  async send(input: UserInput): Promise<void> {
    this.inputs.push(input)
    void this.#script(this, input).catch((error) => {
      this.queue.fail(error instanceof Error ? error : new Error(String(error)))
    })
  }

  async resolveRequest(requestId: string, decision: EngineDecision): Promise<void> {
    this.decisions.push({ requestId, decision })
    const settle = this.#pendingDecisions.get(requestId)
    this.#pendingDecisions.delete(requestId)
    settle?.(decision.choice)
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.queue.end()
  }
}

class ScriptedDriver implements EngineDriver {
  readonly id = "codesplash" as const
  openOptions: OpenSessionOptions | undefined
  session: ScriptedSession | undefined

  constructor(readonly script: Script) {}

  async probe(): Promise<EngineProbe> {
    return { available: true, authenticated: true }
  }

  async openSession(options: OpenSessionOptions): Promise<EngineSession> {
    this.openOptions = options
    this.session = new ScriptedSession(this.script, options)
    return this.session
  }
}

/** Deterministic event factory: fixed timestamp and session id, monotonic sequence numbers. */
function eventFactory(): (input: AgentEventInput, raw?: unknown) => AgentEvent {
  let sequence = 0
  return (input, raw) =>
    createAgentEvent(
      {
        engine: "codesplash",
        localSessionId: "cli-run-1",
        sequence: sequence++,
        timestamp: TIMESTAMP,
        ...(raw === undefined ? {} : { raw }),
      },
      input,
    )
}

const simpleScript: Script = async (session) => {
  const ev = eventFactory()
  session.emit(ev({ kind: "turn.started", payload: {} }))
  session.emit(ev({ kind: "message.delta", payload: { id: "m1", text: "All " } }))
  session.emit(ev({ kind: "message.delta", payload: { id: "m1", text: "done" } }))
  session.emit(
    ev({
      kind: "usage.updated",
      payload: { inputTokens: 10, outputTokens: 4, contextTokens: 14, modelContextWindow: 200_000 },
    }),
  )
  session.emit(ev({ kind: "message.completed", payload: { id: "m1", text: "All done" } }))
  session.emit(ev({ kind: "turn.completed", payload: { status: "completed" } }))
}

const approvalScript: Script = async (session) => {
  const ev = eventFactory()
  session.emit(ev({ kind: "turn.started", payload: {} }))
  const choice = await session.ask(
    ev({
      kind: "request.opened",
      payload: {
        id: "req-1",
        requestKind: "approval",
        title: "Write files?",
        detail: "a.txt",
        choices: ["accept", "decline"],
      },
    }) as AgentEvent & { kind: "request.opened" },
  )
  const text = choice === "accept" ? "wrote it" : "skipped it"
  session.emit(ev({ kind: "message.completed", payload: { id: "m1", text } }))
  session.emit(ev({ kind: "turn.completed", payload: { status: "completed" } }))
}

/* ----------------------------------------- fixtures ----------------------------------------- */

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

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanups.push(dir)
  return dir
}

type Fixture = {
  projectDir: string
  sessionsRoot: string
  store: SessionStore
  env: NodeJS.ProcessEnv
  stdout: Sink
  stderr: Sink
}

async function makeFixture(): Promise<Fixture> {
  const projectDir = await makeTempDir("codesplash-cli-run-project-")
  const sessionsRoot = join(await makeTempDir("codesplash-cli-run-data-"), "sessions")
  return {
    projectDir,
    sessionsRoot,
    store: new SessionStore(sessionsRoot),
    env: { CODESPLASH_AGENT_CONFIG_DIR: await makeTempDir("codesplash-cli-run-config-") },
    stdout: new Sink(),
    stderr: new Sink(),
  }
}

function overridesFor(fixture: Fixture, driver: EngineDriver): Parameters<typeof runRunCommand>[1] {
  return {
    driver,
    stdout: fixture.stdout,
    stderr: fixture.stderr,
    env: fixture.env,
    store: fixture.store,
    stdinIsTty: true,
  }
}

/* ------------------------------------------- tests ------------------------------------------- */

describe("codesplash run e2e (fake driver)", () => {
  test("text format streams to stdout, records the session, and closes the meta", async () => {
    const fixture = await makeFixture()
    const driver = new ScriptedDriver(simpleScript)

    const exitCode = await runRunCommand([fixture.projectDir, "-p", "say hi"], overridesFor(fixture, driver))

    expect(exitCode).toBe(0)
    expect(fixture.stdout.text).toBe("All done\n")
    expect(fixture.stderr.text).toBe("")
    expect(driver.session?.inputs).toEqual([{ text: "say hi" }])
    expect(driver.openOptions?.cwd).toBe(fixture.projectDir)
    expect(driver.openOptions?.policy).toEqual({ sandbox: "workspace-write", approvalPolicy: "on-request" })

    const projectId = projectIdFor(fixture.projectDir)
    const sessions = await listProjectSessions(projectId, fixture.sessionsRoot)
    expect(sessions).toHaveLength(1)
    const meta = sessions[0]
    expect(meta?.engine).toBe("codesplash")
    expect(meta?.projectPath).toBe(fixture.projectDir)
    expect(meta?.lastStatus).toBe("closed")
    expect(meta?.localSessionId).toBe(driver.openOptions?.localSessionId as string)
    expect(meta?.nativeSessionId).toBe(driver.openOptions?.localSessionId as string)

    const directory = sessionDirectory(fixture.sessionsRoot, projectId, meta?.localSessionId as string)
    const { events } = await readSessionEvents(directory)
    expect(events.map((event) => event.kind)).toEqual([
      "turn.started",
      "message.delta",
      "usage.updated",
      "message.completed",
      "turn.completed",
    ])
  })

  test("json format writes exactly one result object", async () => {
    const fixture = await makeFixture()
    const driver = new ScriptedDriver(simpleScript)

    const exitCode = await runRunCommand(
      [fixture.projectDir, "-p", "say hi", "--output-format", "json"],
      overridesFor(fixture, driver),
    )

    expect(exitCode).toBe(0)
    const sessionId = driver.openOptions?.localSessionId as string
    expect(fixture.stdout.text).toBe(
      '{"result":"All done","turns":1,"usage":{"inputTokens":10,"outputTokens":4,"totalTokens":14},' +
        `"status":"completed","sessionId":"${sessionId}"}\n`,
    )
    expect(fixture.stderr.text).toBe("")
  })

  test("stream-json format emits every event as a JSON line, then the result line", async () => {
    const fixture = await makeFixture()
    const driver = new ScriptedDriver(simpleScript)

    const exitCode = await runRunCommand(
      [fixture.projectDir, "-p", "say hi", "--output-format=stream-json"],
      overridesFor(fixture, driver),
    )

    expect(exitCode).toBe(0)
    const expectedScript: AgentEvent[] = []
    const collect = new ScriptedSession(async () => {}, {
      cwd: fixture.projectDir,
      localSessionId: "cli-run-1",
    })
    collect.emit = (event) => expectedScript.push(event)
    await simpleScript(collect, { text: "say hi" })
    const expectedLines = expectedScript.map((event) => serializeEvent(event)).join("\n")
    const sessionId = driver.openOptions?.localSessionId as string
    expect(fixture.stdout.text).toBe(
      `${expectedLines}\n` +
        '{"type":"result","result":"All done","status":"completed",' +
        `"usage":{"inputTokens":10,"outputTokens":4,"totalTokens":14},"sessionId":"${sessionId}"}\n`,
    )
  })

  test("--auto accepts approvals; without it they are declined with a notice", async () => {
    const autoFixture = await makeFixture()
    const autoDriver = new ScriptedDriver(approvalScript)
    expect(
      await runRunCommand(
        [autoFixture.projectDir, "-p", "go", "--auto"],
        overridesFor(autoFixture, autoDriver),
      ),
    ).toBe(0)
    expect(autoDriver.session?.decisions).toEqual([{ requestId: "req-1", decision: { choice: "accept" } }])
    expect(autoFixture.stdout.text).toBe("wrote it\n")
    expect(autoFixture.stderr.text).toBe("")

    const declineFixture = await makeFixture()
    const declineDriver = new ScriptedDriver(approvalScript)
    expect(
      await runRunCommand(
        [declineFixture.projectDir, "-p", "go"],
        overridesFor(declineFixture, declineDriver),
      ),
    ).toBe(0)
    expect(declineDriver.session?.decisions).toEqual([
      { requestId: "req-1", decision: { choice: "decline" } },
    ])
    expect(declineFixture.stdout.text).toBe("skipped it\n")
    expect(declineFixture.stderr.text).toBe("declined: Write files?\n")
  })

  test("a failed turn exits 1 and the session meta closes as failed", async () => {
    const fixture = await makeFixture()
    const driver = new ScriptedDriver(async (session) => {
      const ev = eventFactory()
      session.emit(ev({ kind: "turn.started", payload: {} }))
      session.emit(ev({ kind: "error", payload: { message: "provider exploded", recoverable: true } }))
      session.emit(ev({ kind: "turn.completed", payload: { status: "failed" } }))
    })

    const exitCode = await runRunCommand([fixture.projectDir, "-p", "go"], overridesFor(fixture, driver))

    expect(exitCode).toBe(1)
    expect(fixture.stderr.text).toBe("error: provider exploded\n")
    const sessions = await listProjectSessions(projectIdFor(fixture.projectDir), fixture.sessionsRoot)
    expect(sessions[0]?.lastStatus).toBe("failed")
  })

  test("prompt falls back to piped stdin when no flag or positional text is given", async () => {
    const fixture = await makeFixture()
    const driver = new ScriptedDriver(simpleScript)

    const exitCode = await runRunCommand([fixture.projectDir], {
      ...overridesFor(fixture, driver),
      stdinIsTty: false,
      readStdinText: async () => "piped prompt\n",
    })

    expect(exitCode).toBe(0)
    expect(driver.session?.inputs).toEqual([{ text: "piped prompt" }])
  })

  test("--prompt wins over piped stdin, which is never read", async () => {
    const fixture = await makeFixture()
    const driver = new ScriptedDriver(simpleScript)

    const exitCode = await runRunCommand([fixture.projectDir, "--prompt", "from flag"], {
      ...overridesFor(fixture, driver),
      stdinIsTty: false,
      readStdinText: async () => {
        throw new Error("stdin must not be read when --prompt is given")
      },
    })

    expect(exitCode).toBe(0)
    expect(driver.session?.inputs).toEqual([{ text: "from flag" }])
  })

  test("positional text after the path is the prompt", async () => {
    const fixture = await makeFixture()
    const driver = new ScriptedDriver(simpleScript)

    const exitCode = await runRunCommand([fixture.projectDir, "fix the tests"], overridesFor(fixture, driver))

    expect(exitCode).toBe(0)
    expect(driver.session?.inputs).toEqual([{ text: "fix the tests" }])
  })

  test("an interactive terminal with no prompt is a usage error, not a hang", async () => {
    const fixture = await makeFixture()
    const driver = new ScriptedDriver(simpleScript)

    await expect(
      runRunCommand([fixture.projectDir], { ...overridesFor(fixture, driver), stdinIsTty: true }),
    ).rejects.toThrow(UsageError)
  })

  test("--no-history runs without touching the session store or the transcript", async () => {
    const fixture = await makeFixture()
    const driver = new ScriptedDriver(simpleScript)
    const poisonedStore = {
      create: async () => {
        throw new Error("the store must not be used under --no-history")
      },
    } as unknown as SessionStore

    const exitCode = await runRunCommand([fixture.projectDir, "-p", "go", "--no-history"], {
      ...overridesFor(fixture, driver),
      store: poisonedStore,
    })

    expect(exitCode).toBe(0)
    expect(fixture.stdout.text).toBe("All done\n")
    expect(driver.openOptions?.nativeTranscriptPath).toBeUndefined()
    expect(driver.openOptions?.firstSequence).toBeUndefined()
  })

  test("--model passes the selector through and rejects unknown models as usage errors", async () => {
    const fixture = await makeFixture()
    const driver = new ScriptedDriver(simpleScript)

    const exitCode = await runRunCommand(
      [fixture.projectDir, "-p", "go", "--model", "claude-sonnet-5:high"],
      overridesFor(fixture, driver),
    )
    expect(exitCode).toBe(0)
    expect(driver.openOptions?.model).toBe("claude-sonnet-5:high")

    const badFixture = await makeFixture()
    await expect(
      runRunCommand(
        [badFixture.projectDir, "-p", "go", "--model", "not-a-model"],
        overridesFor(badFixture, new ScriptedDriver(simpleScript)),
      ),
    ).rejects.toThrow(UsageError)
  })

  test("--sandbox read-only reaches the engine policy", async () => {
    const fixture = await makeFixture()
    const driver = new ScriptedDriver(simpleScript)

    const exitCode = await runRunCommand(
      [fixture.projectDir, "-p", "go", "--sandbox", "read-only"],
      overridesFor(fixture, driver),
    )

    expect(exitCode).toBe(0)
    expect(driver.openOptions?.policy).toEqual({ sandbox: "read-only", approvalPolicy: "on-request" })
  })

  test("a recorded run passes the session's transcript path to the engine", async () => {
    const fixture = await makeFixture()
    const driver = new ScriptedDriver(simpleScript)

    const exitCode = await runRunCommand([fixture.projectDir, "-p", "go"], overridesFor(fixture, driver))

    expect(exitCode).toBe(0)
    const projectId = projectIdFor(fixture.projectDir)
    const sessionId = driver.openOptions?.localSessionId as string
    expect(driver.openOptions?.nativeTranscriptPath).toBe(
      transcriptPathFor({ directory: sessionDirectory(fixture.sessionsRoot, projectId, sessionId) }),
    )
    expect(driver.openOptions?.firstSequence).toBeUndefined()
  })

  test("--effort combines with --model into the engine selector", async () => {
    const fixture = await makeFixture()
    const driver = new ScriptedDriver(simpleScript)

    const exitCode = await runRunCommand(
      [fixture.projectDir, "-p", "go", "--model", "claude-sonnet-5", "--effort", "low"],
      overridesFor(fixture, driver),
    )

    expect(exitCode).toBe(0)
    expect(driver.openOptions?.model).toBe("claude-sonnet-5:low")

    const doubled = await makeFixture()
    await expect(
      runRunCommand(
        [doubled.projectDir, "-p", "go", "--model", "claude-sonnet-5:high", "--effort", "low"],
        overridesFor(doubled, new ScriptedDriver(simpleScript)),
      ),
    ).rejects.toThrow(UsageError)
  })

  test("-c overrides reach the run's config load", async () => {
    const fixture = await makeFixture()
    const driver = new ScriptedDriver(simpleScript)

    const exitCode = await runRunCommand(
      [fixture.projectDir, "-p", "go", "-c", "codex.sandbox=read-only"],
      overridesFor(fixture, driver),
    )

    expect(exitCode).toBe(0)
    expect(driver.openOptions?.policy).toEqual({ sandbox: "read-only", approvalPolicy: "on-request" })
  })

  test("custom-provider models from config.toml pass --model validation", async () => {
    const fixture = await makeFixture()
    const driver = new ScriptedDriver(simpleScript)
    await Bun.write(
      join(fixture.env.CODESPLASH_AGENT_CONFIG_DIR as string, "config.toml"),
      [
        "[providers.local]",
        'protocol = "openai"',
        'baseUrl = "http://localhost:9/v1"',
        "requiresKey = false",
        "",
        "[[providers.local.models]]",
        'id = "local-model"',
        "",
      ].join("\n"),
    )

    const exitCode = await runRunCommand(
      [fixture.projectDir, "-p", "go", "--model", "local-model"],
      overridesFor(fixture, driver),
    )

    expect(exitCode).toBe(0)
    expect(driver.openOptions?.model).toBe("local-model")
  })

  test("--max-turns is forwarded to the runner options", async () => {
    const fixture = await makeFixture()
    let sawTurns = 0
    const driver = new ScriptedDriver(async (session) => {
      const ev = eventFactory()
      sawTurns += 1
      session.emit(ev({ kind: "turn.started", payload: {} }))
      session.emit(ev({ kind: "message.completed", payload: { id: "m1", text: "ok" } }))
      session.emit(ev({ kind: "turn.completed", payload: { status: "completed" } }))
    })

    const exitCode = await runRunCommand(
      [fixture.projectDir, "-p", "go", "--max-turns", "2"],
      overridesFor(fixture, driver),
    )

    expect(exitCode).toBe(0)
    expect(sawTurns).toBe(1)
  })
})

/* --------------------------------- resume and continue --------------------------------- */

/** Seeds one recorded session (meta plus one prior event line) into the fixture's store. */
async function seedSession(
  fixture: Fixture,
  patch: Partial<SessionMeta> & { localSessionId: string },
): Promise<SessionMeta> {
  const meta: SessionMeta = {
    schemaVersion: 1,
    engine: "codesplash",
    projectPath: fixture.projectDir,
    projectId: projectIdFor(fixture.projectDir),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastStatus: "closed",
    lastSequence: 4,
    sandbox: "read-only",
    approvalPolicy: "untrusted",
    ...patch,
  }
  const handle = await fixture.store.create(meta)
  const prior = createAgentEvent(
    {
      engine: meta.engine,
      localSessionId: meta.localSessionId,
      sequence: meta.lastSequence,
      timestamp: meta.updatedAt,
    },
    { kind: "user.message", payload: { id: "u-0", text: "earlier prompt" } },
  )
  await handle.appendEventLines([serializeEvent(prior)])
  return meta
}

describe("codesplash run --resume / --continue (fake driver)", () => {
  test("--resume appends to the recorded session and reuses its policy", async () => {
    const fixture = await makeFixture()
    await seedSession(fixture, { localSessionId: "resume-1" })
    const driver = new ScriptedDriver(simpleScript)

    const exitCode = await runRunCommand(
      [fixture.projectDir, "-p", "again", "--resume", "resume-1"],
      overridesFor(fixture, driver),
    )

    expect(exitCode).toBe(0)
    expect(driver.openOptions?.localSessionId).toBe("resume-1")
    expect(driver.openOptions?.firstSequence).toBe(5)
    expect(driver.openOptions?.policy).toEqual({ sandbox: "read-only", approvalPolicy: "untrusted" })
    const directory = sessionDirectory(fixture.sessionsRoot, projectIdFor(fixture.projectDir), "resume-1")
    expect(driver.openOptions?.nativeTranscriptPath).toBe(transcriptPathFor({ directory }))

    // The prior history stays and the new turn's events land after it in the same log.
    const { events } = await readSessionEvents(directory)
    expect(events[0]?.kind).toBe("user.message")
    expect(events.map((event) => event.kind)).toEqual([
      "user.message",
      "turn.started",
      "message.delta",
      "usage.updated",
      "message.completed",
      "turn.completed",
    ])
    const sessions = await listProjectSessions(projectIdFor(fixture.projectDir), fixture.sessionsRoot)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.lastStatus).toBe("closed")
  })

  test("stale meta never re-issues sequences: the on-disk events decide, and usage is reseeded", async () => {
    const fixture = await makeFixture()
    const meta = await seedSession(fixture, { localSessionId: "resume-stale" })
    // A crash mid-turn leaves events ahead of meta.lastSequence (meta only syncs on
    // turn.completed/session.status): append events past it, including recorded usage.
    const projectId = projectIdFor(fixture.projectDir)
    const handle = await fixture.store.open(projectId, "resume-stale")
    const laterEvents = [
      createAgentEvent(
        { engine: "codesplash", localSessionId: "resume-stale", sequence: 8, timestamp: meta.updatedAt },
        {
          kind: "usage.updated",
          payload: { inputTokens: 900, outputTokens: 40, estimatedCostUsd: 0.25, hasUnpricedUsage: false },
        },
      ),
      createAgentEvent(
        { engine: "codesplash", localSessionId: "resume-stale", sequence: 9, timestamp: meta.updatedAt },
        { kind: "usage.updated", payload: { rateLimit: { usedPercent: 10 } } },
      ),
    ]
    await handle.appendEventLines(laterEvents.map((event) => serializeEvent(event)))

    const driver = new ScriptedDriver(simpleScript)
    const exitCode = await runRunCommand(
      [fixture.projectDir, "-p", "go", "--resume", "resume-stale"],
      overridesFor(fixture, driver),
    )

    expect(exitCode).toBe(0)
    // meta.lastSequence is 4; the highest on-disk event is 9 — the next run starts at 10.
    expect(driver.openOptions?.firstSequence).toBe(10)
    // Cumulative usage from the log seeds the resumed engine session (the rate-limit-only
    // trailing event leaves the token fields intact).
    expect(driver.openOptions?.initialUsage).toEqual({
      inputTokens: 900,
      outputTokens: 40,
      estimatedCostUsd: 0.25,
      hasUnpricedUsage: false,
    })
  })

  test("--sandbox on the command line overrides the recorded sandbox", async () => {
    const fixture = await makeFixture()
    await seedSession(fixture, { localSessionId: "resume-2", sandbox: "read-only" })
    const driver = new ScriptedDriver(simpleScript)

    const exitCode = await runRunCommand(
      [fixture.projectDir, "-p", "go", "--resume", "resume-2", "--sandbox", "workspace-write"],
      overridesFor(fixture, driver),
    )

    expect(exitCode).toBe(0)
    expect(driver.openOptions?.policy).toEqual({
      sandbox: "workspace-write",
      approvalPolicy: "untrusted",
    })
  })

  test("a recorded full-access sandbox degrades to workspace-write with a notice", async () => {
    const fixture = await makeFixture()
    await seedSession(fixture, { localSessionId: "resume-3", sandbox: "danger-full-access" })
    const driver = new ScriptedDriver(simpleScript)

    const exitCode = await runRunCommand(
      [fixture.projectDir, "-p", "go", "--resume", "resume-3"],
      overridesFor(fixture, driver),
    )

    expect(exitCode).toBe(0)
    expect(driver.openOptions?.policy).toEqual({
      sandbox: "workspace-write",
      approvalPolicy: "untrusted",
    })
    expect(fixture.stderr.text).toContain("needs interactive confirmation; using workspace-write")
  })

  test("--continue picks the most recently updated codesplash session, skipping other engines", async () => {
    const fixture = await makeFixture()
    await seedSession(fixture, { localSessionId: "older", updatedAt: "2026-01-01T00:00:00.000Z" })
    await seedSession(fixture, { localSessionId: "newer", updatedAt: "2026-01-02T00:00:00.000Z" })
    await seedSession(fixture, {
      localSessionId: "codex-newest",
      engine: "codex",
      updatedAt: "2026-01-03T00:00:00.000Z",
    })
    const driver = new ScriptedDriver(simpleScript)

    const exitCode = await runRunCommand(
      [fixture.projectDir, "-p", "go", "--continue"],
      overridesFor(fixture, driver),
    )

    expect(exitCode).toBe(0)
    expect(driver.openOptions?.localSessionId).toBe("newer")
  })

  test("missing targets and foreign engines are usage errors", async () => {
    const empty = await makeFixture()
    await expect(
      runRunCommand(
        [empty.projectDir, "-p", "go", "--continue"],
        overridesFor(empty, new ScriptedDriver(simpleScript)),
      ),
    ).rejects.toThrow("No codesplash session to continue in this project")

    const unknown = await makeFixture()
    await expect(
      runRunCommand(
        [unknown.projectDir, "-p", "go", "--resume", "nope"],
        overridesFor(unknown, new ScriptedDriver(simpleScript)),
      ),
    ).rejects.toThrow('No recorded session "nope" for this project')

    const foreign = await makeFixture()
    await seedSession(foreign, { localSessionId: "codex-1", engine: "codex" })
    await expect(
      runRunCommand(
        [foreign.projectDir, "-p", "go", "--resume", "codex-1"],
        overridesFor(foreign, new ScriptedDriver(simpleScript)),
      ),
    ).rejects.toThrow("belongs to the codex engine")
  })

  test("resuming with history disabled via -c is a usage error", async () => {
    const fixture = await makeFixture()
    await seedSession(fixture, { localSessionId: "resume-4" })
    await expect(
      runRunCommand(
        [fixture.projectDir, "-p", "go", "--resume", "resume-4", "-c", "history.enabled=false"],
        overridesFor(fixture, new ScriptedDriver(simpleScript)),
      ),
    ).rejects.toThrow("Resuming needs session history")
  })
})
