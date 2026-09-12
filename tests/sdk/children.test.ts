import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentSession, type ExtensionProvider } from "../../src/sdk/index.ts"

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cs-children-")))
  await mkdir(join(root, "config"))
  return {
    root,
    options: {
      cwd: root,
      workspaceTrusted: true,
      trustDataDirectory: join(root, "data"),
      config: { path: join(root, "config", "config.toml"), overrides: ["memory.enabled=false"] },
      model: "ext_sdk_local/model",
    },
    close: () => rm(root, { recursive: true, force: true }),
  }
}
function provider(stream: ExtensionProvider["stream"]): ExtensionProvider {
  return {
    name: "local",
    displayName: "Local child fixture",
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
  }
}
type Page = { task: { id: string; status: string }; output: { text: string } }
const taskOf = (value: unknown) => {
  const result = value as { text: string; isError?: boolean }
  expect(result.isError, result.text).toBeFalsy()
  return JSON.parse(result.text) as Page
}

test("native child uses fresh context, enforced plan permissions, bounded task output and aggregate usage", async () => {
  const f = await fixture(),
    requests: string[] = []
  const session = await createAgentSession({
    ...f.options,
    respond: async () => ({ choice: "accept" }),
    providers: [
      provider(async function* (request) {
        requests.push(JSON.stringify(request))
        const child = request.system.includes("[Child role")
        const result = request.messages.flatMap((m) => m.content).find((b) => b.type === "tool_result")
        if (child && !result)
          yield {
            type: "tool_call",
            id: "attempt-write",
            name: "write_file",
            input: { path: "forbidden.txt", content: "bad" },
          }
        else
          yield {
            type: "text_delta",
            text: child
              ? `CHILD_COMPLETE:${result?.type === "tool_result" && result.isError}`
              : "PARENT_COMPLETE",
          }
        yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
        yield { type: "done", stopReason: child && !result ? "tool_use" : "end_turn" }
      }),
    ],
  })
  try {
    await session.prompt("PRIVATE_PARENT_CONTEXT")
    const task = taskOf(await session.spawnAgent({ agent: "explore", prompt: "Investigate", yieldMs: 30000 }))
    expect(task.task.status, task.output.text).toBe("completed")
    expect(task.output.text).toContain("CHILD_COMPLETE:true")
    expect(await Bun.file(join(f.root, "forbidden.txt")).exists()).toBe(false)
    const childRequests = requests.filter((r) => r.includes("[Child role"))
    expect(childRequests.length).toBe(2)
    expect(childRequests.join("\n")).not.toContain("PRIVATE_PARENT_CONTEXT")
    expect(session.usage.inputTokens).toBe(12)
  } finally {
    await session.close()
    await f.close()
  }
}, 30000)

test("child write approval is forwarded with origin and routes to its exact child", async () => {
  const f = await fixture(),
    titles: string[] = []
  const session = await createAgentSession({
    ...f.options,
    config: { ...f.options.config, overrides: ["memory.enabled=false", 'permissions.ask=["write_file"]'] },
    respond: async (request) => {
      titles.push(request.title)
      return { choice: request.title.startsWith("[builtin/general") ? "decline" : "accept" }
    },
    providers: [
      provider(async function* (request) {
        const result = request.messages.flatMap((m) => m.content).find((b) => b.type === "tool_result")
        if (!result)
          yield {
            type: "tool_call",
            id: "write",
            name: "write_file",
            input: { path: "declined.txt", content: "declined" },
          }
        else
          yield {
            type: "text_delta",
            text: `CHILD_DENIED:${result.type === "tool_result" && result.isError}`,
          }
        yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
        yield { type: "done", stopReason: result ? "end_turn" : "tool_use" }
      }),
    ],
  })
  try {
    const task = taskOf(await session.spawnAgent({ agent: "general", prompt: "Try write", yieldMs: 30000 }))
    expect(task.task.status, task.output.text).toBe("completed")
    expect(task.output.text).toContain("CHILD_DENIED:true")
    expect(titles.some((title) => title.startsWith("[builtin/general"))).toBe(true)
    expect(await Bun.file(join(f.root, "declined.txt")).exists()).toBe(false)
  } finally {
    await session.close()
    await f.close()
  }
}, 30000)

test("recorded child resumes its transcript and rejects persona changes", async () => {
  const f = await fixture()
  const make = () =>
    createAgentSession({
      ...f.options,
      persistence: { root: join(f.root, "sessions") },
      respond: async () => ({ choice: "accept" }),
      providers: [
        provider(async function* (request) {
          yield {
            type: "text_delta",
            text: request.messages
              .map((m) =>
                m.content
                  .filter((b) => b.type === "text")
                  .map((b) => (b.type === "text" ? b.text : ""))
                  .join(" "),
              )
              .join("|"),
          }
          yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
          yield { type: "done", stopReason: "end_turn" }
        }),
      ],
    })
  const session = await make()
  try {
    const first = taskOf(
      await session.spawnAgent({
        agent: "explore",
        prompt: "FIRST_CHILD_CONTEXT",
        persona: "reviewer",
        yieldMs: 30000,
      }),
    )
    expect(first.task.status).toBe("completed")
    const second = taskOf(
      await session.spawnAgent({
        agent: "explore",
        prompt: "SECOND_CHILD_CONTEXT",
        resume: first.task.id,
        yieldMs: 30000,
      }),
    )
    expect(second.task.status, second.output.text).toBe("completed")
    expect(second.output.text).toContain("FIRST_CHILD_CONTEXT")
    expect(second.output.text).toContain("SECOND_CHILD_CONTEXT")
    const bad = (await session.spawnAgent({
      agent: "explore",
      prompt: "wrong persona",
      resume: first.task.id,
      persona: "writer",
    })) as { isError?: boolean; text: string }
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain("identity")
  } finally {
    await session.close()
    await f.close()
  }
}, 30000)

test("nested admission rejects saturation without deadlocking the parent", async () => {
  const f = await fixture()
  let providerCalls = 0
  const session = await createAgentSession({
    ...f.options,
    config: { ...f.options.config, overrides: ["memory.enabled=false", "orchestration.maxRunning=1"] },
    respond: async () => ({ choice: "accept" }),
    providers: [
      provider(async function* (request) {
        providerCalls++
        const result = request.messages.flatMap((m) => m.content).find((b) => b.type === "tool_result")
        if (!result)
          yield {
            type: "tool_call",
            id: "nested",
            name: "agent",
            input: { agent: "general", prompt: "nested", yieldMs: 30000 },
          }
        else yield { type: "text_delta", text: result.type === "tool_result" ? result.text : "wrong" }
        yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
        yield { type: "done", stopReason: result ? "end_turn" : "tool_use" }
      }),
    ],
  })
  try {
    const task = taskOf(await session.spawnAgent({ agent: "general", prompt: "parent", yieldMs: 30000 }))
    expect(task.task.status, task.output.text).toBe("completed")
    expect(task.output.text).toContain("Nested task capacity")
    expect(providerCalls).toBe(2)
    expect(await session.tasks({ action: "list" })).toHaveLength(1)
  } finally {
    await session.close()
    await f.close()
  }
}, 30000)

test("forked skill executes a real owned child instead of injecting its body inline", async () => {
  const f = await fixture(),
    childRequests: string[] = []
  await mkdir(join(f.root, ".codesplash/skills/inspect"), { recursive: true })
  await Bun.write(
    join(f.root, ".codesplash/skills/inspect/SKILL.md"),
    "---\nname: inspect\ndescription: Inspect a task\ncontext: fork\n---\nFORKED_SKILL_BODY $ARGUMENTS",
  )
  const session = await createAgentSession({
    ...f.options,
    respond: async () => ({ choice: "accept" }),
    providers: [
      provider(async function* (request) {
        const child = request.system.includes("[Child role")
        if (child) childRequests.push(JSON.stringify(request.messages))
        yield { type: "text_delta", text: child ? "SKILL_CHILD_COMPLETED" : "PARENT_RECEIVED_TASK" }
        yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
        yield { type: "done", stopReason: "end_turn" }
      }),
    ],
  })
  try {
    expect((await session.prompt("/skill inspect argument-data")).status).toBe("completed")
    const tasks = (await session.tasks({ action: "list" })) as Array<{ id: string; kind: string }>
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.kind).toBe("agent")
    const [result] = (await session.tasks({
      action: "wait",
      ids: [tasks[0]!.id],
      all: true,
      timeoutMs: 10000,
    })) as Page[]
    expect(result!.task.status, result!.output.text).toBe("completed")
    expect(result!.output.text).toContain("SKILL_CHILD_COMPLETED")
    expect(childRequests.join("\n")).toContain("FORKED_SKILL_BODY argument-data")
  } finally {
    await session.close()
    await f.close()
  }
}, 30000)

test("closing the parent interrupts a live child and settles all task ownership", async () => {
  const f = await fixture()
  let started = false,
    aborted = false
  const session = await createAgentSession({
    ...f.options,
    respond: async () => ({ choice: "accept" }),
    providers: [
      provider(async function* (_request, { signal }) {
        started = true
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else
            signal.addEventListener(
              "abort",
              () => {
                aborted = true
                resolve()
              },
              { once: true },
            )
        })
        yield { type: "usage", usage: { inputTokens: 1, outputTokens: 0 } }
        yield { type: "done", stopReason: "aborted" }
      }),
    ],
  })
  try {
    taskOf(await session.spawnAgent({ agent: "explore", prompt: "Keep waiting", background: true }))
    const until = Date.now() + 5000
    while (!started && Date.now() < until) await Bun.sleep(10)
    expect(started).toBe(true)
    await session.close()
    expect(aborted).toBe(true)
  } finally {
    await session.close()
    await f.close()
  }
}, 15000)

test("child context resumes after parent restart from owned durable identity", async () => {
  const f = await fixture()
  const scripted = provider(async function* (request) {
    yield { type: "text_delta", text: JSON.stringify(request.messages) }
    yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: "done", stopReason: "end_turn" }
  })
  const options = {
    ...f.options,
    providers: [scripted],
    respond: async () => ({ choice: "accept" }),
    persistence: { root: join(f.root, "sessions") },
  }
  const first = await createAgentSession(options)
  let second: Awaited<ReturnType<typeof createAgentSession>> | undefined
  try {
    const task = taskOf(
      await first.spawnAgent({ agent: "explore", prompt: "RECORDED_CHILD_BEFORE_RESTART", yieldMs: 30000 }),
    )
    expect(task.task.status, task.output.text).toBe("completed")
    await first.close()
    second = await createAgentSession({
      ...options,
      persistence: { ...options.persistence, resume: first.id },
    })
    const resumed = taskOf(
      await second.spawnAgent({
        agent: "explore",
        resume: task.task.id,
        prompt: "AFTER_RESTART",
        yieldMs: 30000,
      }),
    )
    expect(resumed.task.status, resumed.output.text).toBe("completed")
    expect(resumed.output.text).toContain("RECORDED_CHILD_BEFORE_RESTART")
    expect(resumed.output.text).toContain("AFTER_RESTART")
  } finally {
    await second?.close()
    await first.close()
    await f.close()
  }
}, 30000)

test("verified plugin definitions execute and changed selected bytes are refused", async () => {
  const { runPluginCommand } = await import("../../src/commands/plugin.ts")
  const { loadConfig } = await import("../../src/core/config.ts")
  const f = await fixture(),
    source = join(f.root, "source")
  await mkdir(join(source, "agents"), { recursive: true })
  await Bun.write(
    join(source, "codesplash-plugin.json"),
    JSON.stringify({
      schemaVersion: 1,
      api: 1,
      id: "agents",
      version: "1.0.0",
      agents: ["agents/reviewer.md"],
    }),
  )
  await Bun.write(
    join(source, "agents/reviewer.md"),
    "---\ndescription: Plugin reviewer\nmode: plan\n---\nPLUGIN_ROLE_INSTRUCTIONS",
  )
  const env = {
    CODESPLASH_AGENT_CONFIG_DIR: join(f.root, "config"),
    CODESPLASH_AGENT_DATA_DIR: join(f.root, "data"),
  }
  let session: Awaited<ReturnType<typeof createAgentSession>> | undefined
  try {
    for (const args of [
      ["install", source],
      ["enable", "agents"],
    ])
      await runPluginCommand(args, { cwd: f.root, env, output() {} })
    const config = await loadConfig(f.options.config.path, [], { cwd: f.root, env, workspaceTrusted: true })
    session = await createAgentSession({
      ...f.options,
      respond: async () => ({ choice: "accept" }),
      providers: [
        provider(async function* (request) {
          yield {
            type: "text_delta",
            text: request.system.includes("PLUGIN_ROLE_INSTRUCTIONS") ? "PLUGIN_CHILD_OK" : "MISSING_ROLE",
          }
          yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
          yield { type: "done", stopReason: "end_turn" }
        }),
      ],
    })
    const task = taskOf(
      await session.spawnAgent({ agent: "plugin/agents/reviewer", prompt: "Review", yieldMs: 30000 }),
    )
    expect(task.task.status, task.output.text).toBe("completed")
    expect(task.output.text).toContain("PLUGIN_CHILD_OK")
    await Bun.write(join(config.plugins!.entries.agents!.root, "agents/reviewer.md"), "changed")
    const result = (await session.spawnAgent({
      agent: "plugin/agents/reviewer",
      prompt: "Changed source",
    })) as { isError?: boolean; text: string }
    expect(result.isError).toBe(true)
    expect(result.text).toContain("changed")
  } finally {
    await session?.close()
    await f.close()
  }
}, 30000)

test("narrow tool lists preserve fixed context reads but hide excluded workload tools", async () => {
  const f = await fixture()
  await Bun.write(
    f.options.config.path,
    '[agents.definitions.reader]\ndescription="Reader"\nprompt="Read only"\nmode="plan"\ntools=["read_file"]\n',
  )
  await Bun.write(join(f.root, "input.txt"), "SCOPED_READ_DATA")
  const session = await createAgentSession({
    ...f.options,
    respond: async () => ({ choice: "accept" }),
    providers: [
      provider(async function* (request) {
        expect(request.tools.map((t) => t.name)).toContain("read_file")
        expect(request.tools.map((t) => t.name)).not.toContain("bash")
        const result = request.messages.flatMap((m) => m.content).find((b) => b.type === "tool_result")
        if (!result) yield { type: "tool_call", id: "read", name: "read_file", input: { path: "input.txt" } }
        else yield { type: "text_delta", text: result.type === "tool_result" ? result.text : "bad" }
        yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
        yield { type: "done", stopReason: result ? "end_turn" : "tool_use" }
      }),
    ],
  })
  try {
    const task = taskOf(
      await session.spawnAgent({ agent: "reader", prompt: "Read input.txt", yieldMs: 30000 }),
    )
    expect(task.task.status, task.output.text).toBe("completed")
    expect(task.output.text).toContain("SCOPED_READ_DATA")
  } finally {
    await session.close()
    await f.close()
  }
}, 30000)

test("child MCP inheritance connects only selected parent servers and dispatches lifecycle hooks", async () => {
  const { loadConfig } = await import("../../src/core/config.ts")
  const { reviewMcpServer, recordMcpTrust } = await import("../../src/engines/codesplash/mcp/trust.ts")
  const { reviewHook, trustHook } = await import("../../src/engines/codesplash/hooks/trust.ts")
  const f = await fixture(),
    calls: string[] = [],
    hooks: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const value = (await request.json()) as { id?: string | number; method?: string; name?: string }
      const path = new URL(request.url).pathname
      if (path === "/hook") {
        hooks.push(value.name ?? "")
        return Response.json({ version: 1 })
      }
      if (value.method === "notifications/initialized") return new Response(null, { status: 202 })
      if (value.method === "initialize") {
        calls.push(path)
        return Response.json({
          jsonrpc: "2.0",
          id: value.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: path.slice(1), version: "1" },
          },
        })
      }
      if (value.method === "tools/list")
        return Response.json({ jsonrpc: "2.0", id: value.id, result: { tools: [] } })
      return new Response(null, { status: 405 })
    },
  })
  let session: Awaited<ReturnType<typeof createAgentSession>> | undefined
  try {
    await Bun.write(
      f.options.config.path,
      `[agents.definitions.selected]\ndescription="Selected MCP"\nprompt="Check selected services"\nmode="plan"\n[agents.definitions.selected.mcp]\nonly=["one"]\n${["one", "two"].map((name) => `[mcp.servers.${name}]\ntransport="http"\nurl="${server.url.origin}/${name}"\nenabled=true\nallowLoopback=true\n`).join("")}\n[hooks.handlers.children]\nkind="http"\nurl="${server.url.origin}/hook"\nallowLoopback=true\nenabled=true\nevents=["subagent.start","subagent.stop"]\n`,
    )
    const config = await loadConfig(f.options.config.path, [], {
      cwd: f.root,
      workspaceTrusted: true,
      dataDir: f.options.trustDataDirectory,
    })
    for (const name of ["one", "two"]) {
      const review = await reviewMcpServer(config, name, f.root)
      recordMcpTrust(f.options.trustDataDirectory, review, review.fingerprint)
    }
    const hook = await reviewHook(config, "children", f.root)
    trustHook(f.options.trustDataDirectory, hook, hook.fingerprint)
    session = await createAgentSession({
      ...f.options,
      respond: async () => ({ choice: "accept" }),
      providers: [
        provider(async function* () {
          yield { type: "text_delta", text: "SCOPED_MCP_OK" }
          yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
          yield { type: "done", stopReason: "end_turn" }
        }),
      ],
    })
    await session.agentDefinitions()
    expect(calls.sort()).toEqual(["/one", "/two"])
    calls.length = 0
    const task = taskOf(
      await session.spawnAgent({ agent: "selected", prompt: "Check services", yieldMs: 30000 }),
    )
    expect(task.task.status, task.output.text).toBe("completed")
    expect(calls).toEqual(["/one"])
    expect(hooks).toEqual(["subagent.start", "subagent.stop"])
  } finally {
    await session?.close()
    server.stop(true)
    await f.close()
  }
}, 30000)

test("nested no-history children resume after their parent closes and forget descendants first", async () => {
  const f = await fixture()
  let nested = ""
  const consumed = new Set<string>()
  const session = await createAgentSession({
    ...f.options,
    respond: async () => ({ choice: "accept" }),
    providers: [
      provider(async function* (request) {
        const texts = request.messages
          .flatMap((m) => m.content)
          .filter((b) => b.type === "text")
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("|")
        if (request.system.includes("builtin/explore")) {
          yield { type: "text_delta", text: texts }
          yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
          yield { type: "done", stopReason: "end_turn" }
          return
        }
        const last = request.messages
          .flatMap((m) => m.content)
          .findLast((b) => b.type === "tool_result" && !consumed.has(b.toolCallId))
        if (last?.type === "tool_result") {
          consumed.add(last.toolCallId)
          const page = JSON.parse(last.text) as Page
          nested = page.task.id
          yield { type: "text_delta", text: page.output.text }
        } else
          yield {
            type: "tool_call",
            id: crypto.randomUUID(),
            name: "agent",
            input: {
              agent: "explore",
              prompt: texts.includes("SECOND_PARENT") ? "SECOND_NESTED" : "FIRST_NESTED",
              ...(nested ? { resume: nested } : {}),
              yieldMs: 30000,
            },
          }
        yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
        yield { type: "done", stopReason: last ? "end_turn" : "tool_use" }
      }),
    ],
  })
  try {
    const first = taskOf(
      await session.spawnAgent({ agent: "general", prompt: "FIRST_PARENT", yieldMs: 30000 }),
    )
    expect(first.task.status, first.output.text).toBe("completed")
    expect(first.output.text).toContain("FIRST_NESTED")
    const second = taskOf(
      await session.spawnAgent({
        agent: "general",
        prompt: "SECOND_PARENT",
        resume: first.task.id,
        yieldMs: 30000,
      }),
    )
    expect(second.task.status, second.output.text).toBe("completed")
    expect(second.output.text).toContain("FIRST_NESTED")
    expect(second.output.text).toContain("SECOND_NESTED")
    await expect(session.tasks({ action: "forget", id: first.task.id })).rejects.toThrow("unreferenced")
    const tasks = (await session.tasks({ action: "list" })) as { id: string; depth: number }[]
    for (const task of tasks.sort((a, b) => b.depth - a.depth))
      await session.tasks({ action: "forget", id: task.id })
    expect(await session.tasks({ action: "list" })).toEqual([])
  } finally {
    await session.close()
    await f.close()
  }
}, 30000)

test("live identity reuse is refused and Ctrl+B releases a foreground child wait", async () => {
  const f = await fixture()
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const session = await createAgentSession({
    ...f.options,
    respond: async () => ({ choice: "accept" }),
    providers: [
      provider(async function* () {
        entered()
        await gate
        yield { type: "text_delta", text: "RELEASED" }
        yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
        yield { type: "done", stopReason: "end_turn" }
      }),
    ],
  })
  try {
    const pending = session.spawnAgent({ agent: "explore", prompt: "Wait", yieldMs: 30000 })
    await started
    await session.tasks({ action: "background" })
    const first = taskOf(await pending)
    expect(first.task.status).toBe("running")
    const bad = (await session.spawnAgent({ agent: "explore", prompt: "Reuse", resume: first.task.id })) as {
      isError?: boolean
      text: string
    }
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain("active work")
    release()
    const done = (await session.tasks({
      action: "wait",
      ids: [first.task.id],
      all: true,
      timeoutMs: 30000,
    })) as Page[]
    expect(done[0]?.task.status).toBe("completed")
  } finally {
    release()
    await session.close()
    await f.close()
  }
}, 30000)
