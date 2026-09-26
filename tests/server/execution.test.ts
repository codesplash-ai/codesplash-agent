import { expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseRunArguments, runRunCommand } from "../../src/cli.ts"
import type { ModelInfo, ProviderClient, ProviderRequest } from "../../src/engines/codesplash/contracts.ts"
import { DollarBudget, outputValidator } from "../../src/engines/codesplash/execution.ts"
import { create } from "../../src/sdk/runtime.ts"

const model: ModelInfo = {
  id: "fixture",
  displayName: "Fixture",
  provider: "openai",
  protocol: "openai",
  contextWindow: 32768,
  maxOutputTokens: 100,
  isDefault: true,
  supportsReasoning: false,
  pricing: { inputPerMTok: 1, outputPerMTok: 2 },
}
const request: ProviderRequest = { model, system: "test", messages: [], tools: [] }
const provider: ProviderClient = {
  id: "openai",
  models: [model],
  async *stream() {
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: "done", stopReason: "end_turn" }
  },
}
test("dollar reservations are shared, durable and fail closed on missing prices or usage", async () => {
  const states: unknown[] = [],
    budget = new DollarBudget(0.02, {}, (state) => states.push(state))
  await Array.fromAsync(budget.wrap(provider).stream(request, new AbortController().signal))
  expect(budget.used).toBe(0.00002)
  expect(states[0]).toMatchObject({ uncertain: true })
  expect(states.at(-1)).toEqual({ used: 0.00002, uncertain: false })
  await expect(
    Array.fromAsync(
      budget
        .wrap(provider)
        .stream({ ...request, model: { ...model, pricing: undefined } }, new AbortController().signal),
    ),
  ).rejects.toThrow("unpriced")
  const unknown = new DollarBudget(0.02)
  await expect(
    Array.fromAsync(
      unknown
        .wrap({
          ...provider,
          async *stream() {
            yield { type: "done", stopReason: "end_turn" }
          },
        })
        .stream(request, new AbortController().signal),
    ),
  ).rejects.toThrow("uncertain")
  expect(unknown.used).toBeGreaterThan(0)
  const resumed = new DollarBudget(0.02, { estimatedCostUsd: 0.019 })
  await expect(
    Array.fromAsync(resumed.wrap(provider).stream(request, new AbortController().signal)),
  ).rejects.toThrow("cannot admit")
})
test("schema validates JSON only, bounds nesting and never retries side effects", () => {
  const validate = outputValidator({
    type: "object",
    properties: { ok: { const: true } },
    required: ["ok"],
    additionalProperties: false,
  })!
  expect(validate('{"ok":true}')).toEqual({ ok: true })
  expect(() => validate('{"ok":false}')).toThrow("No automatic retry")
  expect(() => validate('```json\n{"ok":true}\n```')).toThrow()
})
test("headless flags parse literal tool ceilings, agent, bounded streaming and final-file contracts", () => {
  expect(
    parseRunArguments([
      "--tools",
      "read_file,grep",
      "--exclude-tools",
      "bash",
      "--max-budget-usd",
      "2",
      "--input-format",
      "stream-json",
      "--output-schema",
      '{"type":"object"}',
      "--output-last-message",
      "answer.json",
      "--agent",
      "explore",
    ]).execution,
  ).toEqual({ allowedTools: ["read_file", "grep"], excludedTools: ["bash"], maxBudgetUsd: 2 })
  expect(() => parseRunArguments(["--max-budget-usd", "NaN"])).toThrow()
})
test("SDK selected agent reuses native scoped execution and streams final output", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "m9-agent-")))
  const session = await create({
    respond: async () => ({ choice: "accept" }),
    cwd: root,
    trustDataDirectory: join(root, "data"),
    workspaceTrusted: true,
    config: { path: join(root, "absent.toml"), overrides: ["memory.enabled=false"] },
    agent: "explore",
    model: "ext_sdk_local/model",
    providers: [
      {
        name: "local",
        displayName: "Local",
        protocol: "openai",
        models: [{ ...model, id: "model" }],
        async *stream(request) {
          expect(request.system).toContain("exploration")
          yield { type: "text_delta", text: "scoped result" }
          yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } }
          yield { type: "done", stopReason: "end_turn" }
        },
      },
    ],
  })
  try {
    const result = await session.prompt("explore this workspace")
    expect(result.status).toBe("completed")
    expect(JSON.stringify(session.state.transcript)).toContain("scoped result")
  } finally {
    await session.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("streaming runner validates all frames and atomically publishes only a successful final message", async () => {
  const { AsyncQueue } = await import("../../src/core/async-queue.ts")
  const { createAgentEvent } = await import("../../src/core/events.ts")
  const { runHeadless } = await import("../../src/engines/codesplash/runner.ts")
  const root = await realpath(await mkdtemp(join(tmpdir(), "m9-stream-"))),
    path = join(root, "last.json")
  let sequence = 0,
    prompts = 0,
    output = ""
  const driver: import("../../src/core/engine.ts").EngineDriver = {
    id: "codesplash",
    async probe() {
      return { available: true }
    },
    async openSession(options) {
      const q = new AsyncQueue<import("../../src/core/events.ts").AgentEvent>()
      const emit = (event: import("../../src/core/events.ts").AgentEventInput) =>
        q.push(
          createAgentEvent(
            { engine: "codesplash", localSessionId: options.localSessionId, sequence: sequence++ },
            event,
          ),
        )
      const send = async (input: { text: string }) => {
        prompts++
        emit({ kind: "turn.started", payload: {} })
        emit({ kind: "message.completed", payload: { id: String(prompts), text: input.text } })
        emit({ kind: "turn.completed", payload: { status: "completed" } })
      }
      return {
        localSessionId: options.localSessionId,
        capabilities: {
          nativeTranscript: false,
          approvals: true,
          interrupt: true,
          resume: true,
          usage: "tokens",
          surface: "native",
        },
        events: q,
        send,
        async resolveRequest() {},
        async interrupt() {},
        async close() {
          q.end()
        },
      }
    },
  }
  const options = {
    cwd: root,
    prompt: "unused",
    trust: true,
    trustDataDir: join(root, "data"),
    driver,
    policy: { sandbox: "read-only" as const, approvalPolicy: "on-request" as const },
    autoApprove: false,
    outputFormat: "json" as const,
    outputSchema: { type: "object", required: ["ok"] },
    outputLastMessage: path,
    stdout: {
      write(s: string) {
        output += s
      },
    },
    stderr: { write() {} },
  }
  try {
    expect(
      await runHeadless({
        ...options,
        inputs: (async function* () {
          yield '{"ok":1}'
          yield '{"ok":2}'
        })(),
      }),
    ).toBe(0)
    expect(prompts).toBe(2)
    expect(await readFile(path, "utf8")).toBe('{"ok":2}')
    expect(JSON.parse(output).turns).toBe(2)
    expect(await runHeadless({ ...options, prompt: '{"wrong":1}' })).toBe(1)
    expect(await readFile(path, "utf8")).toBe('{"ok":2}')
    expect(
      await runHeadless({
        ...options,
        inputs: (async function* () {
          yield '{"ok":3}'
          throw new Error("bad frame")
        })(),
      }),
    ).toBe(1)
    expect(await readFile(path, "utf8")).toBe('{"ok":2}')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("SDK tool ceilings reject undisclosed dispatch and unpriced budgets stop before provider entry", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "m9-limits-")))
  let calls = 0
  const options: Parameters<typeof create>[0] = {
    cwd: root,
    trustDataDirectory: join(root, "data"),
    workspaceTrusted: true,
    config: { path: join(root, "absent.toml"), overrides: ["memory.enabled=false"] },
    model: "ext_sdk_local/model",
    execution: { allowedTools: ["read_file"] },
    providers: [
      {
        name: "local",
        displayName: "Local",
        protocol: "openai",
        models: [JSON.parse(JSON.stringify({ ...model, id: "model", pricing: undefined }))],
        async *stream(request) {
          calls++
          expect(request.tools.some((t) => t.name === "write_file")).toBe(false)
          if (!request.messages.some((m) => m.content.some((b) => b.type === "tool_result"))) {
            yield {
              type: "tool_call",
              id: "attempt",
              name: "write_file",
              input: { path: "forbidden.txt", content: "bad" },
            }
            yield { type: "done", stopReason: "tool_use" }
          } else {
            expect(
              request.messages.flatMap((m) => m.content).some((b) => b.type === "tool_result" && b.isError),
            ).toBe(true)
            yield { type: "text_delta", text: "done" }
            yield { type: "done", stopReason: "end_turn" }
          }
        },
      },
    ],
  }
  let session = await create(options)
  try {
    await session.prompt("test tool ceiling")
    expect(await Bun.file(join(root, "forbidden.txt")).exists()).toBe(false)
    await session.close()
    calls = 0
    session = await create({ ...options, execution: { maxBudgetUsd: 1 } })
    expect((await session.prompt("unpriced request")).status).toBe("failed")
    expect(calls).toBe(0)
  } finally {
    await session.close()
    await rm(root, { recursive: true, force: true })
  }
})
