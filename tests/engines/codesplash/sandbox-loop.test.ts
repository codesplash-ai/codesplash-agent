import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "../../../src/core/events.ts"
import type {
  HarnessTool,
  ModelInfo,
  ProviderClient,
  ProviderStreamEvent,
  ToolContext,
} from "../../../src/engines/codesplash/contracts.ts"
import { Guardian } from "../../../src/engines/codesplash/guardian.ts"
import { CodesplashEventFactory, CodesplashLoop } from "../../../src/engines/codesplash/loop.ts"
import { createPermissionRuntime } from "../../../src/engines/codesplash/permissions.ts"
import { createProfile } from "../../../src/engines/codesplash/sandbox/profile.ts"
import { NativeSandbox } from "../../../src/engines/codesplash/sandbox/runtime.ts"
import { createToolRegistry } from "../../../src/engines/codesplash/tools/registry.ts"
import { requestPermissionsTool } from "../../../src/engines/codesplash/tools/request-permissions.ts"
import { appendTranscriptMessages } from "../../../src/engines/codesplash/transcript.ts"

const model: ModelInfo = {
  id: "fixture",
  displayName: "Fixture",
  provider: "anthropic",
  protocol: "anthropic",
  contextWindow: 200000,
  maxOutputTokens: 1000,
  isDefault: true,
  supportsReasoning: false,
  pricing: { inputPerMTok: 1, outputPerMTok: 1 },
}
function provider(rounds: ProviderStreamEvent[][]): ProviderClient {
  return {
    id: "anthropic",
    models: [model],
    async *stream() {
      for (const event of rounds.shift() ?? [{ type: "done", stopReason: "end_turn" }]) yield event
    },
  }
}
function action(name: string, input: unknown): ProviderStreamEvent[] {
  return [
    { type: "tool_call", id: crypto.randomUUID(), name, input },
    { type: "done", stopReason: "tool_use" },
  ]
}
function review(text: string): ProviderStreamEvent[] {
  return [
    { type: "text_delta", text },
    { type: "usage", usage: { inputTokens: 12, outputTokens: 8 } },
    { type: "done", stopReason: "end_turn" },
  ]
}
class RecordingSandbox extends NativeSandbox {
  calls: unknown[] = []
  override async runTool(_tool: HarnessTool, input: unknown, _context: ToolContext) {
    this.calls.push(input)
    return { text: "fixture executed", label: "fixture" }
  }
}
const shell: HarnessTool = {
  name: "bash",
  description: "fixture",
  inputSchema: { type: "object" },
  isReadOnly: () => false,
  permission: () => ({ kind: "approval", title: "Run?", detail: "fixture" }),
  permissionTargets: (input) => ({ command: (input as { command: string }).command }),
  async run() {
    throw new Error("must use sandbox")
  },
}

async function fixture(rules: { ask?: string[]; deny?: string[] } = {}, guardian = false, answer = "accept") {
  const cwd = await mkdtemp(join(tmpdir(), "codesplash-loop-sandbox-"))
  const sandbox = new RecordingSandbox(createProfile(cwd, "workspace-write"))
  const permissions = await createPermissionRuntime({
    cwd,
    workspaceTrusted: false,
    mode: "default",
    configRules: { allow: [], ask: rules.ask ?? [], deny: rules.deny ?? [] },
  })
  const events: AgentEvent[] = []
  const reviewer = provider([review('{"action":"allow","reason":"routine"}')])
  const loop = new CodesplashLoop({
    cwd,
    policy: { sandbox: "workspace-write", approvalPolicy: "on-request" },
    registry: createToolRegistry([shell, requestPermissionsTool]),
    permissions,
    sandbox,
    guardian: { enabled: guardian, model: "reviewer" },
    resolveModel: () => ({ provider: reviewer, model }),
    events: new CodesplashEventFactory("fixture", 0),
    collectDiff: async () => "",
    emit(event) {
      events.push(event)
      if (event.kind === "request.opened") queueMicrotask(() => loop.resolveRequest(event.payload.id, answer))
    },
  })
  async function turn(rounds: ProviderStreamEvent[][]) {
    await loop.runTurn({
      provider: provider(rounds),
      model,
      system: "fixture",
      userText: "perform fixture action",
      userContent: [{ type: "text", text: "perform fixture action" }],
    })
  }
  return {
    cwd,
    sandbox,
    loop,
    events,
    turn,
    async close() {
      await sandbox.close()
      await rm(cwd, { recursive: true, force: true })
    },
  }
}

test("guardian cannot waive an explicit ask, deny, or dangerous floor", async () => {
  for (const scenario of [
    { rules: { ask: ["bash"] }, command: "echo safe", prompts: 1 },
    { rules: { deny: ["bash"] }, command: "echo safe", prompts: 0 },
    { rules: {}, command: "rm -rf /tmp/example", prompts: 1 },
  ]) {
    const f = await fixture(scenario.rules, true, "decline")
    try {
      await f.turn([action("bash", { command: scenario.command })])
      expect(f.sandbox.calls).toHaveLength(0)
      expect(f.events.filter((e) => e.kind === "request.opened")).toHaveLength(scenario.prompts)
      expect(f.events.filter((e) => e.kind === "usage.updated")).toHaveLength(0)
    } finally {
      await f.close()
    }
  }
})
test("guardian may approve a default prompt and its usage is accounted", async () => {
  const f = await fixture({}, true)
  try {
    await f.turn([action("bash", { command: "echo safe" })])
    expect(f.sandbox.calls).toHaveLength(1)
    expect(f.events.filter((e) => e.kind === "request.opened")).toHaveLength(0)
    expect(f.events.some((e) => e.kind === "usage.updated")).toBe(true)
  } finally {
    await f.close()
  }
})
test("escalation always requires explicit approval and never runs or retries a tool", async () => {
  const f = await fixture({}, true, "decline")
  try {
    await f.turn([
      action("request_permissions", {
        resource: "network",
        target: "example.com:443",
        scope: "turn",
        reason: "fixture",
      }),
    ])
    expect(f.sandbox.calls).toHaveLength(0)
    const request = f.events.find((e) => e.kind === "request.opened")
    expect(request?.payload).toMatchObject({ alwaysAsk: true, choices: ["accept", "decline", "cancel"] })
    expect(() => f.sandbox.checkNetwork("https://example.com")).toThrow("network denied")
  } finally {
    await f.close()
  }
})
test("approved turn access expires; session access survives only until close", async () => {
  const f = await fixture()
  try {
    for (const scope of ["turn", "session"]) {
      await f.turn([
        action("request_permissions", {
          resource: "network",
          target: "example.com:443",
          scope,
          reason: "fixture",
        }),
      ])
      if (scope === "turn") expect(() => f.sandbox.checkNetwork("https://example.com")).toThrow()
      else expect(() => f.sandbox.checkNetwork("https://example.com")).not.toThrow()
    }
    await f.sandbox.close()
    expect(() => f.sandbox.checkNetwork("https://example.com")).toThrow()
  } finally {
    await f.close()
  }
})
test("explicit resource deny prevents escalation without prompting", async () => {
  const f = await fixture({ deny: ["web_fetch(example.com)"] })
  try {
    await f.turn([
      action("request_permissions", {
        resource: "network",
        target: "example.com:443",
        scope: "session",
        reason: "fixture",
      }),
    ])
    expect(f.events.filter((e) => e.kind === "request.opened")).toHaveLength(0)
    expect(() => f.sandbox.checkNetwork("https://example.com")).toThrow()
  } finally {
    await f.close()
  }
})
test("named-secret binding cannot be approved by guardian and shows names and full command", async () => {
  const f = await fixture({}, true, "decline")
  const command = `echo ${"x".repeat(150)}; echo end`
  try {
    await f.turn([action("bash", { command, secrets: ["DEPLOY_TOKEN"] })])
    expect(f.sandbox.calls).toHaveLength(0)
    const request = f.events.find((e) => e.kind === "request.opened")
    expect(request?.payload).toMatchObject({ alwaysAsk: true })
    expect(JSON.stringify(request)).toContain("DEPLOY_TOKEN")
    expect(JSON.stringify(request)).toContain(command)
  } finally {
    await f.close()
  }
})

test("guardian rejects malformed/tool-using responses, enforces review/cost limits, and resets per turn", async () => {
  const signal = new AbortController().signal
  for (const response of [
    review("not JSON"),
    action("bash", {}),
    review('{"action":"allow","reason":"ok","extra":true}'),
  ]) {
    expect(
      (await new Guardian({ enabled: true }).review(provider([response]), model, "fixture", signal)).action,
    ).toBe("review")
  }
  const limited = new Guardian({ enabled: true, maxReviews: 1 })
  expect(
    (await limited.review(provider([review('{"action":"allow","reason":"ok"}')]), model, "fixture", signal))
      .action,
  ).toBe("allow")
  expect((await limited.review(provider([]), model, "fixture", signal)).reason).toContain("limit")
  limited.endTurn()
  expect(
    (await limited.review(provider([review('{"action":"allow","reason":"ok"}')]), model, "fixture", signal))
      .action,
  ).toBe("allow")
  expect(
    (
      await new Guardian({ enabled: true, maxCostUsd: 0.0000001 }).review(
        provider([]),
        model,
        "fixture",
        signal,
      )
    ).reason,
  ).toContain("cost cap")
})
test("guardian timeout and cancellation remain unapproved even for a provider ignoring abort", async () => {
  const client: ProviderClient = {
    id: "anthropic",
    models: [model],
    async *stream() {
      await new Promise(() => {})
      yield { type: "done", stopReason: "end_turn" }
    },
  }
  const guardian = new Guardian({ enabled: true, timeoutMs: 20 })
  expect((await guardian.review(client, model, "fixture", new AbortController().signal)).action).toBe(
    "review",
  )
  const abort = new AbortController()
  const pending = guardian.review(client, model, "fixture", abort.signal)
  abort.abort()
  expect((await pending).action).toBe("review")
})

test("secret canaries never enter tool events, provider history, errors, or native transcripts", async () => {
  const canary = `M3_CANARY_${crypto.randomUUID()}`
  const previous = process.env.M3_CANARY_TOKEN
  process.env.M3_CANARY_TOKEN = canary
  const f = await fixture()
  try {
    let calls = 0
    f.sandbox.runTool = async () => {
      if (calls++) throw new Error(`tool error ${canary}`)
      return { text: `tool output ${canary}`, label: `label ${canary}` }
    }
    await f.turn([action("bash", { command: "echo first" })])
    await f.turn([action("bash", { command: "echo second" })])
    const history = f.loop.historySnapshot()
    for (const sink of [JSON.stringify(f.events), JSON.stringify(history)]) {
      expect(sink).not.toContain(canary)
      expect(sink).toContain("[REDACTED]")
    }
    const path = join(f.cwd, "transcript.jsonl")
    await appendTranscriptMessages(path, history)
    expect(await readFile(path, "utf8")).not.toContain(canary)
  } finally {
    if (previous === undefined) delete process.env.M3_CANARY_TOKEN
    else process.env.M3_CANARY_TOKEN = previous
    await f.close()
  }
})
