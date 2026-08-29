import { afterEach, beforeEach, describe, expect, test } from "bun:test"
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
  type OpenSessionOptions,
  type SessionPolicy,
  serializeEvent,
  type UserInput,
} from "../../../src/core/index.ts"
import {
  type HeadlessRunOptions,
  headlessModelSelector,
  runHeadless,
} from "../../../src/engines/codesplash/runner.ts"

const TIMESTAMP = "2026-01-01T00:00:00.000Z"
const LOCAL_SESSION_ID = "run-1"

const policy: SessionPolicy = { sandbox: "workspace-write", approvalPolicy: "on-request" }

const capabilities: EngineCapabilities = {
  nativeTranscript: true,
  approvals: true,
  interrupt: true,
  resume: false,
  usage: "tokens",
  surface: "native",
}

/* --------------------------- scripted fake driver (FakeSession-style) --------------------------- */

type Script = (session: ScriptedSession, input: UserInput) => Promise<void>

class ScriptedSession implements EngineSession {
  readonly localSessionId: string
  readonly nativeSessionId: string
  readonly capabilities = capabilities
  readonly queue = new AsyncQueue<AgentEvent>()
  readonly events = this.queue
  readonly inputs: UserInput[] = []
  readonly decisions: Array<{ requestId: string; decision: EngineDecision }> = []
  interrupts = 0
  closed = false
  readonly #script: Script
  readonly #pendingDecisions = new Map<string, (choice: string) => void>()
  readonly #interruptWaiters: Array<() => void> = []

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

  /** Resolves once interrupt() has been called (immediately when it already was). */
  nextInterrupt(): Promise<void> {
    if (this.interrupts > 0) return Promise.resolve()
    return new Promise((resolve) => this.#interruptWaiters.push(resolve))
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

  async interrupt(): Promise<void> {
    this.interrupts += 1
    for (const waiter of this.#interruptWaiters.splice(0)) waiter()
  }

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

/** Deterministic event factory: fixed timestamp, session id, and monotonic sequence numbers. */
function eventFactory(): (input: AgentEventInput, raw?: unknown) => AgentEvent {
  let sequence = 0
  return (input, raw) =>
    createAgentEvent(
      {
        engine: "codesplash",
        localSessionId: LOCAL_SESSION_ID,
        sequence: sequence++,
        timestamp: TIMESTAMP,
        ...(raw === undefined ? {} : { raw }),
      },
      input,
    )
}

class Sink {
  text = ""

  write(chunk: string): boolean {
    this.text += chunk
    return true
  }
}

function runOptions(
  driver: ScriptedDriver,
  overrides: Partial<HeadlessRunOptions> = {},
): { options: HeadlessRunOptions; stdout: Sink; stderr: Sink } {
  const stdout = new Sink()
  const stderr = new Sink()
  return {
    stdout,
    stderr,
    options: {
      prompt: "say hi",
      cwd: "/tmp/headless-cwd",
      policy,
      autoApprove: false,
      outputFormat: "text",
      driver,
      localSessionId: LOCAL_SESSION_ID,
      stdout,
      stderr,
      ...overrides,
    },
  }
}

async function until(condition: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

/* -------------------------------------- env hygiene -------------------------------------- */

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
  savedEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
})

afterEach(() => {
  for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const) {
    const value = savedEnv[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

/* ------------------------------------------ tests ------------------------------------------ */

describe("runHeadless text output", () => {
  test("streams assistant deltas to stdout and tool labels with status to stderr", async () => {
    const ev = eventFactory()
    const driver = new ScriptedDriver(async (session) => {
      session.emit(ev({ kind: "turn.started", payload: {} }))
      session.emit(ev({ kind: "message.delta", payload: { id: "m1", text: "Hi " } }))
      session.emit(ev({ kind: "message.delta", payload: { id: "m1", text: "there" } }))
      session.emit(ev({ kind: "item.updated", payload: { id: "t1", label: "bash: ls", status: "running" } }))
      session.emit(
        ev({
          kind: "item.updated",
          payload: { id: "t1", label: "bash: ls", output: "ok", status: "completed" },
        }),
      )
      session.emit(ev({ kind: "message.completed", payload: { id: "m1", text: "Hi there" } }))
      session.emit(ev({ kind: "turn.completed", payload: { status: "completed" } }))
    })

    const { options, stdout, stderr } = runOptions(driver)
    const exitCode = await runHeadless(options)

    expect(exitCode).toBe(0)
    expect(stdout.text).toBe("Hi there\n")
    expect(stderr.text).toBe("[running] bash: ls\n[completed] bash: ls\n")
    expect(driver.session?.inputs).toEqual([{ text: "say hi" }])
    expect(driver.session?.closed).toBe(true)
  })

  test("prints completed-message text the deltas never carried, exactly once", async () => {
    const ev = eventFactory()
    const driver = new ScriptedDriver(async (session) => {
      session.emit(ev({ kind: "turn.started", payload: {} }))
      session.emit(ev({ kind: "message.delta", payload: { id: "m1", text: "partial" } }))
      session.emit(ev({ kind: "message.completed", payload: { id: "m1", text: "partial, then the rest" } }))
      session.emit(ev({ kind: "turn.completed", payload: { status: "completed" } }))
    })

    const { options, stdout } = runOptions(driver)
    const exitCode = await runHeadless(options)

    expect(exitCode).toBe(0)
    expect(stdout.text).toBe("partial, then the rest\n")
  })
})

describe("runHeadless json output", () => {
  test("writes nothing until the end, then exactly one result object", async () => {
    const ev = eventFactory()
    const driver = new ScriptedDriver(async (session) => {
      session.emit(ev({ kind: "turn.started", payload: {} }))
      session.emit(ev({ kind: "message.delta", payload: { id: "m1", text: "The answer" } }))
      session.emit(
        ev({
          kind: "usage.updated",
          payload: { inputTokens: 12, outputTokens: 5, contextTokens: 17, modelContextWindow: 200_000 },
        }),
      )
      session.emit(ev({ kind: "message.completed", payload: { id: "m1", text: "The answer is 42." } }))
      session.emit(ev({ kind: "turn.completed", payload: { status: "completed" } }))
    })

    const { options, stdout, stderr } = runOptions(driver, { outputFormat: "json" })
    const exitCode = await runHeadless(options)

    expect(exitCode).toBe(0)
    expect(stdout.text).toBe(
      '{"result":"The answer is 42.","turns":1,"usage":{"inputTokens":12,"outputTokens":5,"totalTokens":17},"status":"completed","sessionId":"run-1"}\n',
    )
    expect(stderr.text).toBe("")
  })

  test("carries the estimated cost inside usage when the engine reported one", async () => {
    const ev = eventFactory()
    const driver = new ScriptedDriver(async (session) => {
      session.emit(ev({ kind: "turn.started", payload: {} }))
      session.emit(
        ev({
          kind: "usage.updated",
          payload: { inputTokens: 10, outputTokens: 2, estimatedCostUsd: 0.0125 },
        }),
      )
      session.emit(
        ev({
          kind: "usage.updated",
          payload: { inputTokens: 30, outputTokens: 7, estimatedCostUsd: 0.0375 },
        }),
      )
      session.emit(ev({ kind: "message.completed", payload: { id: "m1", text: "priced" } }))
      session.emit(ev({ kind: "turn.completed", payload: { status: "completed" } }))
    })

    const { options, stdout } = runOptions(driver, { outputFormat: "json" })
    const exitCode = await runHeadless(options)

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout.text) as {
      sessionId: string
      usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number }
    }
    expect(parsed.sessionId).toBe(LOCAL_SESSION_ID)
    // The last cumulative usage event wins, mirroring the TUI reducer.
    expect(parsed.usage).toEqual({ inputTokens: 30, outputTokens: 7, estimatedCostUsd: 0.0375 })
  })
})

describe("runHeadless stream-json output", () => {
  test("emits every event as a recorder-shaped JSON line with raw stripped, then a result line", async () => {
    const ev = eventFactory()
    const scripted: AgentEvent[] = [
      ev({ kind: "turn.started", payload: {} }, { providerSecret: "raw-must-not-appear" }),
      ev({ kind: "message.delta", payload: { id: "m1", text: "Hi" } }),
      ev({ kind: "message.completed", payload: { id: "m1", text: "Hi" } }),
      ev({ kind: "turn.completed", payload: { status: "completed" } }),
    ]
    const driver = new ScriptedDriver(async (session) => {
      for (const event of scripted) session.emit(event)
    })

    const { options, stdout } = runOptions(driver, { outputFormat: "stream-json" })
    const exitCode = await runHeadless(options)

    expect(exitCode).toBe(0)
    const expectedEventLines = scripted.map((event) => serializeEvent(event)).join("\n")
    expect(stdout.text).toBe(
      `${expectedEventLines}\n` +
        '{"type":"result","result":"Hi","status":"completed","usage":{},"sessionId":"run-1"}\n',
    )
    expect(stdout.text.split("\n")[0]).toBe(
      '{"schemaVersion":1,"timestamp":"2026-01-01T00:00:00.000Z","engine":"codesplash",' +
        '"localSessionId":"run-1","sequence":0,"kind":"turn.started","payload":{}}',
    )
    expect(stdout.text).not.toContain("raw-must-not-appear")
    expect(stdout.text).not.toContain('"raw"')
  })
})

describe("runHeadless approvals and user input", () => {
  const approvalScript: Script = async (session) => {
    const ev = eventFactory()
    session.emit(ev({ kind: "turn.started", payload: {} }))
    const choice = await session.ask(
      ev({
        kind: "request.opened",
        payload: {
          id: "req-1",
          requestKind: "approval",
          title: "Run command?",
          detail: "$ ls",
          choices: ["accept", "acceptForSession", "decline", "cancel"],
        },
      }) as AgentEvent & { kind: "request.opened" },
    )
    session.emit(ev({ kind: "request.resolved", payload: { id: "req-1", decision: choice } }))
    // A duplicate request.opened for an already-resolved id must not produce a second notice.
    session.emit(
      ev({
        kind: "request.opened",
        payload: { id: "req-1", requestKind: "approval", title: "Run command?", detail: "$ ls", choices: [] },
      }),
    )
    if (choice === "accept") {
      session.emit(
        ev({
          kind: "item.updated",
          payload: { id: "t1", label: "bash: ls", output: "ok", status: "completed" },
        }),
      )
      session.emit(ev({ kind: "message.delta", payload: { id: "m1", text: "ran it" } }))
      session.emit(ev({ kind: "message.completed", payload: { id: "m1", text: "ran it" } }))
    } else {
      session.emit(
        ev({
          kind: "item.updated",
          payload: { id: "t1", label: "bash: ls", output: "declined", status: "failed" },
        }),
      )
      session.emit(ev({ kind: "message.delta", payload: { id: "m1", text: "skipped" } }))
      session.emit(ev({ kind: "message.completed", payload: { id: "m1", text: "skipped" } }))
    }
    session.emit(ev({ kind: "turn.completed", payload: { status: "completed" } }))
  }

  test("auto-approve accepts approval requests without a stderr notice", async () => {
    const driver = new ScriptedDriver(approvalScript)
    const { options, stdout, stderr } = runOptions(driver, { autoApprove: true })
    const exitCode = await runHeadless(options)

    expect(exitCode).toBe(0)
    expect(driver.session?.decisions).toEqual([{ requestId: "req-1", decision: { choice: "accept" } }])
    expect(stdout.text).toBe("ran it\n")
    expect(stderr.text).toBe("[completed] bash: ls\n")
  })

  test("without auto-approve every approval is declined with one notice per request", async () => {
    const driver = new ScriptedDriver(approvalScript)
    const { options, stdout, stderr } = runOptions(driver, { autoApprove: false })
    const exitCode = await runHeadless(options)

    expect(exitCode).toBe(0)
    expect(driver.session?.decisions).toEqual([{ requestId: "req-1", decision: { choice: "decline" } }])
    expect(stdout.text).toBe("skipped\n")
    expect(stderr.text).toBe("declined: Run command?\n[failed] bash: ls\n")
  })

  test("user-input requests are always cancelled, even under auto-approve", async () => {
    const driver = new ScriptedDriver(async (session) => {
      const ev = eventFactory()
      session.emit(ev({ kind: "turn.started", payload: {} }))
      const choice = await session.ask(
        ev({
          kind: "request.opened",
          payload: {
            id: "q-1",
            requestKind: "user-input",
            title: "Pick a color",
            detail: "",
            choices: ["red", "blue"],
          },
        }) as AgentEvent & { kind: "request.opened" },
      )
      session.emit(ev({ kind: "request.resolved", payload: { id: "q-1", decision: choice } }))
      session.emit(ev({ kind: "message.delta", payload: { id: "m1", text: "no answer" } }))
      session.emit(ev({ kind: "message.completed", payload: { id: "m1", text: "no answer" } }))
      session.emit(ev({ kind: "turn.completed", payload: { status: "completed" } }))
    })

    const { options, stdout, stderr } = runOptions(driver, { autoApprove: true })
    const exitCode = await runHeadless(options)

    expect(exitCode).toBe(0)
    expect(driver.session?.decisions).toEqual([{ requestId: "q-1", decision: { choice: "cancel" } }])
    expect(stdout.text).toBe("no answer\n")
    expect(stderr.text).toBe("cancelled: Pick a color\n")
  })
})

describe("runHeadless exit codes", () => {
  test("a failed turn exits 1 and the json result reports the failure", async () => {
    const ev = eventFactory()
    const driver = new ScriptedDriver(async (session) => {
      session.emit(ev({ kind: "turn.started", payload: {} }))
      session.emit(ev({ kind: "error", payload: { message: "provider exploded", recoverable: true } }))
      session.emit(ev({ kind: "turn.completed", payload: { status: "failed" } }))
    })

    const { options, stdout, stderr } = runOptions(driver, { outputFormat: "json" })
    const exitCode = await runHeadless(options)

    expect(exitCode).toBe(1)
    expect(stdout.text).toBe('{"result":"","turns":1,"usage":{},"status":"failed","sessionId":"run-1"}\n')
    expect(stderr.text).toBe("error: provider exploded\n")
  })

  test("a session crash that never completes the turn still ends the run with exit 1", async () => {
    const ev = eventFactory()
    const driver = new ScriptedDriver(async (session) => {
      session.emit(ev({ kind: "turn.started", payload: {} }))
      session.emit(ev({ kind: "error", payload: { message: "engine crashed", recoverable: false } }))
      // No turn.completed follows: the runner must close the session instead of hanging.
    })

    const { options, stdout, stderr } = runOptions(driver, { outputFormat: "json" })
    const exitCode = await runHeadless(options)

    expect(exitCode).toBe(1)
    expect(stdout.text).toBe('{"result":"","turns":0,"usage":{},"status":"failed","sessionId":"run-1"}\n')
    expect(stderr.text).toBe("error: engine crashed\n")
    expect(driver.session?.closed).toBe(true)
  })

  test("openSession failure writes the error to stderr and exits 1", async () => {
    const driver: EngineDriver = {
      id: "codesplash",
      probe: async () => ({ available: false }),
      openSession: async () => {
        throw new Error("No API keys found")
      },
    }
    const stdout = new Sink()
    const stderr = new Sink()
    const exitCode = await runHeadless({
      prompt: "hi",
      cwd: "/tmp/headless-cwd",
      policy,
      autoApprove: false,
      outputFormat: "text",
      driver,
      stdout,
      stderr,
    })

    expect(exitCode).toBe(1)
    expect(stdout.text).toBe("")
    expect(stderr.text).toBe("codesplash: No API keys found\n")
  })

  test("SIGINT interrupts the live turn and the run exits 130", async () => {
    const ev = eventFactory()
    const driver = new ScriptedDriver(async (session) => {
      session.emit(ev({ kind: "turn.started", payload: {} }))
      session.emit(ev({ kind: "message.delta", payload: { id: "m1", text: "partial" } }))
      await session.nextInterrupt()
      session.emit(ev({ kind: "message.completed", payload: { id: "m1", text: "partial" } }))
      session.emit(ev({ kind: "turn.completed", payload: { status: "interrupted" } }))
    })

    const { options, stdout } = runOptions(driver)
    const sigintListenersBefore = process.listenerCount("SIGINT")
    const run = runHeadless(options)
    await until(() => stdout.text.includes("partial"), "streamed text before the interrupt")
    process.emit("SIGINT", "SIGINT")

    expect(await run).toBe(130)
    expect(stdout.text).toBe("partial\n")
    expect(driver.session?.interrupts).toBe(1)
    expect(process.listenerCount("SIGINT")).toBe(sigintListenersBefore)
  })

  test("a SIGINT during send() is re-issued once the turn starts and still exits 130", async () => {
    const ev = eventFactory()
    let releaseSend = (): void => {}
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve
    })

    // Models the real engine: send() builds the prompt first, and interrupt() is a no-op until
    // the turn actually exists. A Ctrl-C in that window must not be dropped.
    class GatedSession extends ScriptedSession {
      #turnStarted = false

      override async send(input: UserInput): Promise<void> {
        await sendGate
        this.#turnStarted = true
        await super.send(input)
      }

      override async interrupt(): Promise<void> {
        if (!this.#turnStarted) return
        await super.interrupt()
      }
    }

    const driver = new ScriptedDriver(async (session) => {
      session.emit(ev({ kind: "turn.started", payload: {} }))
      await session.nextInterrupt()
      session.emit(ev({ kind: "turn.completed", payload: { status: "interrupted" } }))
    })
    driver.openSession = async (options: OpenSessionOptions) => {
      driver.openOptions = options
      driver.session = new GatedSession(driver.script, options)
      return driver.session
    }

    const { options } = runOptions(driver)
    const run = runHeadless(options)
    // Give the runner time to install its SIGINT handler and block inside send().
    await Bun.sleep(10)
    process.emit("SIGINT", "SIGINT")
    releaseSend()

    expect(await run).toBe(130)
    expect(driver.session?.interrupts).toBe(1)
  })
})

describe("runHeadless wiring", () => {
  test("passes the model selector, policy, session id, and prompt through to the engine", async () => {
    const ev = eventFactory()
    const driver = new ScriptedDriver(async (session) => {
      session.emit(ev({ kind: "turn.started", payload: {} }))
      session.emit(ev({ kind: "turn.completed", payload: { status: "completed" } }))
    })

    const { options } = runOptions(driver, { model: "claude-sonnet-5", effort: "high" })
    const exitCode = await runHeadless(options)

    expect(exitCode).toBe(0)
    expect(driver.openOptions?.model).toBe("claude-sonnet-5:high")
    expect(driver.openOptions?.policy).toBe(policy)
    expect(driver.openOptions?.cwd).toBe("/tmp/headless-cwd")
    expect(driver.openOptions?.localSessionId).toBe(LOCAL_SESSION_ID)
    expect(driver.session?.inputs).toEqual([{ text: "say hi" }])
  })

  test("passes nativeTranscriptPath and firstSequence through to openSession", async () => {
    const ev = eventFactory()
    const driver = new ScriptedDriver(async (session) => {
      session.emit(ev({ kind: "turn.started", payload: {} }))
      session.emit(ev({ kind: "turn.completed", payload: { status: "completed" } }))
    })

    const { options } = runOptions(driver, {
      nativeTranscriptPath: "/tmp/sessions/abc/transcript.jsonl",
      firstSequence: 42,
    })
    const exitCode = await runHeadless(options)

    expect(exitCode).toBe(0)
    expect(driver.openOptions?.nativeTranscriptPath).toBe("/tmp/sessions/abc/transcript.jsonl")
    expect(driver.openOptions?.firstSequence).toBe(42)
  })

  test("the stream-json result line carries sessionId and the observed estimated cost", async () => {
    const ev = eventFactory()
    const driver = new ScriptedDriver(async (session) => {
      session.emit(ev({ kind: "turn.started", payload: {} }))
      session.emit(
        ev({ kind: "usage.updated", payload: { inputTokens: 8, outputTokens: 3, estimatedCostUsd: 0.02 } }),
      )
      session.emit(ev({ kind: "message.completed", payload: { id: "m1", text: "ok" } }))
      session.emit(ev({ kind: "turn.completed", payload: { status: "completed" } }))
    })

    const { options, stdout } = runOptions(driver, { outputFormat: "stream-json" })
    const exitCode = await runHeadless(options)

    expect(exitCode).toBe(0)
    const lines = stdout.text.split("\n").filter((line) => line.length > 0)
    const result = JSON.parse(lines[lines.length - 1] ?? "") as {
      type: string
      sessionId: string
      usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number }
    }
    expect(result.type).toBe("result")
    expect(result.sessionId).toBe(LOCAL_SESSION_ID)
    expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 3, estimatedCostUsd: 0.02 })
  })

  test("records every consumed event, the native session id, and flushes the recorder", async () => {
    const ev = eventFactory()
    const driver = new ScriptedDriver(async (session) => {
      session.emit(ev({ kind: "turn.started", payload: {} }))
      session.emit(ev({ kind: "message.delta", payload: { id: "m1", text: "hi" } }))
      session.emit(ev({ kind: "message.completed", payload: { id: "m1", text: "hi" } }))
      session.emit(ev({ kind: "turn.completed", payload: { status: "completed" } }))
    })

    const recorded: AgentEvent[] = []
    const nativeIds: string[] = []
    let flushes = 0
    const recorder = {
      record: (event: AgentEvent) => {
        recorded.push(event)
      },
      recordNativeSessionId: (id: string) => {
        nativeIds.push(id)
      },
      flush: async () => {
        flushes += 1
      },
    }

    const { options } = runOptions(driver, { recorder })
    const exitCode = await runHeadless(options)

    expect(exitCode).toBe(0)
    expect(recorded.map((event) => event.kind)).toEqual([
      "turn.started",
      "message.delta",
      "message.completed",
      "turn.completed",
    ])
    expect(nativeIds).toEqual([LOCAL_SESSION_ID])
    expect(flushes).toBe(1)
  })
})

describe("headlessModelSelector", () => {
  test("combines model and effort, passes bare models through, and defaults for effort-only", () => {
    expect(headlessModelSelector(undefined, undefined)).toBeUndefined()
    expect(headlessModelSelector("claude-sonnet-5", undefined)).toBe("claude-sonnet-5")
    expect(headlessModelSelector("claude-sonnet-5", "high")).toBe("claude-sonnet-5:high")
    // With no provider keys set the session default provider is openai (matching the catalog).
    expect(headlessModelSelector(undefined, "low")).toBe("gpt-5.1:low")
  })
})
