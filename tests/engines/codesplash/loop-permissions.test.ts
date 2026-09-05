import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { AgentEvent, SessionPolicy } from "../../../src/core/index.ts"
import type {
  HarnessTool,
  ModelInfo,
  PermissionDecision,
  PermissionMode,
  PermissionRuntime,
  PermissionTargets,
  ProviderClient,
  ProviderRequest,
  ProviderStreamEvent,
  ToolOutcome,
  ToolPermission,
} from "../../../src/engines/codesplash/contracts.ts"
import { ToolInputError } from "../../../src/engines/codesplash/contracts.ts"
import {
  APPROVAL_CHOICES,
  CodesplashEventFactory,
  CodesplashLoop,
  derivePersistableRule,
  PLAN_APPROVAL_CHOICES,
  PLAN_DETAIL_MAX_BYTES,
  type TurnRequest,
} from "../../../src/engines/codesplash/loop.ts"
import { createPermissionRuntime } from "../../../src/engines/codesplash/permissions.ts"
import { grepTool } from "../../../src/engines/codesplash/tools/grep.ts"
import { enterPlanModeTool, exitPlanModeTool } from "../../../src/engines/codesplash/tools/plan-mode.ts"
import { createToolRegistry } from "../../../src/engines/codesplash/tools/registry.ts"
import { writeFileTool } from "../../../src/engines/codesplash/tools/write.ts"

const MODEL: ModelInfo = {
  id: "test-model",
  displayName: "Test Model",
  provider: "anthropic",
  protocol: "anthropic",
  contextWindow: 200_000,
  maxOutputTokens: 1_000,
  isDefault: true,
  supportsReasoning: true,
}

const POLICY: SessionPolicy = { sandbox: "workspace-write", approvalPolicy: "on-request" }
const CWD = "/tmp/harness-test"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function makeFixture(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codesplash-loop-perm-"))
  temporaryDirectories.push(root)
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(root, relativePath)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, content)
  }
  return root
}

type Script = ProviderStreamEvent[] | ((signal: AbortSignal) => AsyncIterable<ProviderStreamEvent>)

function scriptedProvider(scripts: Script[]): ProviderClient & { requests: ProviderRequest[] } {
  const remaining = [...scripts]
  const requests: ProviderRequest[] = []
  return {
    id: "anthropic",
    models: [MODEL],
    requests,
    stream(request, signal) {
      requests.push(request)
      const script = remaining.shift()
      if (!script) throw new Error("scripted provider ran out of responses")
      if (typeof script === "function") return script(signal)
      return (async function* () {
        for (const event of script) yield event
      })()
    },
  }
}

function fakeTool(options: {
  name: string
  readOnly?: boolean
  permission?: ToolPermission
  permissionTargets?: (input: unknown) => PermissionTargets
  run?: HarnessTool["run"]
}): HarnessTool & { calls: unknown[] } {
  const calls: unknown[] = []
  const tool: HarnessTool & { calls: unknown[] } = {
    name: options.name,
    description: `fake ${options.name}`,
    inputSchema: { type: "object" },
    calls,
    isReadOnly: () => options.readOnly ?? false,
    permission: () => options.permission ?? { kind: "none" },
    run: async (input, context) => {
      calls.push(input)
      if (options.run) return options.run(input, context)
      return { text: `${options.name} ok`, label: `${options.name} label` } satisfies ToolOutcome
    },
  }
  if (options.permissionTargets) {
    const targetsOf = options.permissionTargets
    tool.permissionTargets = (input) => targetsOf(input)
  }
  return tool
}

/** decide receives the runtime's CURRENT mode so scripted behavior can depend on plan mode. */
type DecideFn = (
  toolName: string,
  targets: PermissionTargets | undefined,
  isReadOnly: boolean,
  mode: PermissionMode,
) => PermissionDecision

function fakeRuntime(
  options: {
    decide?: DecideFn
    mode?: PermissionMode
    failPersist?: boolean
    isReadDenied?: (resolvedPath: string, toolName: string) => string | undefined
  } = {},
) {
  let mode: PermissionMode = options.mode ?? "default"
  const grants: string[] = []
  const modes: PermissionMode[] = []
  const decideCalls: Array<{
    toolName: string
    targets: PermissionTargets | undefined
    isReadOnly: boolean
  }> = []
  const runtime: PermissionRuntime = {
    get mode() {
      return mode
    },
    setMode(next) {
      mode = next
      modes.push(next)
    },
    decide(toolName, targets, isReadOnly) {
      decideCalls.push({ toolName, targets, isReadOnly })
      return options.decide?.(toolName, targets, isReadOnly, mode) ?? { kind: "default" }
    },
    isReadDenied: options.isReadDenied ?? (() => undefined),
    async persistGrant(rule) {
      if (options.failPersist) throw new Error("grants store unavailable")
      grants.push(rule)
    },
  }
  return { runtime, grants, modes, decideCalls }
}

function makeLoop(
  options: {
    tools?: HarnessTool[]
    permissions?: PermissionRuntime
    cwd?: string
    policy?: SessionPolicy
  } = {},
) {
  const events: AgentEvent[] = []
  const loop = new CodesplashLoop({
    cwd: options.cwd ?? CWD,
    policy: options.policy ?? POLICY,
    registry: createToolRegistry(options.tools ?? []),
    events: new CodesplashEventFactory("session-1", 0),
    emit: (event) => events.push(event),
    permissions: options.permissions,
    collectDiff: async () => "",
  })
  return { loop, events }
}

function turnRequest(provider: ProviderClient, userText = "do the thing"): TurnRequest {
  return {
    provider,
    model: MODEL,
    reasoningEffort: "medium",
    system: "system prompt",
    userText,
    userContent: [{ type: "text", text: userText }],
  }
}

function ofKind<K extends AgentEvent["kind"]>(
  events: AgentEvent[],
  kind: K,
): Extract<AgentEvent, { kind: K }>[] {
  return events.filter((event): event is Extract<AgentEvent, { kind: K }> => event.kind === kind)
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

function toolResultAt(loop: CodesplashLoop, messageIndex: number, blockIndex = 0) {
  const block = loop.history[messageIndex]?.content[blockIndex]
  if (block?.type !== "tool_result")
    throw new Error(`history[${messageIndex}][${blockIndex}] is not a tool_result`)
  return block
}

const END_TURN: ProviderStreamEvent[] = [{ type: "done", stopReason: "end_turn" }]

function toolCallRound(id: string, name: string, input: unknown): ProviderStreamEvent[] {
  return [
    { type: "tool_call", id, name, input },
    { type: "done", stopReason: "tool_use" },
  ]
}

describe("permission decisions in the loop", () => {
  test("deny short-circuits: no request is opened, the tool never runs, the result names the reason", async () => {
    const tool = fakeTool({
      name: "write_file",
      permission: { kind: "approval", title: "Apply file changes?", detail: "/x" },
    })
    const { runtime } = fakeRuntime({
      decide: () => ({ kind: "deny", reason: 'deny rule write_file(**/*.secret) (source "user")' }),
    })
    const provider = scriptedProvider([toolCallRound("call-1", "write_file", { path: "a.secret" }), END_TURN])
    const { loop, events } = makeLoop({ tools: [tool], permissions: runtime })
    await loop.runTurn(turnRequest(provider))

    expect(ofKind(events, "request.opened")).toHaveLength(0)
    expect(tool.calls).toHaveLength(0)
    expect(toolResultAt(loop, 2)).toEqual({
      type: "tool_result",
      toolCallId: "call-1",
      text: 'Denied by permission rule: deny rule write_file(**/*.secret) (source "user")',
      isError: true,
    })
    expect(ofKind(events, "item.updated").at(-1)?.payload.status).toBe("failed")
    expect(ofKind(events, "turn.completed")[0]?.payload.status).toBe("completed")
  })

  test("allow runs the tool with no approval even when its own permission() would ask", async () => {
    const tool = fakeTool({
      name: "bash",
      permission: { kind: "approval", title: "Run command?", detail: "git status\n/tmp" },
      permissionTargets: (input) => ({ command: (input as { command: string }).command }),
    })
    const { runtime, decideCalls } = fakeRuntime({
      decide: () => ({ kind: "allow", reason: "allow rule bash(git status *)" }),
    })
    const provider = scriptedProvider([toolCallRound("call-1", "bash", { command: "git status" }), END_TURN])
    const { loop, events } = makeLoop({ tools: [tool], permissions: runtime })
    await loop.runTurn(turnRequest(provider))

    expect(ofKind(events, "request.opened")).toHaveLength(0)
    expect(tool.calls).toEqual([{ command: "git status" }])
    expect(toolResultAt(loop, 2).isError).toBeUndefined()
    // The extracted targets and read-only flag reached the runtime.
    expect(decideCalls.at(-1)).toEqual({
      toolName: "bash",
      targets: { command: "git status" },
      isReadOnly: false,
    })
  })

  test("ask reuses the tool's approval title/detail and acceptAlways persists the rule then runs", async () => {
    const tool = fakeTool({
      name: "bash",
      permission: { kind: "approval", title: "Run command?", detail: "git status\n/tmp" },
    })
    const { runtime, grants } = fakeRuntime({
      decide: () => ({ kind: "ask", persistableRule: "bash(git status *)" }),
    })
    const provider = scriptedProvider([toolCallRound("call-1", "bash", { command: "git status" }), END_TURN])
    const { loop, events } = makeLoop({ tools: [tool], permissions: runtime })

    const turn = loop.runTurn(turnRequest(provider))
    const request = await until(() => ofKind(events, "request.opened")[0], "request.opened")
    expect(request.payload.requestKind).toBe("approval")
    expect(request.payload.title).toBe("Run command?")
    expect(request.payload.detail).toBe("git status\n/tmp")
    expect(request.payload.choices).toEqual(["accept", "acceptAlways", "decline", "cancel"])
    expect(request.payload.alwaysAsk).toBeUndefined()
    expect(tool.calls).toHaveLength(0)

    loop.resolveRequest(request.payload.id, "acceptAlways")
    await turn

    expect(grants).toEqual(["bash(git status *)"])
    expect(tool.calls).toHaveLength(1)
    expect(toolResultAt(loop, 2).isError).toBeUndefined()
  })

  test("ask on a tool without its own approval uses a generic title, the label, and the reason", async () => {
    const tool = fakeTool({ name: "fake_tool", readOnly: true })
    const { runtime } = fakeRuntime({ decide: () => ({ kind: "ask", reason: "explicit ask rule" }) })
    const provider = scriptedProvider([toolCallRound("call-1", "fake_tool", {}), END_TURN])
    const { loop, events } = makeLoop({ tools: [tool], permissions: runtime })

    const turn = loop.runTurn(turnRequest(provider))
    const request = await until(() => ofKind(events, "request.opened")[0], "request.opened")
    expect(request.payload.title).toBe("Run fake_tool?")
    // The decision's reason is surfaced both inside the detail and as its own payload field.
    expect(request.payload.detail).toBe("fake_tool\n\nexplicit ask rule")
    expect(request.payload.reason).toBe("explicit ask rule")
    // No persistable rule → no acceptAlways choice.
    expect(request.payload.choices).toEqual(["accept", "decline", "cancel"])
    loop.resolveRequest(request.payload.id, "accept")
    await turn
    expect(tool.calls).toHaveLength(1)
  })

  test("a rule-driven ask on bash shows the full command, not the 80-char-clipped label", async () => {
    const longTail = `echo ${"x".repeat(90)} && touch pwned.txt`
    const tool = fakeTool({
      name: "bash",
      readOnly: false,
      permissionTargets: () => ({ command: longTail }),
    })
    const { runtime } = fakeRuntime({
      decide: () => ({ kind: "ask", reason: "`touch` past the clip" }),
    })
    const provider = scriptedProvider([toolCallRound("call-1", "bash", { command: longTail }), END_TURN])
    const { loop, events } = makeLoop({ tools: [tool], permissions: runtime })

    const turn = loop.runTurn(turnRequest(provider))
    const request = await until(() => ofKind(events, "request.opened")[0], "request.opened")
    // The destructive tail past the 80-char label clip must be visible in the approval detail.
    expect(request.payload.detail).toContain("touch pwned.txt")
    expect(request.payload.detail).toContain("`touch` past the clip")
    loop.resolveRequest(request.payload.id, "decline")
    await turn
    expect(tool.calls).toHaveLength(0)
  })

  test("a failing persistGrant warns but still runs the approved call", async () => {
    const tool = fakeTool({ name: "bash" })
    const { runtime, grants } = fakeRuntime({
      decide: () => ({ kind: "ask", persistableRule: "bash(ls *)" }),
      failPersist: true,
    })
    const provider = scriptedProvider([toolCallRound("call-1", "bash", { command: "ls" }), END_TURN])
    const { loop, events } = makeLoop({ tools: [tool], permissions: runtime })

    const turn = loop.runTurn(turnRequest(provider))
    const request = await until(() => ofKind(events, "request.opened")[0], "request.opened")
    loop.resolveRequest(request.payload.id, "acceptAlways")
    await turn

    expect(grants).toHaveLength(0)
    const warning = ofKind(events, "warning")[0]
    expect(warning?.payload.message).toContain("Could not persist the permission rule")
    expect(tool.calls).toHaveLength(1)
    expect(toolResultAt(loop, 2).isError).toBeUndefined()
  })

  test("alwaysAsk excludes acceptAlways even with a persistable rule and tags the request", async () => {
    const tool = fakeTool({
      name: "bash",
      permission: { kind: "approval", title: "Run command?", detail: "rm -rf /x\n/tmp" },
    })
    const { runtime, grants } = fakeRuntime({
      decide: () => ({
        kind: "ask",
        alwaysAsk: true,
        persistableRule: "bash(rm *)",
        reason: "rm with recursive and force flags",
      }),
    })
    const provider = scriptedProvider([toolCallRound("call-1", "bash", { command: "rm -rf /x" }), END_TURN])
    const { loop, events } = makeLoop({ tools: [tool], permissions: runtime })

    const turn = loop.runTurn(turnRequest(provider))
    const request = await until(() => ofKind(events, "request.opened")[0], "request.opened")
    expect(request.payload.choices).toEqual(["accept", "decline", "cancel"])
    expect(request.payload.alwaysAsk).toBe(true)
    // acceptAlways is not an offered choice, so resolving with it is rejected outright.
    expect(() => loop.resolveRequest(request.payload.id, "acceptAlways")).toThrow("Unsupported decision")
    loop.resolveRequest(request.payload.id, "decline")
    await turn

    expect(grants).toHaveLength(0)
    expect(tool.calls).toHaveLength(0)
    expect(toolResultAt(loop, 2).text).toBe("The user declined the request to run bash.")
  })

  test("a dangerous ask overrides a pre-existing acceptForSession approval for the same sessionKey", async () => {
    const tool = fakeTool({
      name: "bash",
      permission: { kind: "approval", title: "Run command?", detail: "git\n/tmp", sessionKey: "bash:git" },
      permissionTargets: (input) => ({ command: (input as { command: string }).command }),
    })
    const { runtime } = fakeRuntime({
      decide: (_toolName, targets) =>
        targets?.command?.includes("--force") === true
          ? { kind: "ask", alwaysAsk: true, reason: "git push --force" }
          : { kind: "default" },
    })
    const provider = scriptedProvider([
      toolCallRound("call-1", "bash", { command: "git status" }),
      toolCallRound("call-2", "bash", { command: "git push --force" }),
      END_TURN,
    ])
    const { loop, events } = makeLoop({ tools: [tool], permissions: runtime })

    const turn = loop.runTurn(turnRequest(provider))
    const first = await until(() => ofKind(events, "request.opened")[0], "first request")
    loop.resolveRequest(first.payload.id, "acceptForSession")
    // The session grant must NOT auto-approve the dangerous call: a second request opens.
    const second = await until(() => ofKind(events, "request.opened")[1], "second request")
    expect(second.payload.alwaysAsk).toBe(true)
    expect(second.payload.choices).toEqual(["accept", "decline", "cancel"])
    loop.resolveRequest(second.payload.id, "decline")
    await turn

    expect(tool.calls).toEqual([{ command: "git status" }])
  })

  test("an unanalyzable-bash ask skips the sessionKey auto-approve", async () => {
    const tool = fakeTool({
      name: "bash",
      permission: { kind: "approval", title: "Run command?", detail: "git\n/tmp", sessionKey: "bash:git" },
      permissionTargets: (input) => ({ command: (input as { command: string }).command }),
    })
    const { runtime } = fakeRuntime({
      // Mirrors the engine's unanalyzable-bash hardening: substitution → ask, no persistable rule.
      decide: (_toolName, targets) =>
        targets?.command?.includes("`") === true
          ? { kind: "ask", reason: "unanalyzable command" }
          : { kind: "default" },
    })
    const provider = scriptedProvider([
      toolCallRound("call-1", "bash", { command: "git status" }),
      toolCallRound("call-2", "bash", { command: "git `evil`" }),
      END_TURN,
    ])
    const { loop, events } = makeLoop({ tools: [tool], permissions: runtime })

    const turn = loop.runTurn(turnRequest(provider))
    const first = await until(() => ofKind(events, "request.opened")[0], "first request")
    loop.resolveRequest(first.payload.id, "acceptForSession")
    const second = await until(() => ofKind(events, "request.opened")[1], "second request")
    expect(second.payload.choices).toEqual(["accept", "decline", "cancel"])
    loop.resolveRequest(second.payload.id, "accept")
    await turn

    expect(ofKind(events, "request.opened")).toHaveLength(2)
    expect(tool.calls).toHaveLength(2)
  })
})

describe("default-path approvals", () => {
  test("without a permission runtime the flow is unchanged byte-for-byte", async () => {
    const tool = fakeTool({
      name: "write_file",
      permission: { kind: "approval", title: "Apply file changes?", detail: "/outside/dir/f.txt" },
      permissionTargets: () => ({ paths: ["/outside/dir/f.txt"] }),
    })
    const provider = scriptedProvider([
      toolCallRound("call-1", "write_file", { path: "/outside/dir/f.txt" }),
      END_TURN,
    ])
    const { loop, events } = makeLoop({ tools: [tool] })

    const turn = loop.runTurn(turnRequest(provider))
    const request = await until(() => ofKind(events, "request.opened")[0], "request.opened")
    expect(request.payload.choices).toEqual([...APPROVAL_CHOICES])
    expect(request.payload.alwaysAsk).toBeUndefined()
    loop.resolveRequest(request.payload.id, "accept")
    await turn
    expect(tool.calls).toHaveLength(1)
  })

  test("a derivable out-of-workspace file rule adds acceptAlways, which persists then runs", async () => {
    const tool = fakeTool({
      name: "write_file",
      permission: { kind: "approval", title: "Apply file changes?", detail: "/outside/dir/f.txt" },
      permissionTargets: () => ({ paths: ["/outside/dir/f.txt"] }),
    })
    const { runtime, grants } = fakeRuntime()
    const provider = scriptedProvider([
      toolCallRound("call-1", "write_file", { path: "/outside/dir/f.txt" }),
      END_TURN,
    ])
    const { loop, events } = makeLoop({ tools: [tool], permissions: runtime })

    const turn = loop.runTurn(turnRequest(provider))
    const request = await until(() => ofKind(events, "request.opened")[0], "request.opened")
    expect(request.payload.title).toBe("Apply file changes?")
    expect(request.payload.choices).toEqual([
      "accept",
      "acceptForSession",
      "acceptAlways",
      "decline",
      "cancel",
    ])
    loop.resolveRequest(request.payload.id, "acceptAlways")
    await turn

    expect(grants).toEqual(["write_file(/outside/dir/**)"])
    expect(tool.calls).toHaveLength(1)
    expect(toolResultAt(loop, 2).isError).toBeUndefined()
  })

  test("an inside-workspace target derives no rule, so acceptAlways is not offered", async () => {
    const inside = join(CWD, "f.txt")
    const tool = fakeTool({
      name: "write_file",
      permission: { kind: "approval", title: "Apply file changes?", detail: inside },
      permissionTargets: () => ({ paths: [inside] }),
    })
    const { runtime } = fakeRuntime()
    const provider = scriptedProvider([toolCallRound("call-1", "write_file", { path: inside }), END_TURN])
    const { loop, events } = makeLoop({ tools: [tool], permissions: runtime })

    const turn = loop.runTurn(turnRequest(provider))
    const request = await until(() => ofKind(events, "request.opened")[0], "request.opened")
    expect(request.payload.choices).toEqual([...APPROVAL_CHOICES])
    loop.resolveRequest(request.payload.id, "accept")
    await turn
    expect(tool.calls).toHaveLength(1)
  })

  test("bash derives a command rule for acceptAlways on the default path", async () => {
    const tool = fakeTool({
      name: "bash",
      permission: {
        kind: "approval",
        title: "Run command?",
        detail: "git status\n/tmp",
        sessionKey: "bash:git",
      },
      permissionTargets: (input) => ({ command: (input as { command: string }).command }),
    })
    const { runtime, grants } = fakeRuntime()
    const provider = scriptedProvider([toolCallRound("call-1", "bash", { command: "git status" }), END_TURN])
    const { loop, events } = makeLoop({ tools: [tool], permissions: runtime })

    const turn = loop.runTurn(turnRequest(provider))
    const request = await until(() => ofKind(events, "request.opened")[0], "request.opened")
    expect(request.payload.choices).toEqual([
      "accept",
      "acceptForSession",
      "acceptAlways",
      "decline",
      "cancel",
    ])
    loop.resolveRequest(request.payload.id, "acceptAlways")
    await turn

    expect(grants).toEqual(["bash(git status *)"])
    expect(tool.calls).toHaveLength(1)
  })

  test("web_fetch derives a host rule for acceptAlways on the default path", async () => {
    const tool = fakeTool({
      name: "web_fetch",
      readOnly: true,
      permission: { kind: "approval", title: "Fetch URL?", detail: "https://example.com/docs" },
      permissionTargets: () => ({ urlHost: "example.com" }),
    })
    const { runtime, grants } = fakeRuntime()
    const provider = scriptedProvider([
      toolCallRound("call-1", "web_fetch", { url: "https://example.com/docs" }),
      END_TURN,
    ])
    const { loop, events } = makeLoop({ tools: [tool], permissions: runtime })

    const turn = loop.runTurn(turnRequest(provider))
    const request = await until(() => ofKind(events, "request.opened")[0], "request.opened")
    expect(request.payload.choices).toEqual([
      "accept",
      "acceptForSession",
      "acceptAlways",
      "decline",
      "cancel",
    ])
    loop.resolveRequest(request.payload.id, "acceptAlways")
    await turn

    expect(grants).toEqual(["web_fetch(example.com)"])
    expect(tool.calls).toHaveLength(1)
  })

  test("a permissionTargets throw skips decide() and lets run() surface the input error", async () => {
    const tool = fakeTool({
      name: "write_file",
      permissionTargets: () => {
        throw new ToolInputError("write_file requires path to be a non-empty string")
      },
      run: async () => {
        throw new ToolInputError("write_file requires path to be a non-empty string")
      },
    })
    const { runtime, decideCalls } = fakeRuntime({
      decide: () => ({ kind: "deny", reason: "must never be consulted for unparsable input" }),
    })
    const provider = scriptedProvider([toolCallRound("call-1", "write_file", { path: 42 }), END_TURN])
    const { loop, events } = makeLoop({ tools: [tool], permissions: runtime })
    await loop.runTurn(turnRequest(provider))

    expect(decideCalls).toHaveLength(0)
    expect(ofKind(events, "request.opened")).toHaveLength(0)
    expect(toolResultAt(loop, 2)).toEqual({
      type: "tool_result",
      toolCallId: "call-1",
      text: "write_file requires path to be a non-empty string",
      isError: true,
    })
  })

  test("a non-ToolInputError permissionTargets throw fails the call closed, never a silent default", async () => {
    // Only a ToolInputError may fall through to the default path; any other bug must not skip
    // the deny rules and floors by pretending there were no targets.
    const tool = fakeTool({
      name: "write_file",
      permissionTargets: () => {
        throw new RangeError("patch parser blew up")
      },
    })
    const { runtime, decideCalls } = fakeRuntime({
      decide: () => ({ kind: "allow", reason: "must not be reached" }),
    })
    const provider = scriptedProvider([toolCallRound("call-1", "write_file", { path: "a.txt" }), END_TURN])
    const { loop, events } = makeLoop({ tools: [tool], permissions: runtime })
    await loop.runTurn(turnRequest(provider))

    expect(decideCalls).toHaveLength(0)
    expect(ofKind(events, "request.opened")).toHaveLength(0)
    expect(tool.calls).toHaveLength(0)
    const result = toolResultAt(loop, 2)
    expect(result.isError).toBe(true)
    expect(result.text).toContain("patch parser blew up")
  })

  test("deny rules apply to intrinsic tools (ask_user, enter_plan_mode) instead of being inert", async () => {
    const { runtime, modes } = fakeRuntime({
      decide: (toolName) =>
        toolName === "enter_plan_mode"
          ? { kind: "deny", reason: 'deny rule "enter_plan_mode" (user)' }
          : { kind: "default" },
    })
    const provider = scriptedProvider([toolCallRound("call-1", "enter_plan_mode", {}), END_TURN])
    const { loop, events } = makeLoop({
      tools: [enterPlanModeTool, exitPlanModeTool],
      permissions: runtime,
    })
    await loop.runTurn(turnRequest(provider))

    expect(ofKind(events, "request.opened")).toHaveLength(0)
    expect(modes).toEqual([]) // the mode switch never happened
    expect(toolResultAt(loop, 2)).toEqual({
      type: "tool_result",
      toolCallId: "call-1",
      text: 'Denied by permission rule: deny rule "enter_plan_mode" (user)',
      isError: true,
    })
  })
})

describe("derivePersistableRule", () => {
  test("derives file and host rules and stays undefined for everything else", () => {
    expect(derivePersistableRule("write_file", { paths: ["/outside/dir/f.txt"] }, CWD)).toBe(
      "write_file(/outside/dir/**)",
    )
    expect(derivePersistableRule("apply_patch", { paths: ["/outside/dir/f.txt"] }, CWD)).toBe(
      "apply_patch(/outside/dir/**)",
    )
    // Inside the workspace, multiple targets, or no targets → nothing to persist.
    expect(derivePersistableRule("write_file", { paths: [join(CWD, "f.txt")] }, CWD)).toBeUndefined()
    expect(
      derivePersistableRule("write_file", { paths: ["/outside/a.txt", "/outside/b.txt"] }, CWD),
    ).toBeUndefined()
    expect(derivePersistableRule("write_file", undefined, CWD)).toBeUndefined()
    expect(derivePersistableRule("web_fetch", { urlHost: "example.com" }, CWD)).toBe("web_fetch(example.com)")
    // Tools outside the bash/file/web_fetch grammar never derive a rule.
    expect(derivePersistableRule("todo_write", { paths: ["/outside/f.txt"] }, CWD)).toBeUndefined()
  })

  test("derives bash rules through command-analysis and never for unanalyzable commands", () => {
    expect(derivePersistableRule("bash", { command: "git status --short" }, CWD)).toBe("bash(git status *)")
    expect(derivePersistableRule("bash", { command: "ls -la" }, CWD)).toBe("bash(ls *)")
    // Substitution is unanalyzable; mixed-prefix compounds derive nothing.
    expect(derivePersistableRule("bash", { command: "git `evil`" }, CWD)).toBeUndefined()
    expect(derivePersistableRule("bash", { command: "git status && ls" }, CWD)).toBeUndefined()
    expect(derivePersistableRule("bash", {}, CWD)).toBeUndefined()
  })
})

describe("plan mode lifecycle", () => {
  /** Plan-mode-shaped decide: plan-file writes allowed, other mutations denied, reads default. */
  const planDecide: DecideFn = (toolName, targets, isReadOnly, mode) => {
    if (mode !== "plan") return { kind: "default" }
    if (isReadOnly) return { kind: "default" }
    if (toolName === "write_file" && targets?.paths?.[0] === join(CWD, ".codesplash", "plan.md")) {
      return { kind: "allow", reason: "plan file" }
    }
    return {
      kind: "deny",
      reason: "Plan mode is read-only — write the plan to .codesplash/plan.md and call exit_plan_mode",
    }
  }

  function planTools() {
    return fakeTool({
      name: "write_file",
      permissionTargets: (input) => ({ paths: [join(CWD, (input as { path: string }).path)] }),
    })
  }

  test("enter → mutation denied → plan-file write allowed → exit approve flips mode back → mutation runs", async () => {
    const writeTool = planTools()
    const { runtime, modes } = fakeRuntime({ decide: planDecide })
    const provider = scriptedProvider([
      toolCallRound("call-1", "enter_plan_mode", {}),
      toolCallRound("call-2", "write_file", { path: "src/evil.ts" }),
      toolCallRound("call-3", "write_file", { path: ".codesplash/plan.md" }),
      toolCallRound("call-4", "exit_plan_mode", { plan: "1. Do the thing\n2. Verify it" }),
      toolCallRound("call-5", "write_file", { path: "src/x.ts" }),
      END_TURN,
    ])
    const { loop, events } = makeLoop({
      tools: [enterPlanModeTool, exitPlanModeTool, writeTool],
      permissions: runtime,
    })

    const turn = loop.runTurn(turnRequest(provider))
    const request = await until(() => ofKind(events, "request.opened")[0], "plan approval")
    expect(request.payload.requestKind).toBe("approval")
    expect(request.payload.title).toBe("Approve this plan?")
    expect(request.payload.detail).toBe("1. Do the thing\n2. Verify it")
    expect(request.payload.choices).toEqual([...PLAN_APPROVAL_CHOICES])
    loop.resolveRequest(request.payload.id, "approve")
    await turn

    // The plan approval is the ONLY request the whole lifecycle opens.
    expect(ofKind(events, "request.opened")).toHaveLength(1)
    expect(modes).toEqual(["plan", "default"])
    expect(runtime.mode).toBe("default")

    expect(toolResultAt(loop, 2).text).toContain("Plan mode is on")
    const denied = toolResultAt(loop, 4)
    expect(denied.isError).toBe(true)
    expect(denied.text).toContain("Denied by permission rule: Plan mode is read-only")
    expect(toolResultAt(loop, 6).isError).toBeUndefined()
    expect(toolResultAt(loop, 8).text).toBe(
      "The user approved the plan. Plan mode is off — proceed with the implementation.",
    )
    expect(toolResultAt(loop, 10).isError).toBeUndefined()
    // Only the plan file and the post-approval mutation ran.
    expect(writeTool.calls).toEqual([{ path: ".codesplash/plan.md" }, { path: "src/x.ts" }])
  })

  test("exit approve restores the mode the session had before entering plan", async () => {
    const { runtime, modes } = fakeRuntime({ decide: planDecide, mode: "accept-edits" })
    const provider = scriptedProvider([
      toolCallRound("call-1", "enter_plan_mode", {}),
      toolCallRound("call-2", "exit_plan_mode", { plan: "the plan" }),
      END_TURN,
    ])
    const { loop, events } = makeLoop({ tools: [enterPlanModeTool, exitPlanModeTool], permissions: runtime })

    const turn = loop.runTurn(turnRequest(provider))
    const request = await until(() => ofKind(events, "request.opened")[0], "plan approval")
    loop.resolveRequest(request.payload.id, "approve")
    await turn

    expect(modes).toEqual(["plan", "accept-edits"])
    expect(runtime.mode).toBe("accept-edits")
  })

  test("keepPlanning is a non-error result and plan mode stays on", async () => {
    const { runtime, modes } = fakeRuntime({ decide: planDecide, mode: "plan" })
    const provider = scriptedProvider([toolCallRound("call-1", "exit_plan_mode", { plan: "wip" }), END_TURN])
    const { loop, events } = makeLoop({ tools: [enterPlanModeTool, exitPlanModeTool], permissions: runtime })

    const turn = loop.runTurn(turnRequest(provider))
    const request = await until(() => ofKind(events, "request.opened")[0], "plan approval")
    loop.resolveRequest(request.payload.id, "keepPlanning")
    await turn

    const result = toolResultAt(loop, 2)
    expect(result.text).toBe("The user chose to keep planning.")
    expect(result.isError).toBeUndefined()
    expect(modes).toEqual([])
    expect(runtime.mode).toBe("plan")
  })

  test("exit_plan_mode without a plan argument reads .codesplash/plan.md", async () => {
    const cwd = await makeFixture({ ".codesplash/plan.md": "# The plan\n\n1. Step one\n" })
    const { runtime } = fakeRuntime({ mode: "plan" })
    const provider = scriptedProvider([toolCallRound("call-1", "exit_plan_mode", {}), END_TURN])
    const { loop, events } = makeLoop({
      tools: [enterPlanModeTool, exitPlanModeTool],
      permissions: runtime,
      cwd,
    })

    const turn = loop.runTurn(turnRequest(provider))
    const request = await until(() => ofKind(events, "request.opened")[0], "plan approval")
    expect(request.payload.detail).toBe("# The plan\n\n1. Step one\n")
    loop.resolveRequest(request.payload.id, "approve")
    await turn
    expect(toolResultAt(loop, 2).text).toContain("The user approved the plan")
  })

  test("the plan-approval detail is capped at 8KB with a truncation note", async () => {
    const { runtime } = fakeRuntime({ mode: "plan" })
    const plan = "x".repeat(PLAN_DETAIL_MAX_BYTES + 2_000)
    const provider = scriptedProvider([toolCallRound("call-1", "exit_plan_mode", { plan }), END_TURN])
    const { loop, events } = makeLoop({ tools: [enterPlanModeTool, exitPlanModeTool], permissions: runtime })

    const turn = loop.runTurn(turnRequest(provider))
    const request = await until(() => ofKind(events, "request.opened")[0], "plan approval")
    expect(Buffer.byteLength(request.payload.detail, "utf8")).toBeLessThanOrEqual(PLAN_DETAIL_MAX_BYTES + 100)
    expect(request.payload.detail).toContain("[... plan truncated at 8KB")
    loop.resolveRequest(request.payload.id, "keepPlanning")
    await turn
  })

  test("plan-mode misuse is an isError result: re-enter, exit outside plan, exit with no plan anywhere", async () => {
    const cwd = await makeFixture()
    const { runtime } = fakeRuntime({ mode: "plan" })
    const provider = scriptedProvider([
      toolCallRound("call-1", "enter_plan_mode", {}),
      toolCallRound("call-2", "exit_plan_mode", {}),
      END_TURN,
    ])
    const { loop, events } = makeLoop({
      tools: [enterPlanModeTool, exitPlanModeTool],
      permissions: runtime,
      cwd,
    })
    await loop.runTurn(turnRequest(provider))

    const reenter = toolResultAt(loop, 2)
    expect(reenter.isError).toBe(true)
    expect(reenter.text).toBe("Already in plan mode.")
    const noPlan = toolResultAt(loop, 4)
    expect(noPlan.isError).toBe(true)
    expect(noPlan.text).toContain("write the plan to .codesplash/plan.md first")
    expect(ofKind(events, "request.opened")).toHaveLength(0)

    const outsidePlan = scriptedProvider([toolCallRound("call-1", "exit_plan_mode", { plan: "p" }), END_TURN])
    const other = makeLoop({
      tools: [enterPlanModeTool, exitPlanModeTool],
      permissions: fakeRuntime().runtime,
      cwd,
    })
    await other.loop.runTurn(turnRequest(outsidePlan))
    const result = toolResultAt(other.loop, 2)
    expect(result.isError).toBe(true)
    expect(result.text).toContain("Not in plan mode")
  })

  test("plan tools without a permission runtime report themselves unavailable", async () => {
    const provider = scriptedProvider([
      toolCallRound("call-1", "enter_plan_mode", {}),
      toolCallRound("call-2", "exit_plan_mode", { plan: "p" }),
      END_TURN,
    ])
    const { loop, events } = makeLoop({ tools: [enterPlanModeTool, exitPlanModeTool] })
    await loop.runTurn(turnRequest(provider))

    expect(toolResultAt(loop, 2)).toEqual({
      type: "tool_result",
      toolCallId: "call-1",
      text: "Plan mode is not available in this session.",
      isError: true,
    })
    expect(toolResultAt(loop, 4).text).toBe("Plan mode is not available in this session.")
    expect(ofKind(events, "request.opened")).toHaveLength(0)
  })
})

describe("grep read-path denials", () => {
  test("denied files are skipped before reading and a summary line is appended", async () => {
    const cwd = await makeFixture({
      ".env": "target_key=super-secret-value",
      "a.ts": "const target = 1",
    })
    const seen: string[] = []
    const { runtime } = fakeRuntime({
      isReadDenied: (resolvedPath, toolName) => {
        expect(toolName).toBe("grep")
        seen.push(resolvedPath)
        return resolvedPath.endsWith("/.env") ? "matches the built-in pattern **/.env" : undefined
      },
    })
    const context = {
      cwd,
      policy: POLICY,
      signal: new AbortController().signal,
      permissions: runtime,
    }

    const outcome = await grepTool.run({ pattern: "target" }, context)
    expect(outcome.text.split("\n")).toEqual([
      "a.ts:1:const target = 1",
      "(1 file(s) skipped by permission rules)",
    ])
    expect(outcome.text).not.toContain("super-secret-value")
    expect(seen).toContain(join(cwd, ".env"))

    const noMatches = await grepTool.run({ pattern: "nothing-matches-this" }, context)
    expect(noMatches.text).toBe("No matches found.\n(1 file(s) skipped by permission rules)")
    expect(noMatches.isError).toBeUndefined()
  })

  test("without a permission runtime grep behavior is unchanged", async () => {
    const cwd = await makeFixture({ ".env": "target_key=x", "a.ts": "const target = 1" })
    const outcome = await grepTool.run(
      { pattern: "target" },
      { cwd, policy: POLICY, signal: new AbortController().signal },
    )
    expect(outcome.text.split("\n").sort()).toEqual([".env:1:target_key=x", "a.ts:1:const target = 1"])
    expect(outcome.text).not.toContain("skipped by permission rules")
  })
})

describe("concurrency gating", () => {
  test("read-only calls with allow decisions batch up to the cap even when permission() would ask", async () => {
    let active = 0
    let maxActive = 0
    const tool = fakeTool({
      name: "probe",
      readOnly: true,
      permission: { kind: "approval", title: "Probe?", detail: "x" },
      run: async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await Bun.sleep(20)
        active -= 1
        return { text: "ok", label: "probe" }
      },
    })
    const { runtime } = fakeRuntime({ decide: () => ({ kind: "allow", reason: "allow rule probe" }) })
    // Distinct inputs: identical repeated calls would (correctly) trip doom-loop detection.
    const calls: ProviderStreamEvent[] = Array.from({ length: 6 }, (_, index) => ({
      type: "tool_call",
      id: `call-${index}`,
      name: "probe",
      input: { index },
    }))
    const provider = scriptedProvider([[...calls, { type: "done", stopReason: "tool_use" }], END_TURN])
    const { loop, events } = makeLoop({ tools: [tool], permissions: runtime })
    await loop.runTurn(turnRequest(provider))

    expect(tool.calls).toHaveLength(6)
    expect(maxActive).toBe(4)
    expect(ofKind(events, "request.opened")).toHaveLength(0)
  })

  test("an ask decision is a barrier: earlier reads finish first, later reads wait", async () => {
    const order: number[] = []
    const tool = fakeTool({
      name: "probe",
      readOnly: true,
      permissionTargets: (input) => ({ command: String((input as { index: number }).index) }),
      run: async (input) => {
        order.push((input as { index: number }).index)
        return { text: "ok", label: "probe" }
      },
    })
    const { runtime } = fakeRuntime({
      decide: (_toolName, targets) =>
        targets?.command === "1"
          ? { kind: "ask", reason: "ask rule" }
          : { kind: "allow", reason: "allow rule" },
    })
    const provider = scriptedProvider([
      [
        { type: "tool_call", id: "call-0", name: "probe", input: { index: 0 } },
        { type: "tool_call", id: "call-1", name: "probe", input: { index: 1 } },
        { type: "tool_call", id: "call-2", name: "probe", input: { index: 2 } },
        { type: "done", stopReason: "tool_use" },
      ],
      END_TURN,
    ])
    const { loop, events } = makeLoop({ tools: [tool], permissions: runtime })

    const turn = loop.runTurn(turnRequest(provider))
    const request = await until(() => ofKind(events, "request.opened")[0], "barrier request")
    // The earlier allow-batched call has run; the gated call and everything after are waiting.
    expect(order).toEqual([0])
    loop.resolveRequest(request.payload.id, "accept")
    await turn

    expect(order).toEqual([0, 1, 2])
    expect(ofKind(events, "request.opened")).toHaveLength(1)
  })

  test("deny decisions stay barriers and produce ordered results without a request", async () => {
    const tool = fakeTool({
      name: "probe",
      readOnly: true,
      permissionTargets: (input) => ({ command: String((input as { index: number }).index) }),
    })
    const { runtime } = fakeRuntime({
      decide: (_toolName, targets) =>
        targets?.command === "0"
          ? { kind: "deny", reason: "deny rule probe" }
          : { kind: "allow", reason: "ok" },
    })
    const provider = scriptedProvider([
      [
        { type: "tool_call", id: "call-0", name: "probe", input: { index: 0 } },
        { type: "tool_call", id: "call-1", name: "probe", input: { index: 1 } },
        { type: "done", stopReason: "tool_use" },
      ],
      END_TURN,
    ])
    const { loop, events } = makeLoop({ tools: [tool], permissions: runtime })
    await loop.runTurn(turnRequest(provider))

    expect(ofKind(events, "request.opened")).toHaveLength(0)
    const first = toolResultAt(loop, 2, 0)
    const second = toolResultAt(loop, 2, 1)
    expect(first.toolCallId).toBe("call-0")
    expect(first.isError).toBe(true)
    expect(first.text).toBe("Denied by permission rule: deny rule probe")
    expect(second.toolCallId).toBe("call-1")
    expect(second.isError).toBeUndefined()
    expect(tool.calls).toEqual([{ index: 1 }])
  })
})

describe("write floor end to end (real runtime + real tool)", () => {
  test("a .git write is denied in bypass mode under danger-full-access; ordinary writes still run", async () => {
    const cwd = await realpath(await makeFixture({ ".git/HEAD": "ref: refs/heads/main\n" }))
    const runtime = await createPermissionRuntime({
      cwd,
      mode: "bypass",
      workspaceTrusted: true,
      configRules: { allow: [], ask: [], deny: [] },
    })
    const provider = scriptedProvider([
      toolCallRound("call-1", "write_file", { path: ".git/hooks/pre-commit", content: "#!/bin/sh\n" }),
      toolCallRound("call-2", "write_file", { path: "notes.txt", content: "ok\n" }),
      END_TURN,
    ])
    const { loop, events } = makeLoop({
      tools: [writeFileTool],
      permissions: runtime,
      cwd,
      policy: { sandbox: "danger-full-access", approvalPolicy: "on-request" },
    })
    await loop.runTurn(turnRequest(provider))

    // The floor holds with no approval flow at all: neither call opens a request.
    expect(ofKind(events, "request.opened")).toHaveLength(0)
    const denied = toolResultAt(loop, 2)
    expect(denied.isError).toBe(true)
    expect(denied.text).toStartWith("Denied by permission rule: ")
    expect(existsSync(join(cwd, ".git", "hooks", "pre-commit"))).toBe(false)
    expect(await Bun.file(join(cwd, "notes.txt")).text()).toBe("ok\n")
  })
})

describe("default-path acceptAlways gating (real runtime)", () => {
  const bashLike = () =>
    fakeTool({
      name: "bash",
      permission: { kind: "approval", title: "Run command?", detail: "git status" },
      permissionTargets: (input) => ({ command: (input as { command: string }).command }),
    })

  test("no grants path: the real runtime never offers acceptAlways on the default path", async () => {
    const cwd = await realpath(await makeFixture())
    const runtime = await createPermissionRuntime({
      cwd,
      mode: "default",
      workspaceTrusted: true,
      configRules: { allow: [], ask: [], deny: [] },
    })
    const provider = scriptedProvider([toolCallRound("call-1", "bash", { command: "git status" }), END_TURN])
    const { loop, events } = makeLoop({ tools: [bashLike()], permissions: runtime, cwd })

    const turn = loop.runTurn(turnRequest(provider))
    const request = await until(() => ofKind(events, "request.opened")[0], "approval request")
    expect(request.payload.choices).toEqual([...APPROVAL_CHOICES])
    loop.resolveRequest(request.payload.id, "accept")
    await turn
  })

  test("with a grants path: acceptAlways is offered and persists the derived rule", async () => {
    const cwd = await realpath(await makeFixture())
    const grantsPath = join(cwd, "grants", "project.toml")
    const runtime = await createPermissionRuntime({
      cwd,
      mode: "default",
      workspaceTrusted: true,
      configRules: { allow: [], ask: [], deny: [] },
      grantsPath,
    })
    const provider = scriptedProvider([toolCallRound("call-1", "bash", { command: "git status" }), END_TURN])
    const { loop, events } = makeLoop({ tools: [bashLike()], permissions: runtime, cwd })

    const turn = loop.runTurn(turnRequest(provider))
    const request = await until(() => ofKind(events, "request.opened")[0], "approval request")
    expect(request.payload.choices).toEqual([
      "accept",
      "acceptForSession",
      "acceptAlways",
      "decline",
      "cancel",
    ])
    loop.resolveRequest(request.payload.id, "acceptAlways")
    await turn

    expect(await Bun.file(grantsPath).text()).toContain('"bash(git status *)"')
  })
})
