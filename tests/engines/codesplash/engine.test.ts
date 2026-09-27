import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig, AgentEvent, CustomProviderConfig, EngineSession } from "../../../src/core/index.ts"
import { defaultConfig } from "../../../src/core/index.ts"
import { setApiKey } from "../../../src/engines/codesplash/auth.ts"
import {
  type PermissionDecision,
  type PermissionMode,
  type PermissionRuntime,
  type ProviderClient,
  ProviderHttpError,
  type ProviderRequest,
  type ProviderStreamEvent,
} from "../../../src/engines/codesplash/contracts.ts"
import {
  CodesplashDriver,
  type PermissionRuntimeFactory,
  type PermissionRuntimeFactoryOptions,
} from "../../../src/engines/codesplash/engine.ts"
import { APP_VERSION } from "../../../src/version.ts"

// Native sandbox startup on hosted Intel macOS can exceed the default five seconds.
setDefaultTimeout(60000)

const ANTHROPIC_KEY_VALUE = "unit-test-anthropic-key-value"
const OPENAI_KEY_VALUE = "unit-test-openai-key-value"

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
  savedEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY
  savedEnv.CODESPLASH_AGENT_CONFIG_DIR = process.env.CODESPLASH_AGENT_CONFIG_DIR
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
  // Point the credential store at a fresh empty path so a developer's real store never leaks in.
  process.env.CODESPLASH_AGENT_CONFIG_DIR = join(tmpdir(), `codesplash-engine-test-config-${randomUUID()}`)
})

afterEach(async () => {
  const temporaryConfigDir = process.env.CODESPLASH_AGENT_CONFIG_DIR
  restoreEnv("ANTHROPIC_API_KEY", savedEnv.ANTHROPIC_API_KEY)
  restoreEnv("OPENAI_API_KEY", savedEnv.OPENAI_API_KEY)
  restoreEnv("CODESPLASH_AGENT_CONFIG_DIR", savedEnv.CODESPLASH_AGENT_CONFIG_DIR)
  if (temporaryConfigDir) await rm(temporaryConfigDir, { recursive: true, force: true })
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function fakeProvider(
  id: ProviderClient["id"],
  scripts: ProviderStreamEvent[][],
): ProviderClient & {
  requests: ProviderRequest[]
} {
  const remaining = [...scripts]
  const requests: ProviderRequest[] = []
  return {
    id,
    models: [],
    requests,
    stream(request) {
      requests.push(request)
      const script = remaining.shift()
      if (!script) throw new Error("fake provider ran out of responses")
      return (async function* () {
        for (const event of script) yield event
      })()
    },
  }
}

/** Scripted PermissionRuntime: mode flips route through onModeChange like the real runtime. */
class FakePermissionRuntime implements PermissionRuntime {
  mode: PermissionMode
  readonly persisted: string[] = []

  constructor(readonly options: PermissionRuntimeFactoryOptions) {
    this.mode = options.mode
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode
    this.options.onModeChange?.(mode)
  }

  decide(): PermissionDecision {
    return { kind: "default" }
  }

  isReadDenied(): string | undefined {
    return undefined
  }

  async persistGrant(rule: string): Promise<void> {
    this.persisted.push(rule)
  }
}

type PermissionCapture = { options?: PermissionRuntimeFactoryOptions; runtime?: FakePermissionRuntime }

/** Injectable factory standing in for createPermissionRuntime (permissions.ts is not exercised here). */
function fakePermissions(
  capture: PermissionCapture = {},
  onCreate?: (options: PermissionRuntimeFactoryOptions) => void,
): PermissionRuntimeFactory {
  return async (options) => {
    onCreate?.(options)
    const runtime = new FakePermissionRuntime(options)
    capture.options = options
    capture.runtime = runtime
    return runtime
  }
}

function collectEvents(session: EngineSession): { events: AgentEvent[]; done: Promise<void> } {
  const events: AgentEvent[] = []
  const done = (async () => {
    for await (const event of session.events) events.push(event)
  })()
  return { events, done }
}

async function until<T>(get: () => T | undefined, label: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = get()
    if (value !== undefined) return value
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

describe("CodesplashDriver.probe", () => {
  test("reports unavailable without echoing anything when no API keys are set", async () => {
    const probe = await new CodesplashDriver().probe()
    expect(probe.available).toBe(false)
    expect(probe.authenticated).toBe(false)
    expect(probe.version).toBe(APP_VERSION)
    expect(probe.detail).toContain("ANTHROPIC_API_KEY")
    expect(probe.detail).toContain("OPENAI_API_KEY")
  })

  test("reports the providers found with an env source, without echoing key values", async () => {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY_VALUE
    const probe = await new CodesplashDriver().probe()
    expect(probe.available).toBe(true)
    expect(probe.authenticated).toBe(true)
    expect(probe.version).toBe(APP_VERSION)
    expect(probe.detail).toBe("Anthropic API key (env)")
    expect(JSON.stringify(probe)).not.toContain(ANTHROPIC_KEY_VALUE)
  })

  test("names both providers when both keys are present", async () => {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY_VALUE
    process.env.OPENAI_API_KEY = OPENAI_KEY_VALUE
    const probe = await new CodesplashDriver().probe()
    expect(probe.detail).toBe("Anthropic API key (env) · OpenAI API key (env)")
    const serialized = JSON.stringify(probe)
    expect(serialized).not.toContain(ANTHROPIC_KEY_VALUE)
    expect(serialized).not.toContain(OPENAI_KEY_VALUE)
  })

  test("reports a stored credential source without echoing the key value", async () => {
    setApiKey("openai", OPENAI_KEY_VALUE)
    const probe = await new CodesplashDriver().probe()
    expect(probe.available).toBe(true)
    expect(probe.detail).toBe("OpenAI API key (stored)")
    expect(JSON.stringify(probe)).not.toContain(OPENAI_KEY_VALUE)
  })

  test("an env var wins over a stored credential for the same provider", async () => {
    setApiKey("anthropic", "stored-key-value")
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY_VALUE
    const probe = await new CodesplashDriver().probe()
    expect(probe.detail).toBe("Anthropic API key (env)")
  })
})

describe("CodesplashDriver sessions", () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "codesplash-engine-test-"))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  async function openSession(model?: string): Promise<{
    session: EngineSession
    events: AgentEvent[]
    done: Promise<void>
  }> {
    const driver = new CodesplashDriver({
      providers: {
        anthropic: fakeProvider("anthropic", []),
        openai: fakeProvider("openai", []),
      },
      permissions: fakePermissions(),
    })
    const session = await driver.openSession({ cwd, localSessionId: "local-session-1", model })
    const { events, done } = collectEvents(session)
    return { session, events, done }
  }

  test("openSession rejects when no provider keys are configured", async () => {
    const driver = new CodesplashDriver()
    await expect(driver.openSession({ cwd, localSessionId: "local-1" })).rejects.toThrow("No API keys")
  })

  test("opens with capabilities, localSessionId as native id, and the default model", async () => {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY_VALUE
    const { session, events, done } = await openSession()
    expect(session.capabilities).toEqual({
      nativeTranscript: true,
      approvals: true,
      interrupt: true,
      resume: true,
      usage: "tokens",
      surface: "native",
    })
    expect(session.localSessionId).toBe("local-session-1")
    expect(session.nativeSessionId).toBe("local-session-1")

    const ready = await until(
      () => events.find((event) => event.kind === "session.status" && event.payload.status === "ready"),
      "ready status",
    )
    expect(ready.kind === "session.status" && ready.payload.model).toBe("claude-fable-5")
    await session.close()
    await done
    expect(events[0]?.kind).toBe("session.status")
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index))
    for (const event of events) {
      expect(event.engine).toBe("codesplash")
      expect(event.localSessionId).toBe("local-session-1")
    }
  })

  test("openSession accepts an id:effort model selector", async () => {
    process.env.OPENAI_API_KEY = OPENAI_KEY_VALUE
    const { session, events, done } = await openSession("gpt-5.1:medium")
    const ready = await until(
      () => events.find((event) => event.kind === "session.status" && event.payload.status === "ready"),
      "ready status",
    )
    expect(ready.kind === "session.status" && ready.payload.model).toBe("gpt-5.1:medium")
    await session.close()
    await done
  })

  test("listModels filters by available providers and flags the session default", async () => {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY_VALUE
    const { session, done } = await openSession()
    const models = await session.listModels?.()
    expect(models?.map((model) => model.id)).toEqual([
      "claude-fable-5",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ])
    expect(models?.find((model) => model.isDefault)?.id).toBe("claude-fable-5")
    expect(models?.every((model) => model.description?.includes("Anthropic"))).toBe(true)
    await session.close()
    await done
  })

  test("listModels includes both catalogs when both keys are present", async () => {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY_VALUE
    process.env.OPENAI_API_KEY = OPENAI_KEY_VALUE
    const { session, done } = await openSession()
    const models = await session.listModels?.()
    expect(models).toHaveLength(6)
    expect(models?.filter((model) => model.isDefault).map((model) => model.id)).toEqual(["claude-fable-5"])
    await session.close()
    await done
  })

  test("listModels defaults to gpt-5.1 when only the OpenAI key is present", async () => {
    process.env.OPENAI_API_KEY = OPENAI_KEY_VALUE
    const { session, done } = await openSession()
    const models = await session.listModels?.()
    expect(models?.map((model) => model.id)).toEqual(["gpt-5.1", "gpt-5.1-mini"])
    expect(models?.filter((model) => model.isDefault).map((model) => model.id)).toEqual(["gpt-5.1"])
    await session.close()
    await done
  })

  test("setModel parses id:effort selectors and announces the switch", async () => {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY_VALUE
    const { session, events, done } = await openSession()
    await session.setModel?.("claude-sonnet-5:high")
    const announced = await until(
      () =>
        events.find(
          (event) => event.kind === "session.status" && event.payload.model === "claude-sonnet-5:high",
        ),
      "model switch status",
    )
    expect(announced.kind).toBe("session.status")

    await session.setModel?.("claude-haiku-4-5-20251001")
    await until(
      () =>
        events.find(
          (event) => event.kind === "session.status" && event.payload.model === "claude-haiku-4-5-20251001",
        ),
      "bare id switch status",
    )
    await session.close()
    await done
  })

  test("setModel rejects unknown models, bad efforts, and unavailable providers", async () => {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY_VALUE
    const { session, done } = await openSession()
    await expect(session.setModel?.("made-up-model")).rejects.toThrow('Unknown model "made-up-model"')
    await expect(session.setModel?.("claude-sonnet-5:extreme")).rejects.toThrow("Invalid reasoning effort")
    await expect(session.setModel?.("gpt-5.1")).rejects.toThrow("OPENAI_API_KEY")
    await session.close()
    await done
  })

  test("native rewind selects exact context and subsequent turns preserve the displaced branch", async () => {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY_VALUE
    const provider = fakeProvider(
      "anthropic",
      ["first response", "abandoned response", "alternate response"].map((text) => [
        { type: "text_delta" as const, text },
        { type: "done" as const, stopReason: "end_turn" as const },
      ]),
    )
    const session = await new CodesplashDriver({
      providers: { anthropic: provider },
      permissions: fakePermissions(),
    }).openSession({ cwd, localSessionId: "rewind-native" })
    const { done } = collectEvents(session)
    try {
      await session.send({ text: "first prompt" })
      await until(
        () => (session.inputQueue?.snapshot().items[0]?.status === "completed" ? true : undefined),
        "first completion",
      )
      const first = (await session.sessionRecovery?.({ action: "tree" }))
        ?.data as import("../../../src/core/session/branches.ts").BranchView
      await session.send({ text: "abandoned prompt" })
      await until(
        () => (session.inputQueue?.snapshot().items[1]?.status === "completed" ? true : undefined),
        "second completion",
      )
      const preview = (await session.sessionRecovery?.({ action: "rewind", node: first.head as string }))
        ?.data as { revision: string }
      await session.sessionRecovery?.({
        action: "rewind",
        node: first.head as string,
        revision: preview.revision,
        apply: true,
      })
      await session.send({ text: "alternate prompt" })
      await until(
        () => (session.inputQueue?.snapshot().items[2]?.status === "completed" ? true : undefined),
        "alternate completion",
      )
      expect(JSON.stringify(provider.requests[2]?.messages)).toContain("first prompt")
      expect(JSON.stringify(provider.requests[2]?.messages)).not.toContain("abandoned prompt")
      const after = (await session.sessionRecovery?.({ action: "tree" }))
        ?.data as import("../../../src/core/session/branches.ts").BranchView
      expect(after.nodes).toHaveLength(4)
      expect(after.nodes.at(-1)?.parent).toBe(first.head)
      expect(after.durable).toBe(false)
      expect(session.inputQueue?.snapshot().paused).toBe(true)
    } finally {
      await session.close()
      await done
    }
  })

  test("send drives a full text turn through the loop with monotonic sequences", async () => {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY_VALUE
    const provider = fakeProvider("anthropic", [
      [
        { type: "text_delta", text: "Hi " },
        { type: "text_delta", text: "there" },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const driver = new CodesplashDriver({
      providers: { anthropic: provider },
      permissions: fakePermissions(),
    })
    const session = await driver.openSession({ cwd, localSessionId: "local-send-1" })
    const { events, done } = collectEvents(session)

    await session.send({ text: "hello there" })
    await until(() => events.find((event) => event.kind === "turn.completed"), "turn.completed")

    const kinds = events.map((event) => event.kind)
    expect(kinds).toContain("user.message")
    expect(kinds).toContain("turn.started")
    expect(kinds).toContain("message.completed")
    const userMessage = events.find((event) => event.kind === "user.message")
    expect(userMessage?.kind === "user.message" && userMessage.payload.text).toBe("hello there")
    const completed = events.find((event) => event.kind === "message.completed")
    expect(completed?.kind === "message.completed" && completed.payload.text).toBe("Hi there")

    expect(provider.requests[0]?.system).toContain("CodeSplash Agent")
    expect(provider.requests[0]?.tools.map((tool) => tool.name)).toContain("read_file")
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index))

    await session.close()
    await done
  })

  test("acknowledged follow-ups wait for the current provider turn and remain serial", async () => {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY_VALUE
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const requests: ProviderRequest[] = []
    let active = 0,
      maximum = 0
    const provider: ProviderClient = {
      id: "anthropic",
      models: [],
      stream(request, signal) {
        requests.push(request)
        const first = requests.length === 1
        return (async function* (): AsyncGenerator<ProviderStreamEvent> {
          active++
          maximum = Math.max(maximum, active)
          try {
            yield { type: "text_delta", text: "response" }
            if (first)
              await Promise.race([
                barrier,
                new Promise<void>((resolve) =>
                  signal.addEventListener("abort", () => resolve(), { once: true }),
                ),
              ])
            yield { type: "done", stopReason: "end_turn" }
          } finally {
            active--
          }
        })()
      },
    }
    const session = await new CodesplashDriver({
      providers: { anthropic: provider },
      permissions: fakePermissions(),
    }).openSession({ cwd, localSessionId: "queued-native" })
    const { done } = collectEvents(session)
    try {
      const first = await session.submit?.({ text: "first" })
      await until(() => (requests.length === 1 ? true : undefined), "first provider request")
      const followup = await session.submit?.({ text: "follow-up" })
      expect(followup?.status).toBe("queued")
      expect(requests).toHaveLength(1)
      release()
      await until(
        () =>
          session.inputQueue
            ?.snapshot()
            .items.find((item) => item.id === followup?.id && item.status === "completed"),
        "follow-up completion",
      )
      expect(session.inputQueue?.snapshot().items.find((item) => item.id === first?.id)?.status).toBe(
        "completed",
      )
      expect(maximum).toBe(1)
      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests[1]?.messages)).toContain("first")
    } finally {
      release()
      await session.close()
      await done
    }
  })

  test("interject cancels an approval before starting its own turn", async () => {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY_VALUE
    const provider = fakeProvider("anthropic", [
      [
        {
          type: "tool_call",
          id: "write",
          name: "write_file",
          input: { path: "never-written.txt", content: "must not run" },
        },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "interjected" },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const factory: PermissionRuntimeFactory = async (options) => {
      const runtime = new FakePermissionRuntime(options)
      runtime.decide = (name?: string) =>
        name === "write_file" ? { kind: "ask", reason: "Fixture approval" } : { kind: "default" }
      return runtime
    }
    const session = await new CodesplashDriver({
      providers: { anthropic: provider },
      permissions: factory,
    }).openSession({ cwd, localSessionId: "interject-native" })
    const { events, done } = collectEvents(session)
    try {
      await session.send({ text: "first" })
      const request = await until(() => events.find((event) => event.kind === "request.opened"), "approval")
      const next = await session.submit?.({ text: "instead explain" }, "interject")
      await until(
        () =>
          session.inputQueue
            ?.snapshot()
            .items.find((item) => item.id === next?.id && item.status === "completed"),
        "interjection completion",
      )
      const resolved = events.find(
        (event) =>
          event.kind === "request.resolved" &&
          event.payload.id === (request.kind === "request.opened" ? request.payload.id : ""),
      )
      expect(resolved?.kind === "request.resolved" && resolved.payload.decision).toBe("cancel")
      expect(await Bun.file(join(cwd, "never-written.txt")).exists()).toBe(false)
      expect(provider.requests).toHaveLength(2)
    } finally {
      await session.close()
      await done
    }
  })

  test("a second send while a turn is in flight is refused to the caller, not the session", async () => {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY_VALUE
    const provider = fakeProvider("anthropic", [
      [
        { type: "text_delta", text: "first turn" },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const driver = new CodesplashDriver({
      providers: { anthropic: provider },
      permissions: fakePermissions(),
    })
    const session = await driver.openSession({ cwd, localSessionId: "local-double-send" })
    const { events, done } = collectEvents(session)

    // The guard must hold even before send()'s async prompt building finishes: fire the second
    // send without awaiting the first.
    const first = session.send({ text: "one" })
    await expect(session.send({ text: "two" })).rejects.toThrow("already running")
    await first
    await until(() => events.find((event) => event.kind === "turn.completed"), "turn.completed")

    // The refused send surfaces to the caller only: no error event, no dropped-message state.
    expect(events.filter((event) => event.kind === "error")).toHaveLength(0)
    const userMessages = events.filter((event) => event.kind === "user.message")
    expect(userMessages).toHaveLength(1)
    expect(userMessages[0]?.kind === "user.message" && userMessages[0].payload.text).toBe("one")
    expect(provider.requests).toHaveLength(1)

    await session.close()
    await done
  })

  test("close ends the event stream and further sends are refused", async () => {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY_VALUE
    const { session, done } = await openSession()
    await session.close()
    await done
    await expect(session.send({ text: "hi" })).rejects.toThrow("closed")
  })

  test("wires [codesplash].fallbackModel and the registry resolver into the loop", async () => {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY_VALUE
    process.env.OPENAI_API_KEY = OPENAI_KEY_VALUE
    // The primary provider fails with zero events; the loop must retry on the configured
    // fallback model, whose client comes from the session's provider map (test override here).
    const anthropicRequests: ProviderRequest[] = []
    const anthropic: ProviderClient = {
      id: "anthropic",
      models: [],
      stream(request) {
        anthropicRequests.push(request)
        return (async function* (): AsyncGenerator<ProviderStreamEvent> {
          yield* []
          throw new ProviderHttpError("scripted provider failure", 500)
        })()
      },
    }
    const openai = fakeProvider("openai", [
      [
        { type: "text_delta", text: "fallback reply" },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const config: AgentConfig = {
      ...structuredClone(defaultConfig),
      codesplash: { fallbackModel: "gpt-5.1" },
    }
    const driver = new CodesplashDriver({
      config,
      providers: { anthropic, openai },
      permissions: fakePermissions(),
    })
    const session = await driver.openSession({ cwd, localSessionId: "local-fallback-1" })
    const { events, done } = collectEvents(session)

    await session.send({ text: "hello" })
    await until(() => events.find((event) => event.kind === "turn.completed"), "turn.completed")

    const warning = events.find((event) => event.kind === "warning")
    expect(warning?.kind === "warning" && warning.payload.message).toBe(
      "Provider error on claude-fable-5; falling back to gpt-5.1",
    )
    expect(anthropicRequests).toHaveLength(1)
    expect(openai.requests).toHaveLength(1)
    expect(openai.requests[0]?.model.id).toBe("gpt-5.1")
    const completed = events.find((event) => event.kind === "message.completed")
    expect(completed?.kind === "message.completed" && completed.payload.text).toBe("fallback reply")
    const turn = events.find((event) => event.kind === "turn.completed")
    expect(turn?.kind === "turn.completed" && turn.payload.status).toBe("completed")

    await session.close()
    await done
  })
})

/* ---------------------------------- permission wiring ---------------------------------- */

describe("CodesplashDriver permissions", () => {
  let cwd: string

  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY_VALUE
    cwd = await mkdtemp(join(tmpdir(), "codesplash-engine-perm-"))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  function textTurn(text: string): ProviderStreamEvent[] {
    return [
      { type: "text_delta", text },
      { type: "done", stopReason: "end_turn" },
    ]
  }

  /** Retries until the previous turn's finalizers have released the turn reservation. */
  async function whenIdle<T>(run: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    while (true) {
      try {
        return await run()
      } catch (error) {
        if (Date.now() >= deadline) throw error
        await Bun.sleep(5)
      }
    }
  }

  test("builds the runtime from open options, config rules, overrides, and grants path", async () => {
    const capture: PermissionCapture = {}
    const config: AgentConfig = structuredClone(defaultConfig)
    config.permissions = { mode: "default", allow: ["bash(git status *)"], ask: [], deny: ["web_fetch"] }
    const driver = new CodesplashDriver({
      config,
      providers: { anthropic: fakeProvider("anthropic", []) },
      permissions: fakePermissions(capture),
    })
    const session = await driver.openSession({
      cwd,
      localSessionId: "perm-build-1",
      policy: { sandbox: "workspace-write", approvalPolicy: "on-request", permissionMode: "accept-edits" },
      workspaceTrusted: false,
      permissionOverrides: { allow: ["read_file(docs/**)"] },
      permissionGrantsPath: join(cwd, "grants.toml"),
    })
    const { events, done } = collectEvents(session)

    expect(capture.options?.cwd).toBe(cwd)
    expect(capture.options?.mode).toBe("accept-edits")
    expect(capture.options?.workspaceTrusted).toBe(false)
    expect(capture.options?.configRules).toBe(config.permissions)
    expect(capture.options?.overrides).toEqual({ allow: ["read_file(docs/**)"] })
    expect(capture.options?.grantsPath).toBe(join(cwd, "grants.toml"))

    const ready = await until(
      () => events.find((event) => event.kind === "session.status" && event.payload.status === "ready"),
      "ready status",
    )
    expect(ready.kind === "session.status" && ready.payload.permissionMode).toBe("accept-edits")
    await session.close()
    await done
  })

  test("absent policy and trust default to mode default and trusted true", async () => {
    const capture: PermissionCapture = {}
    const driver = new CodesplashDriver({
      providers: { anthropic: fakeProvider("anthropic", []) },
      permissions: fakePermissions(capture),
    })
    const session = await driver.openSession({ cwd, localSessionId: "perm-default-1" })
    const { events, done } = collectEvents(session)

    expect(capture.options?.mode).toBe("default")
    expect(capture.options?.workspaceTrusted).toBe(true)
    expect(capture.options?.overrides).toBeUndefined()
    expect(capture.options?.grantsPath).toBeUndefined()
    const ready = await until(
      () => events.find((event) => event.kind === "session.status" && event.payload.status === "ready"),
      "ready status",
    )
    expect(ready.kind === "session.status" && ready.payload.permissionMode).toBe("default")
    await session.close()
    await done
  })

  test("runtime-creation warnings surface as warning events before ready", async () => {
    const driver = new CodesplashDriver({
      providers: { anthropic: fakeProvider("anthropic", []) },
      permissions: fakePermissions({}, (options) => {
        options.onWarning?.('Unknown tool in permission rule "frobnicate(x)"; rule ignored')
      }),
    })
    const session = await driver.openSession({ cwd, localSessionId: "perm-warn-1" })
    const { events, done } = collectEvents(session)

    const warning = await until(() => events.find((event) => event.kind === "warning"), "creation warning")
    expect(warning.kind === "warning" && warning.payload.message).toContain("frobnicate")
    const readyIndex = events.findIndex(
      (event) => event.kind === "session.status" && event.payload.status === "ready",
    )
    expect(events.indexOf(warning)).toBeLessThan(readyIndex)
    await session.close()
    await done
  })

  test("setPermissionMode flips the runtime and announces the mode via session.status", async () => {
    const capture: PermissionCapture = {}
    const driver = new CodesplashDriver({
      providers: { anthropic: fakeProvider("anthropic", []) },
      permissions: fakePermissions(capture),
    })
    const session = await driver.openSession({ cwd, localSessionId: "perm-switch-1" })
    const { events, done } = collectEvents(session)

    await session.setPermissionMode?.("plan")
    expect(capture.runtime?.mode).toBe("plan")
    const announced = await until(
      () =>
        events.find((event) => event.kind === "session.status" && event.payload.permissionMode === "plan"),
      "mode change status",
    )
    expect(announced.kind === "session.status" && announced.payload.status).toBe("ready")
    await session.close()
    await done
  })

  test("setPermissionMode is refused while a turn is active", async () => {
    const provider = fakeProvider("anthropic", [textTurn("reply")])
    const driver = new CodesplashDriver({
      providers: { anthropic: provider },
      permissions: fakePermissions(),
    })
    const session = await driver.openSession({ cwd, localSessionId: "perm-midturn-1" })
    const { events, done } = collectEvents(session)

    const first = session.send({ text: "go" })
    await expect(session.setPermissionMode?.("plan")).rejects.toThrow(
      "Wait for the current turn before switching permission modes",
    )
    await first
    await until(() => events.find((event) => event.kind === "turn.completed"), "turn.completed")
    await session.close()
    await done
  })

  test("bypass cannot be entered unless the session was opened in bypass mode", async () => {
    const plain = new CodesplashDriver({
      providers: { anthropic: fakeProvider("anthropic", []) },
      permissions: fakePermissions(),
    })
    const plainSession = await plain.openSession({ cwd, localSessionId: "perm-bypass-1" })
    const plainEvents = collectEvents(plainSession)
    await expect(plainSession.setPermissionMode?.("bypass")).rejects.toThrow("--bypass-approvals")
    await plainSession.close()
    await plainEvents.done

    // Opened in bypass: leaving it and returning are both allowed.
    const capture: PermissionCapture = {}
    const bypass = new CodesplashDriver({
      providers: { anthropic: fakeProvider("anthropic", []) },
      permissions: fakePermissions(capture),
    })
    const bypassSession = await bypass.openSession({
      cwd,
      localSessionId: "perm-bypass-2",
      policy: { sandbox: "workspace-write", approvalPolicy: "on-request", permissionMode: "bypass" },
    })
    const bypassEvents = collectEvents(bypassSession)
    await bypassSession.setPermissionMode?.("default")
    expect(capture.runtime?.mode).toBe("default")
    await bypassSession.setPermissionMode?.("bypass")
    expect(capture.runtime?.mode).toBe("bypass")
    await bypassSession.close()
    await bypassEvents.done
  })

  test("the system prompt is rebuilt when the permission mode changes between turns", async () => {
    const provider = fakeProvider("anthropic", [textTurn("one"), textTurn("two"), textTurn("three")])
    const driver = new CodesplashDriver({
      providers: { anthropic: provider },
      permissions: fakePermissions(),
    })
    const session = await driver.openSession({ cwd, localSessionId: "perm-prompt-1" })
    const { events, done } = collectEvents(session)

    await session.send({ text: "first" })
    await until(() => events.find((event) => event.kind === "turn.completed"), "first turn")
    expect(provider.requests[0]?.system).not.toContain("## Plan mode")

    await whenIdle(() => session.setPermissionMode?.("plan") ?? Promise.resolve())
    await whenIdle(() => session.send({ text: "second" }))
    await until(
      () => (events.filter((event) => event.kind === "turn.completed").length >= 2 ? true : undefined),
      "second turn",
    )
    expect(provider.requests[1]?.system).toContain("## Plan mode")
    expect(provider.requests[1]?.system).toContain(".codesplash/plan.md")

    // Back to default: the cached plan prompt must not leak into later turns.
    await whenIdle(() => session.setPermissionMode?.("default") ?? Promise.resolve())
    await whenIdle(() => session.send({ text: "third" }))
    await until(
      () => (events.filter((event) => event.kind === "turn.completed").length >= 3 ? true : undefined),
      "third turn",
    )
    expect(provider.requests[2]?.system).not.toContain("## Plan mode")

    await session.close()
    await done
  })

  test("an untrusted workspace's system prompt skips project rules and says why", async () => {
    await Bun.write(join(cwd, "AGENTS.md"), "Ancient project wisdom.")
    const provider = fakeProvider("anthropic", [textTurn("reply")])
    const driver = new CodesplashDriver({
      providers: { anthropic: provider },
      permissions: fakePermissions(),
    })
    const session = await driver.openSession({
      cwd,
      localSessionId: "perm-untrusted-1",
      workspaceTrusted: false,
    })
    const { events, done } = collectEvents(session)

    await session.send({ text: "hello" })
    await until(() => events.find((event) => event.kind === "turn.completed"), "turn.completed")
    expect(provider.requests[0]?.system).not.toContain("Ancient project wisdom.")
    expect(provider.requests[0]?.system).toContain("untrusted")
    await session.close()
    await done
  })
})

/* ------------------------------ custom (BYOK) providers ------------------------------ */

function customConfig(...providers: CustomProviderConfig[]): AgentConfig {
  return { ...structuredClone(defaultConfig), providers }
}

function ollamaProvider(overrides: Partial<CustomProviderConfig> = {}): CustomProviderConfig {
  return {
    id: "ollama",
    protocol: "openai",
    baseUrl: "http://localhost:11434/v1",
    displayName: "Ollama",
    keyEnvVar: "OLLAMA_API_KEY",
    requiresKey: false,
    models: [
      {
        id: "qwen3:8b",
        displayName: "Qwen3 8B",
        contextWindow: 32_768,
        maxOutputTokens: 8_192,
        supportsReasoning: false,
        isDefault: true,
      },
    ],
    ...overrides,
  }
}

describe("CodesplashDriver custom providers", () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "codesplash-engine-custom-"))
    delete process.env.OLLAMA_API_KEY
  })

  afterEach(async () => {
    delete process.env.OLLAMA_API_KEY
    await rm(cwd, { recursive: true, force: true })
  })

  test("probe adds one detail fragment per configured custom provider, never key values", async () => {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY_VALUE
    process.env.OLLAMA_API_KEY = "unit-test-ollama-key-value"
    const config = customConfig(
      ollamaProvider(),
      ollamaProvider({
        id: "gateway",
        displayName: "Gateway",
        keyEnvVar: "GATEWAY_API_KEY",
        requiresKey: true,
        models: [
          {
            id: "gw-model",
            displayName: "gw-model",
            contextWindow: 128_000,
            maxOutputTokens: 16_384,
            supportsReasoning: false,
            isDefault: true,
          },
        ],
      }),
    )
    const probe = await new CodesplashDriver({ config }).probe()
    expect(probe.available).toBe(true)
    expect(probe.detail).toBe(
      "Anthropic API key (env) · Ollama (custom, key present) · Gateway (custom, key missing)",
    )
    expect(JSON.stringify(probe)).not.toContain("unit-test-ollama-key-value")
  })

  test("probe reports available on a keyless custom provider alone, and unavailable when its key is missing", async () => {
    const keyless = await new CodesplashDriver({ config: customConfig(ollamaProvider()) }).probe()
    expect(keyless.available).toBe(true)
    expect(keyless.detail).toBe("Ollama (custom, no key needed)")

    const keyed = await new CodesplashDriver({
      config: customConfig(ollamaProvider({ requiresKey: true })),
    }).probe()
    expect(keyed.available).toBe(false)
    expect(keyed.detail).toContain("No API keys found")
    expect(keyed.detail).toContain("Ollama (custom, key missing)")
  })

  test("a session on a custom provider routes turns through the runtime-id keyed provider map", async () => {
    const provider = fakeProvider("openai", [
      [
        { type: "text_delta", text: "local hello" },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const driver = new CodesplashDriver({
      config: customConfig(ollamaProvider()),
      providers: { ollama: provider },
      permissions: fakePermissions(),
    })
    const session = await driver.openSession({ cwd, localSessionId: "local-custom-1" })
    const { events, done } = collectEvents(session)

    const ready = await until(
      () => events.find((event) => event.kind === "session.status" && event.payload.status === "ready"),
      "ready status",
    )
    expect(ready.kind === "session.status" && ready.payload.model).toBe("qwen3:8b")

    const models = await session.listModels?.()
    expect(models).toEqual([
      {
        id: "qwen3:8b",
        displayName: "Qwen3 8B",
        description: "Ollama · 33k context",
        isDefault: true,
      },
    ])

    await session.send({ text: "hi" })
    await until(() => events.find((event) => event.kind === "turn.completed"), "turn.completed")
    expect(provider.requests).toHaveLength(1)
    expect(provider.requests[0]?.model.provider).toBe("ollama")
    expect(provider.requests[0]?.model.protocol).toBe("openai")

    await session.close()
    await done
  })

  test("setModel switches between built-in and custom models, with actionable unavailable errors", async () => {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY_VALUE
    const driver = new CodesplashDriver({
      config: customConfig(
        ollamaProvider(),
        ollamaProvider({
          id: "gateway",
          displayName: "Gateway",
          keyEnvVar: "GATEWAY_API_KEY",
          requiresKey: true,
          models: [
            {
              id: "gw-model",
              displayName: "gw-model",
              contextWindow: 128_000,
              maxOutputTokens: 16_384,
              supportsReasoning: false,
              isDefault: true,
            },
          ],
        }),
      ),
      providers: { anthropic: fakeProvider("anthropic", []), ollama: fakeProvider("openai", []) },
      permissions: fakePermissions(),
    })
    const session = await driver.openSession({ cwd, localSessionId: "local-custom-2" })
    const { events, done } = collectEvents(session)

    // The anthropic key is set, so the session default stays the built-in default model.
    const ready = await until(
      () => events.find((event) => event.kind === "session.status" && event.payload.status === "ready"),
      "ready status",
    )
    expect(ready.kind === "session.status" && ready.payload.model).toBe("claude-fable-5")

    // A custom model id containing ":" parses as an exact id, not an id:effort selector.
    await session.setModel?.("qwen3:8b")
    await until(
      () => events.find((event) => event.kind === "session.status" && event.payload.model === "qwen3:8b"),
      "custom model switch",
    )

    // An unavailable custom provider's model names the missing key env var, never its value.
    await expect(session.setModel?.("gw-model")).rejects.toThrow(
      "The Gateway provider needs GATEWAY_API_KEY set",
    )
    await expect(session.setModel?.("gpt-5.1")).rejects.toThrow("OPENAI_API_KEY")

    await session.close()
    await done
  })
})
