import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validateConfig } from "../../../src/core/config.ts"
import type { AgentEvent } from "../../../src/core/events.ts"
import type { HookEvent } from "../../../src/core/hooks.ts"
import { validNativeContext } from "../../../src/core/session/branches.ts"
import { MemorySessionState } from "../../../src/core/session/control.ts"
import type {
  HarnessTool,
  ModelInfo,
  ProviderClient,
  ToolCallBlock,
} from "../../../src/engines/codesplash/contracts.ts"
import { HookContinuationBudget } from "../../../src/engines/codesplash/hooks/continuation.ts"
import { HookManager } from "../../../src/engines/codesplash/hooks/manager.ts"
import { reviewHook, trustHook } from "../../../src/engines/codesplash/hooks/trust.ts"
import { CodesplashEventFactory, CodesplashLoop } from "../../../src/engines/codesplash/loop.ts"
import { createPermissionRuntime } from "../../../src/engines/codesplash/permissions.ts"
import type { SandboxRuntime } from "../../../src/engines/codesplash/sandbox/contracts.ts"
import { createProfile } from "../../../src/engines/codesplash/sandbox/profile.ts"
import { NativeSandbox } from "../../../src/engines/codesplash/sandbox/runtime.ts"
import { ToolOutputStore } from "../../../src/engines/codesplash/tool-output-store.ts"
import { createToolRegistry } from "../../../src/engines/codesplash/tools/registry.ts"

const event = (name: HookEvent["name"] = "tool.before"): HookEvent => ({
  version: 1,
  id: crypto.randomUUID(),
  name,
  sessionId: "session",
  turnId: "turn",
  generation: "source",
  metadata: { toolName: "fixture", toolSource: "builtin" },
  fields: { input: { path: "before", password: "never-share-me" }, text: "PRIVATE" },
})
async function fixture(
  handlers: Record<string, Record<string, unknown>>,
  execute?: SandboxRuntime["executeFixed"],
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hooks-manager-")))
  let config = validateConfig(
    {
      hooks: {
        handlers: Object.fromEntries(
          Object.entries(handlers).map(([id, handler]) => [
            id,
            { kind: "command", command: "/bin/cat", enabled: true, events: ["tool.before"], ...handler },
          ]),
        ),
      },
    },
    "fixture",
  )
  const sandbox = new NativeSandbox(createProfile(root, "workspace-write"))
  if (execute) sandbox.executeFixed = execute
  const diagnostics: string[] = [],
    state = new MemorySessionState()
  const manager = new HookManager({
    cwd: root,
    dataDir: root,
    config,
    resolveConfig: async () => config,
    mode: () => "default",
    sandbox,
    state,
    outputs: new ToolOutputStore(),
    diagnostic: (text) => diagnostics.push(text),
  })
  const trust = async () => {
    for (const id of Object.keys(config.hooks?.handlers ?? {})) {
      const review = await reviewHook(config, id, root)
      trustHook(root, review, review.fingerprint)
    }
  }
  return {
    root,
    manager,
    state,
    diagnostics,
    trust,
    get config() {
      return config
    },
    set config(value) {
      config = value
    },
    close: async () => {
      await manager.close()
      await sandbox.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}
const success = (output: unknown) => ({
  kind: "success" as const,
  exitCode: 0,
  stdout: JSON.stringify(output),
  stderr: "",
})

test("continuation deadlines and excess reported usage cannot reset reserved budgets", () => {
  let now = 1000
  const budget = new HookContinuationBudget({ maxCount: 8, maxDurationMs: 100, maxTokens: 100 }, () => now)
  expect(budget.continue()).toBe(true)
  expect(budget.reserve(40)).toBe(true)
  budget.chargeExcess(40, 90)
  expect(budget.reserve(11)).toBe(false)
  now = 1100
  expect(budget.continue()).toBe(false)
  expect(budget.reserve(1)).toBe(false)
})

test("compaction hook instructions preserve tool pairs and valid publication; denied compaction reports failure", async () => {
  let deny = false
  const seen: string[] = []
  const f = await fixture(
    { compaction: { events: ["compaction.before", "compaction.after", "compaction.error"] } },
    async (_argv, input) => {
      const event = JSON.parse(input) as HookEvent
      seen.push(event.name)
      return success(
        event.name === "compaction.before"
          ? deny
            ? { version: 1, decision: "deny" }
            : { version: 1, instructions: "PRESERVE_OBJECTIVE" }
          : {
              version: 1,
              context: event.name === "compaction.after" ? "AFTER_SUMMARY" : "COMPACTION_REFUSED",
            },
      )
    },
  )
  try {
    await f.trust()
    const tool: HarnessTool = {
      name: "fixture",
      description: "fixture",
      inputSchema: { type: "object" },
      isReadOnly: () => true,
      permission: () => ({ kind: "none" }),
      run: async () => ({ text: "", label: "" }),
    }
    const { loop } = await runLoop(f, tool, [])
    loop.seedHistory([
      { role: "user", content: [{ type: "text", text: "Original objective" }] },
      { role: "assistant", content: [{ type: "tool_call", id: "old", name: "fixture", input: {} }] },
      {
        role: "user",
        content: [{ type: "tool_result", toolCallId: "old", text: "reference ".repeat(1200) }],
      },
      { role: "assistant", content: [{ type: "text", text: "Earlier work finished" }] },
      { role: "user", content: [{ type: "text", text: "Continue current work" }] },
    ])
    const provider: ProviderClient = {
      id: "anthropic",
      models: [model],
      async *stream(request) {
        expect(request.system).toContain("PRESERVE_OBJECTIVE")
        yield { type: "text_delta", text: "Retained objective and evidence." }
        yield { type: "done", stopReason: "end_turn" }
      },
    }
    const request = {
      model: { ...model, contextWindow: 8000, maxOutputTokens: 256 },
      provider,
      system: "fixture",
      userText: "",
      userContent: [],
    }
    await loop.compact(request)
    expect(seen).toEqual(["compaction.before", "compaction.after"])
    expect(validNativeContext(loop.historySnapshot())).toBe(true)
    expect(JSON.stringify(loop.historySnapshot())).toContain("AFTER_SUMMARY")
    deny = true
    await expect(loop.compact(request)).rejects.toThrow("denied")
    expect(seen.slice(-2)).toEqual(["compaction.before", "compaction.error"])
    expect(validNativeContext(loop.historySnapshot())).toBe(true)
    expect(JSON.stringify(loop.historySnapshot())).toContain("COMPACTION_REFUSED")
  } finally {
    await f.close()
  }
})

const model: ModelInfo = {
  id: "fixture",
  displayName: "fixture",
  provider: "anthropic",
  protocol: "anthropic",
  isDefault: true,
  contextWindow: 200000,
  maxOutputTokens: 4096,
  supportsReasoning: false,
}
async function runLoop(
  f: Awaited<ReturnType<typeof fixture>>,
  tool: HarnessTool,
  calls: ToolCallBlock[],
  deny: string[] = [],
  ask: string[] = [],
  foreground = () => false,
) {
  const events: AgentEvent[] = [],
    registry = createToolRegistry([tool])
  const permissions = await createPermissionRuntime({
    cwd: f.root,
    mode: "default",
    workspaceTrusted: false,
    configRules: { allow: [], ask, deny },
    grantsPath: join(f.root, "permissions.json"),
  })
  let requests = 0,
    checkpoints = 0
  const loop = new CodesplashLoop({
    cwd: f.root,
    policy: { sandbox: "workspace-write", permissionMode: "default", approvalPolicy: "on-request" },
    registry,
    hooks: f.manager,
    permissions,
    events: new CodesplashEventFactory("session"),
    beforeMutation: async () => {
      checkpoints++
      return "checkpoint"
    },
    emit: (event) => {
      events.push(event)
      if (event.kind === "request.opened")
        queueMicrotask(() => loop.resolveRequest(event.payload.id, "decline"))
    },
  })
  const provider: ProviderClient = {
    id: "anthropic",
    models: [model],
    async *stream() {
      requests++
      if (requests === 1 && calls.length) {
        for (const call of calls) yield call
        yield { type: "done", stopReason: "tool_use" }
      } else {
        yield { type: "text_delta", text: "finished" }
        yield { type: "done", stopReason: "end_turn" }
      }
    },
  }
  await loop.runTurn({
    hasForegroundInput: foreground,
    provider,
    model,
    system: "fixture",
    userText: "run",
    userContent: [{ type: "text", text: "run" }],
  })
  return { loop, events, requests, checkpoints }
}

test("hook default approval cannot bypass an explicit ask or the dangerous floor", async () => {
  let effects = 0
  const f = await fixture(
    { permission: { events: ["permission.request"], allowDefaultApproval: true } },
    async () => success({ version: 1, decision: "allow" }),
  )
  const tool: HarnessTool = {
    name: "fixture",
    permissionName: "todo_write",
    description: "fixture",
    inputSchema: { type: "object" },
    isReadOnly: () => false,
    permission: () => ({ kind: "approval", title: "Approve fixture", detail: "fixture" }),
    run: async () => {
      effects++
      return { text: "effect", label: "fixture" }
    },
  }
  const call: ToolCallBlock = { type: "tool_call", id: "fixture", name: "fixture", input: {} }
  try {
    await f.trust()
    expect(
      (await runLoop(f, tool, [call])).events.filter((event) => event.kind === "request.opened"),
    ).toHaveLength(0)
    expect(effects).toBe(1)
    expect(
      (await runLoop(f, tool, [call], [], ["todo_write"])).events.filter(
        (event) => event.kind === "request.opened",
      ),
    ).toHaveLength(1)
    const floor = await runLoop(
      f,
      { ...tool, permissionName: "bash", permissionTargets: () => ({ command: "rm -rf /" }) },
      [call],
    )
    expect(floor.events.some((event) => event.kind === "request.opened" && event.payload.alwaysAsk)).toBe(
      true,
    )
    expect(effects).toBe(1)
  } finally {
    await f.close()
  }
})

test("queued foreground work and token ceilings prevent stop hooks from initiating provider requests", async () => {
  let stops = 0
  const f = await fixture({ stop: { events: ["turn.stop"], allowContinuation: true } }, async () => {
    stops++
    return success({ version: 1, continuation: "Continue" })
  })
  const tool: HarnessTool = {
    name: "fixture",
    description: "fixture",
    inputSchema: { type: "object" },
    isReadOnly: () => true,
    permission: () => ({ kind: "none" }),
    run: async () => ({ text: "", label: "" }),
  }
  try {
    await f.trust()
    expect((await runLoop(f, tool, [], [], [], () => true)).requests).toBe(1)
    expect(stops).toBe(0)
    const config = structuredClone(f.config)
    if (!config.hooks) throw new Error("missing fixture")
    config.hooks.continuation.maxTokens = 10
    f.config = config
    await f.trust()
    await f.manager.reload()
    expect((await runLoop(f, tool, [])).requests).toBe(1)
    expect(stops).toBe(1)
  } finally {
    await f.close()
  }
})

test("reload evaluates newly reviewed config gates and rolls back failed activation", async () => {
  let calls = 0,
    deny = false
  const f = await fixture({ gate: { events: ["config.before"] } }, async () => {
    calls++
    return success(deny ? { version: 1, decision: "deny" } : { version: 1 })
  })
  try {
    await f.trust()
    await f.manager.reload(() =>
      f.manager.dispatch(event("config.before"), new AbortController().signal).then(() => {}),
    )
    expect(calls).toBe(1)
    const config = structuredClone(f.config)
    if (!config.hooks) throw new Error("missing fixture")
    config.hooks.continuation.maxCount = 1
    f.config = config
    await f.trust()
    deny = true
    await expect(
      f.manager.reload(() =>
        f.manager.dispatch(event("config.before"), new AbortController().signal).then(() => {}),
      ),
    ).rejects.toThrow("denied")
    await expect(f.manager.dispatch(event("config.before"), new AbortController().signal)).rejects.toThrow(
      "configuration or policy changed",
    )
    deny = false
    await f.manager.reload(() =>
      f.manager.dispatch(event("config.before"), new AbortController().signal).then(() => {}),
    )
    expect(calls).toBe(3)
  } finally {
    await f.close()
  }
})

test("loop rewrites precede classification and policy; post-hook failure preserves the actual result", async () => {
  const trace: string[] = []
  const f = await fixture(
    { gate: { allowInputRewrite: true, share: ["input"] }, post: { events: ["tool.after"] } },
    async (_argv, input) => {
      const event = JSON.parse(input) as HookEvent
      trace.push(event.name)
      return success(
        event.name === "tool.before"
          ? { version: 1, input: { write: true } }
          : { version: 1, result: "UNREVIEWED REPLACEMENT" },
      )
    },
  )
  let effects = 0
  const tool: HarnessTool = {
    name: "fixture",
    permissionName: "todo_write",
    description: "fixture",
    inputSchema: {
      type: "object",
      properties: { write: { type: "boolean" } },
      required: ["write"],
      additionalProperties: false,
    },
    isReadOnly: (input) => !(input as { write: boolean }).write,
    permission: () => ({ kind: "none" }),
    run: async () => {
      effects++
      trace.push("effect")
      return { text: "ACTUAL RESULT", label: "fixture" }
    },
  }
  try {
    await f.trust()
    const denied = await runLoop(
      f,
      tool,
      [{ type: "tool_call", id: "denied", name: "fixture", input: { write: false } }],
      ["todo_write"],
    )
    expect(effects).toBe(0)
    expect(denied.checkpoints).toBe(0)
    trace.length = 0
    const result = await runLoop(
      f,
      tool,
      ["first", "second"].map((id) => ({ type: "tool_call", id, name: "fixture", input: { write: false } })),
    )
    expect(effects).toBe(2)
    expect(result.checkpoints).toBe(2)
    expect(trace).toEqual(["tool.before", "effect", "tool.after", "tool.before", "effect", "tool.after"])
    expect(JSON.stringify(result.loop.historySnapshot())).toContain("ACTUAL RESULT")
    expect(JSON.stringify(result.loop.historySnapshot())).not.toContain("UNREVIEWED REPLACEMENT")
    expect(f.diagnostics.some((text) => text.includes("rewrite is not permitted"))).toBe(true)
    expect(
      result.events.filter(
        (event) => event.kind === "item.updated" && event.payload.output === "ACTUAL RESULT",
      ),
    ).toHaveLength(2)
  } finally {
    await f.close()
  }
})

test("loop hook ask reaches the user and unknown input never reaches a hook", async () => {
  let calls = 0,
    effects = 0
  const f = await fixture({ gate: {} }, async () => {
    calls++
    return success({ version: 1, decision: "ask" })
  })
  const tool: HarnessTool = {
    name: "fixture",
    description: "fixture",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => true,
    permission: () => ({ kind: "none" }),
    run: async () => {
      effects++
      return { text: "effect", label: "fixture" }
    },
  }
  try {
    await f.trust()
    const result = await runLoop(f, tool, [
      { type: "tool_call", id: "bad", name: "fixture", input: { unexpected: true } },
      { type: "tool_call", id: "ask", name: "fixture", input: {} },
    ])
    expect(calls).toBe(1)
    expect(effects).toBe(0)
    expect(result.events.filter((event) => event.kind === "request.opened")).toHaveLength(1)
  } finally {
    await f.close()
  }
})

test("live lifecycle hooks exclude seeded history and stop at the shared continuation count", async () => {
  const seen: string[] = []
  const f = await fixture(
    {
      observer: { events: ["input.admit", "turn.start", "turn.end"] },
      stop: { events: ["turn.stop"], allowContinuation: true },
    },
    async (_argv, input) => {
      const event = JSON.parse(input) as HookEvent
      seen.push(event.name)
      return success(
        event.name === "turn.stop" ? { version: 1, continuation: "Continue fixture" } : { version: 1 },
      )
    },
  )
  try {
    const config = structuredClone(f.config)
    if (!config.hooks) throw new Error("missing fixture")
    config.hooks.continuation = { maxCount: 2, maxDurationMs: 120000, maxTokens: 100000 }
    f.config = config
    await f.trust()
    await f.manager.reload()
    const tool: HarnessTool = {
      name: "fixture",
      description: "fixture",
      inputSchema: { type: "object" },
      isReadOnly: () => true,
      permission: () => ({ kind: "none" }),
      run: async () => ({ text: "", label: "fixture" }),
    }
    const result = await runLoop(f, tool, [])
    expect(result.requests).toBe(3)
    expect(seen).toEqual(["input.admit", "turn.start", "turn.stop", "turn.stop", "turn.end"])
    seen.length = 0
    result.loop.seedHistory([{ role: "user", content: [{ type: "text", text: "old input" }] }])
    expect(seen).toEqual([])
  } finally {
    await f.close()
  }
})

test("hook trust precedes effects; serial rewrites are validated and sharing is explicit", async () => {
  const inputs: HookEvent[] = []
  const f = await fixture(
    { first: { allowInputRewrite: true, share: ["input"] }, second: { share: ["input"] } },
    async (_argv, input) => {
      inputs.push(JSON.parse(input))
      return success(inputs.length === 1 ? { version: 1, input: { path: "after" } } : { version: 1 })
    },
  )
  try {
    await expect(f.manager.dispatch(event(), new AbortController().signal)).rejects.toThrow(
      "fingerprint trust",
    )
    expect(inputs).toHaveLength(0)
    await f.trust()
    const validated: unknown[] = []
    const result = await f.manager.dispatch(event(), new AbortController().signal, (value) => {
      validated.push(value)
    })
    expect(validated).toEqual([{ path: "after" }])
    expect(inputs[0]?.fields).toEqual({ input: { path: "before", password: "[REDACTED]" } })
    expect(inputs[1]?.fields).toEqual({ input: { path: "after" } })
    expect(result.fields.input).toEqual({ path: "after" })
    expect(f.manager.receipts.list().every((receipt) => receipt.status === "completed")).toBe(true)
  } finally {
    await f.close()
  }
})

test("a once denial remains a denial; invalid rewrites remain uncertain and cannot be replayed", async () => {
  let calls = 0
  const f = await fixture({ gate: { once: "session" } }, async () => {
    calls++
    return success({ version: 1, decision: "deny", reason: "refused" })
  })
  try {
    await f.trust()
    await expect(f.manager.dispatch(event(), new AbortController().signal)).rejects.toThrow("refused")
    await expect(f.manager.dispatch(event(), new AbortController().signal)).rejects.toThrow(
      "previously denied",
    )
    expect(calls).toBe(1)
    expect(f.manager.receipts.list()[0]?.status).toBe("denied")
  } finally {
    await f.close()
  }
  const invalid = await fixture({ gate: { once: "turn", allowInputRewrite: true } }, async () =>
    success({ version: 1, input: { unexpected: true } }),
  )
  try {
    await invalid.trust()
    await expect(
      invalid.manager.dispatch(event(), new AbortController().signal, () => {
        throw new Error("invalid schema")
      }),
    ).rejects.toThrow("invalid schema")
    await expect(invalid.manager.dispatch(event(), new AbortController().signal)).rejects.toThrow("uncertain")
    expect(invalid.manager.receipts.list()[0]?.status).toBe("uncertain")
  } finally {
    await invalid.close()
  }
})

test("owned async observers are capped and close settles cancellation without late changes", async () => {
  let active = 0,
    cancelled = 0
  let notify: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    notify = resolve
  })
  const f = await fixture(
    { observer: { events: ["tool.after"], async: true } },
    async (_argv, _input, signal) => {
      active++
      if (active === 4) notify?.()
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener("abort", () => resolve(), { once: true })
      })
      cancelled++
      return success({ version: 1, diagnostic: "LATE" })
    },
  )
  try {
    await f.trust()
    for (let i = 0; i < 4; i++) await f.manager.dispatch(event("tool.after"), new AbortController().signal)
    await started
    await f.manager.dispatch(event("tool.after"), new AbortController().signal)
    expect(f.diagnostics.some((text) => text.includes("limit reached"))).toBe(true)
    await f.manager.close()
    expect(cancelled).toBe(4)
    expect(f.manager.receipts.list().every((receipt) => receipt.status === "uncertain")).toBe(true)
    expect(f.diagnostics.some((text) => text.includes("LATE"))).toBe(false)
  } finally {
    await f.close()
  }
})

test("a post-hook deadline during retention cannot publish its staged rewrite", async () => {
  const f = await fixture(
    { post: { events: ["tool.after"], timeoutMs: 100, allowResultRewrite: true } },
    async () => success({ version: 1, result: "DO_NOT_PUBLISH", context: "retained context" }),
  )
  try {
    await f.trust()
    f.manager.options.outputs.retain = async (text) => {
      await Bun.sleep(150)
      return text
    }
    const input = event("tool.after")
    input.fields.result = "ORIGINAL"
    const result = await f.manager.dispatch(input, new AbortController().signal)
    expect(result.fields.result).toBe("ORIGINAL")
    expect(result.context).toEqual([])
    expect(f.manager.receipts.list()[0]?.status).toBe("uncertain")
  } finally {
    await f.close()
  }
})

test("fresh policy and source changes refuse gates; disabled and hidden handlers create no receipts", async () => {
  let calls = 0
  const f = await fixture({ gate: { enabled: false } }, async () => {
    calls++
    return success({ version: 1 })
  })
  try {
    await f.manager.dispatch(event(), new AbortController().signal)
    expect(f.manager.receipts.list()).toEqual([])
    const changed = structuredClone(f.config)
    const gate = changed.hooks?.handlers.gate
    if (!gate) throw new Error("missing fixture")
    gate.enabled = true
    f.config = changed
    await expect(f.manager.dispatch(event(), new AbortController().signal)).rejects.toThrow(
      "configuration or policy changed",
    )
    await f.trust()
    await f.manager.reload()
    const hidden = event()
    hidden.metadata.hidden = true
    await f.manager.dispatch(hidden, new AbortController().signal)
    expect(calls).toBe(0)
    await f.manager.dispatch(event(), new AbortController().signal)
    expect(calls).toBe(1)
    const denied = structuredClone(f.config)
    if (!denied.permissions) throw new Error("missing permission fixture")
    denied.permissions.deny.push("fixture")
    f.config = denied
    await expect(f.manager.dispatch(event(), new AbortController().signal)).rejects.toThrow(
      "configuration or policy changed",
    )
    expect(calls).toBe(1)
  } finally {
    await f.close()
  }
})
