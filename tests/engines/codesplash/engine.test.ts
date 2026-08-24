import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent, EngineSession } from "../../../src/core/index.ts"
import type {
  ProviderClient,
  ProviderRequest,
  ProviderStreamEvent,
} from "../../../src/engines/codesplash/contracts.ts"
import { CodesplashDriver } from "../../../src/engines/codesplash/engine.ts"
import { APP_VERSION } from "../../../src/version.ts"

const ANTHROPIC_KEY_VALUE = "unit-test-anthropic-key-value"
const OPENAI_KEY_VALUE = "unit-test-openai-key-value"

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
  savedEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
})

afterEach(() => {
  restoreEnv("ANTHROPIC_API_KEY", savedEnv.ANTHROPIC_API_KEY)
  restoreEnv("OPENAI_API_KEY", savedEnv.OPENAI_API_KEY)
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

function collectEvents(session: EngineSession): { events: AgentEvent[]; done: Promise<void> } {
  const events: AgentEvent[] = []
  const done = (async () => {
    for await (const event of session.events) events.push(event)
  })()
  return { events, done }
}

async function until<T>(get: () => T | undefined, label: string, timeoutMs = 2_000): Promise<T> {
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

  test("reports the providers found without echoing key values", async () => {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY_VALUE
    const probe = await new CodesplashDriver().probe()
    expect(probe.available).toBe(true)
    expect(probe.authenticated).toBe(true)
    expect(probe.version).toBe(APP_VERSION)
    expect(probe.detail).toBe("Anthropic API key")
    expect(JSON.stringify(probe)).not.toContain(ANTHROPIC_KEY_VALUE)
  })

  test("names both providers when both keys are present", async () => {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY_VALUE
    process.env.OPENAI_API_KEY = OPENAI_KEY_VALUE
    const probe = await new CodesplashDriver().probe()
    expect(probe.detail).toBe("Anthropic API key · OpenAI API key")
    const serialized = JSON.stringify(probe)
    expect(serialized).not.toContain(ANTHROPIC_KEY_VALUE)
    expect(serialized).not.toContain(OPENAI_KEY_VALUE)
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
      resume: false,
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

  test("send drives a full text turn through the loop with monotonic sequences", async () => {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY_VALUE
    const provider = fakeProvider("anthropic", [
      [
        { type: "text_delta", text: "Hi " },
        { type: "text_delta", text: "there" },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const driver = new CodesplashDriver({ providers: { anthropic: provider } })
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

  test("a second send while a turn is in flight is refused to the caller, not the session", async () => {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY_VALUE
    const provider = fakeProvider("anthropic", [
      [
        { type: "text_delta", text: "first turn" },
        { type: "done", stopReason: "end_turn" },
      ],
    ])
    const driver = new CodesplashDriver({ providers: { anthropic: provider } })
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
})
