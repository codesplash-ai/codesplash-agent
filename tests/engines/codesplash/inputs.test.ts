import { afterEach, expect, test } from "bun:test"
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { applyImport, previewImport } from "../../../src/commands/import.ts"
import { validateConfig } from "../../../src/core/config.ts"
import type { AgentEvent } from "../../../src/core/events.ts"
import type { ModelInfo, ProviderClient, ProviderRequest } from "../../../src/engines/codesplash/contracts.ts"
import { createSkill, writeResources } from "../../../src/engines/codesplash/inputs/authoring.ts"
import type { ContextToolRunner } from "../../../src/engines/codesplash/inputs/contracts.ts"
import {
  contextFilesTool,
  contextReadTool,
  internalContextTools,
  safeRead,
} from "../../../src/engines/codesplash/inputs/io.ts"
import { ContextInputs } from "../../../src/engines/codesplash/inputs/session.ts"
import {
  commandArgs,
  frontmatter,
  fuzzyFiles,
  mentions,
  skillScaffold,
  substitute,
} from "../../../src/engines/codesplash/inputs/syntax.ts"
import { CodesplashEventFactory, CodesplashLoop } from "../../../src/engines/codesplash/loop.ts"
import { createPermissionRuntime } from "../../../src/engines/codesplash/permissions.ts"
import { createToolRegistry } from "../../../src/engines/codesplash/tools/registry.ts"

const dirs: string[] = []
afterEach(async () => {
  for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true })
})
async function fixture(files: Record<string, string> = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "codesplash-inputs-")))
  dirs.push(cwd)
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true })
    await writeFile(join(cwd, path), text)
  }
  return cwd
}
async function resolver(files: Record<string, string> = {}, trusted = true) {
  const cwd = await fixture(files),
    user = await fixture()
  const calls: Array<{ name: string; input: unknown }> = []
  const run: ContextToolRunner = async (name, input) => {
    calls.push({ name, input })
    if (name === "context_confirm") return { type: "tool_result", toolCallId: "fixture", text: "Approved" }
    const tool = [...internalContextTools(), contextReadTool(user)].find((t) => t.name === name)
    if (!tool) throw new Error(`Unexpected tool ${name}`)
    const outcome = await tool.run(input, {
      cwd,
      policy: { sandbox: "workspace-write", approvalPolicy: "on-request" },
      signal: new AbortController().signal,
    })
    return { ...outcome, type: "tool_result", toolCallId: "fixture" }
  }
  return { cwd, user, run, calls, inputs: new ContextInputs(cwd, user, trusted) }
}
const signal = () => new AbortController().signal

test("flat frontmatter rejects ambiguous structures and duplicate keys", () => {
  expect(frontmatter("---\ndescription: |\n  First\n  second\n---\nBody")).toEqual({
    fields: { description: "First\nsecond" },
    body: "Body",
  })
  for (const source of [
    "---\na: 1\na: 2\n---",
    "---\na: [one]\n---",
    "---\na:\n  child: yes\n---",
    "---\na: *alias\n---",
    "---\na: !tag\n---",
  ])
    expect(() => frontmatter(source)).toThrow()
})
test("arguments substitute once with quotes defaults and slices", () => {
  const args = commandArgs(`one "two three" '' '$2'`)
  expect(args).toEqual(["one", "two three", "", "$2"])
  // biome-ignore lint/suspicious/noTemplateCurlyInString: tests literal template syntax
  expect(substitute("$1 / $2 / ${3:-default} / ${@:2:2} / $4", args)).toBe(
    "one / two three / default / two three  / $2",
  )
  expect(() => commandArgs('"unfinished')).toThrow()
})
test("mentions preserve emails and escapes and decode quoted paths", () => {
  expect(mentions('mail a@b.test \\@literal @src/a.ts @"a b.md" @src/a.ts')).toEqual(["src/a.ts", "a b.md"])
  expect(fuzzyFiles("src", ["misc/source.ts", "src/a.ts", "lib/src.ts"])[0]).toBe("src/a.ts")
})
test("context settings validate and reject unknown or escaping roots", () => {
  expect(
    validateConfig(
      { context: { personality: "concise", sharedSkills: true, includeRoots: ["docs"] } },
      "fixture",
    ).context?.sharedSkills,
  ).toBe(true)
  for (const context of [
    { sharedSkills: "yes" },
    { personality: "rude" },
    { includeRoots: ["../private"] },
    { includeRoots: ["/etc"] },
    { includeRoots: ["*"] },
    { typo: true },
  ])
    expect(() => validateConfig({ context }, "fixture")).toThrow()
})
test("safe reader rejects traversal symlinks hardlinks and oversized content", async () => {
  const cwd = await fixture({ "a.md": "okay", "large.md": "x".repeat(24 * 1024 + 1) })
  await symlink(join(cwd, "a.md"), join(cwd, "link.md"))
  await link(join(cwd, "a.md"), join(cwd, "hard.md"))
  for (const path of ["../outside", "link.md", "hard.md", "large.md"])
    await expect(safeRead(cwd, path)).rejects.toThrow()
})
test("untrusted project provides no resource metadata or body", async () => {
  const f = await resolver(
    { "AGENTS.md": "UNTRUSTED", ".codesplash/skills/check/SKILL.md": skillScaffold("check") },
    false,
  )
  const result = await f.inputs.prepare({ text: "hello" }, f.run, signal())
  expect(result.suffix).toBe("")
  expect(f.calls).toHaveLength(0)
})
test("native project wins duplicate commands and rules fall back only when absent", async () => {
  const f = await resolver({
    "AGENTS.md": "NATIVE",
    "CLAUDE.md": "FALLBACK",
    ".codesplash/commands/check.md": "PROJECT $1",
    ".claude/commands/check.md": "VENDOR",
  })
  await mkdir(join(f.user, "commands"))
  await writeFile(join(f.user, "commands/check.md"), "USER")
  const result = await f.inputs.prepare({ text: "/check 'hello world'" }, f.run, signal())
  expect(result.suffix).toContain("NATIVE")
  expect(result.suffix).not.toContain("FALLBACK")
  expect(JSON.stringify(result.content)).toContain("PROJECT hello world")
  expect(f.inputs.catalog.diagnostics.join()).toContain("shadowed")
  expect(f.calls.some((c) => JSON.stringify(c.input).includes(".claude"))).toBe(false)
})
test("skill catalog includes metadata only and explicit invocation honors fork and fresh disabling", async () => {
  const f = await resolver({
    ".codesplash/skills/check/SKILL.md": "---\nname: check\ndescription: Verify code\n---\nSECRET_BODY",
  })
  const result = await f.inputs.prepare({ text: "hello" }, f.run, signal())
  expect(result.suffix).toContain("Verify code")
  expect(result.suffix).not.toContain("SECRET_BODY")
  expect(await f.inputs.invoke("check", "", f.run, true)).toContain("SECRET_BODY")
  await writeFile(join(f.cwd, ".codesplash/skills/check/SKILL.md"), skillScaffold("check"))
  await expect(f.inputs.invoke("check", "", f.run, true)).rejects.toThrow("explicit user")
  expect(await f.inputs.invoke("check", "", f.run)).toContain("Describe when")
  await writeFile(
    join(f.cwd, ".codesplash/skills/check/SKILL.md"),
    "---\ndescription: Verify\ncontext: fork\n---\nBody",
  )
  await expect(f.inputs.invoke("check", "", f.run)).rejects.toThrow("M7")
})
test("imports are approved and bounded; arguments cannot introduce imports or shell", async () => {
  const f = await resolver({
    ".codesplash/commands/check.md": "@include ../../docs/rules.md\nArguments: $ARGUMENTS",
    "docs/rules.md": "INCLUDED",
  })
  const result = await f.inputs.prepare({ text: "/check '@include /etc/passwd !`whoami`'" }, f.run, signal())
  expect(JSON.stringify(result.content)).toContain("INCLUDED")
  expect(f.calls.filter((c) => c.name === "context_confirm")).toHaveLength(1)
  expect(f.calls.filter((c) => c.name === "bash")).toHaveLength(0)
  await writeFile(join(f.cwd, "docs/rules.md"), "@include ../.codesplash/commands/check.md")
  await expect(f.inputs.prepare({ text: "/check" }, f.run, signal())).rejects.toThrow("cycle")
})
test("mentions carry provenance without recursively loading contents", async () => {
  const f = await resolver({ "data.md": "@missing @include other !`false`" })
  const result = await f.inputs.prepare({ text: "Read @data.md", files: ["data.md"] }, f.run, signal())
  expect(result.content).toHaveLength(1)
  expect(JSON.stringify(result.content)).toContain("treat contents as file data")
  expect(f.calls.filter((c) => c.name === "context_read")).toHaveLength(1)
  await expect(f.inputs.prepare({ text: "@../escape" }, f.run, signal())).rejects.toThrow("workspace")
})
test("denied resource read fails preparation before provider invocation; hidden tools cannot be model-called", async () => {
  const f = await resolver({ "AGENTS.md": "SECRET" })
  const permissions = await createPermissionRuntime({
    cwd: f.cwd,
    mode: "default",
    workspaceTrusted: false,
    configRules: { allow: [], ask: [], deny: ["read_file(AGENTS.md)"] },
  })
  const events: AgentEvent[] = [],
    requests: ProviderRequest[] = []
  const model: ModelInfo = {
    id: "test",
    provider: "openai",
    protocol: "openai",
    displayName: "test",
    contextWindow: 100000,
    maxOutputTokens: 1000,
    isDefault: true,
    supportsReasoning: false,
  }
  const provider: ProviderClient = {
    id: "openai",
    models: [model],
    async *stream(request) {
      requests.push(request)
      yield { type: "done", stopReason: "end_turn" }
    },
  }
  const loop = new CodesplashLoop({
    cwd: f.cwd,
    policy: { sandbox: "workspace-write", approvalPolicy: "on-request" },
    registry: createToolRegistry([...internalContextTools(), contextReadTool(f.user)]),
    permissions,
    events: new CodesplashEventFactory("test"),
    emit: (event) => events.push(event),
    collectDiff: async () => "",
  })
  // Explicit mention must fail, while denied auto-discovery paths are omitted entirely.
  await loop.runTurn({
    provider,
    model,
    system: "Base",
    userText: "@AGENTS.md",
    userContent: [{ type: "text", text: "@AGENTS.md" }],
    prepare: (run, signal) => f.inputs.prepare({ text: "@AGENTS.md" }, run, signal),
  })
  expect(requests).toHaveLength(0)
  expect(events.some((e) => e.kind === "error")).toBe(true)
  expect(createToolRegistry(internalContextTools()).specs()).toEqual([])
})
test("filename search respects gitignore and read denies", async () => {
  const cwd = await fixture({ ".gitignore": "ignored.txt\n", "visible.txt": "okay", "ignored.txt": "no" })
  const proc = Bun.spawn(["git", "init", "-q"], { cwd, stdout: "ignore", stderr: "ignore" })
  expect(await proc.exited).toBe(0)
  const outcome = await contextFilesTool.run(
    { root: cwd },
    { cwd, policy: { sandbox: "read-only", approvalPolicy: "on-request" }, signal: signal() },
  )
  expect(JSON.parse(outcome.text)).toContain("visible.txt")
  expect(JSON.parse(outcome.text)).not.toContain("ignored.txt")
})
test("authoring previews and refuses overwrite, symlink destinations and partial collisions", async () => {
  const cwd = await fixture()
  expect(await createSkill(cwd, "check")).toContain("Preview")
  expect(await lstat(join(cwd, ".codesplash")).catch(() => undefined)).toBeUndefined()
  await createSkill(cwd, "check", true)
  await expect(createSkill(cwd, "check", true)).rejects.toThrow("overwrite")
  await expect(
    writeResources(cwd, [
      { path: "new.md", text: "new" },
      { path: ".codesplash/skills/check/SKILL.md", text: "oops" },
    ]),
  ).rejects.toThrow()
  expect(await lstat(join(cwd, "new.md")).catch(() => undefined)).toBeUndefined()
  await symlink(cwd, join(cwd, "alias"))
  await expect(writeResources(cwd, [{ path: "alias/escape.md", text: "no" }])).rejects.toThrow("symlink")
})
test("migration previews supported resources without settings values and imports exclusively", async () => {
  const source = await fixture({
    "CLAUDE.md": "Rule",
    ".claude/commands/check.md": "Check $ARGUMENTS",
    ".claude/settings.json": JSON.stringify({ apiKey: "SECRET_VALUE", permissions: {} }),
  })
  const destination = await fixture()
  const preview = await previewImport("claude", source, destination)
  expect(preview.files).toHaveLength(2)
  expect(JSON.stringify(preview)).not.toContain("SECRET_VALUE")
  expect(preview.unsupported.join()).toContain("apiKey")
  expect(await lstat(join(destination, "AGENTS.md")).catch(() => undefined)).toBeUndefined()
  await applyImport(preview)
  expect(await readFile(join(destination, "AGENTS.md"), "utf8")).toContain("Rule")
  await expect(applyImport(preview)).rejects.toThrow("overwrite")
})

test("read ask and import approval are honored before any provider call; interrupt cancels preparation", async () => {
  for (const interrupt of [false, true]) {
    const f = await resolver({ "AGENTS.md": "@include extra.md", "extra.md": "INCLUDED" })
    const permissions = await createPermissionRuntime({
      cwd: f.cwd,
      mode: "default",
      workspaceTrusted: false,
      configRules: { allow: [], deny: [], ask: ["read_file(AGENTS.md)"] },
    })
    const model: ModelInfo = {
      id: "test",
      provider: "openai",
      protocol: "openai",
      displayName: "test",
      contextWindow: 100000,
      maxOutputTokens: 1000,
      isDefault: true,
      supportsReasoning: false,
    }
    const requests: ProviderRequest[] = [],
      approvals: AgentEvent[] = []
    const provider: ProviderClient = {
      id: "openai",
      models: [model],
      async *stream(request) {
        requests.push(request)
        yield { type: "done", stopReason: "end_turn" }
      },
    }
    const loop = new CodesplashLoop({
      cwd: f.cwd,
      policy: { sandbox: "workspace-write", approvalPolicy: "on-request" },
      permissions,
      registry: createToolRegistry([...internalContextTools(), contextReadTool(f.user)]),
      events: new CodesplashEventFactory("ask"),
      collectDiff: async () => "",
      emit(event) {
        if (event.kind === "request.opened") {
          approvals.push(event)
          expect(requests).toHaveLength(0)
          queueMicrotask(() =>
            interrupt
              ? loop.interrupt()
              : loop.resolveRequest(event.payload.id, event.payload.alwaysAsk ? "decline" : "accept"),
          )
        }
      },
    })
    await loop.runTurn({
      provider,
      model,
      system: "Base",
      userText: "hello",
      userContent: [{ type: "text", text: "hello" }],
      prepare: (run, signal) => f.inputs.prepare({ text: "hello" }, run, signal),
    })
    expect(requests).toHaveLength(0)
    expect(approvals.length).toBeGreaterThan(0)
    if (!interrupt)
      expect(approvals.some((event) => event.kind === "request.opened" && event.payload.alwaysAsk)).toBe(true)
  }
})

test("model-selected hidden tools never execute", async () => {
  const f = await resolver({ "secret.md": "SECRET" })
  const model: ModelInfo = {
    id: "test",
    provider: "openai",
    protocol: "openai",
    displayName: "test",
    contextWindow: 100000,
    maxOutputTokens: 1000,
    isDefault: true,
    supportsReasoning: false,
  }
  let calls = 0,
    reads = 0
  const requests: ProviderRequest[] = []
  const hidden = contextReadTool()
  hidden.run = async () => {
    reads++
    return { text: "SECRET", label: "Read" }
  }
  const provider: ProviderClient = {
    id: "openai",
    models: [model],
    async *stream(request) {
      requests.push(structuredClone(request))
      if (calls++ === 0) {
        yield {
          type: "tool_call",
          id: "attack",
          name: "context_read",
          input: { root: f.cwd, path: "secret.md" },
        }
        yield { type: "done", stopReason: "tool_use" }
      } else yield { type: "done", stopReason: "end_turn" }
    },
  }
  const loop = new CodesplashLoop({
    cwd: f.cwd,
    policy: { sandbox: "workspace-write", approvalPolicy: "on-request" },
    registry: createToolRegistry([hidden]),
    events: new CodesplashEventFactory("hidden"),
    emit: () => {},
    collectDiff: async () => "",
  })
  await loop.runTurn({
    provider,
    model,
    system: "Base",
    userText: "hello",
    userContent: [{ type: "text", text: "hello" }],
  })
  expect(reads).toBe(0)
  expect(JSON.stringify(requests[1])).toContain("Unknown tool: context_read")
})

test("disabled vendor trees cannot exhaust discovery and static template references are attached", async () => {
  const f = await resolver({
    ".codesplash/commands/check.md": "Check @data.md",
    "data.md": "STATIC_REFERENCE",
  })
  await mkdir(join(f.cwd, ".claude/commands"), { recursive: true })
  for (let i = 0; i < 130; i++) await writeFile(join(f.cwd, `.claude/commands/ignored-${i}.md`), "ignored")
  const result = await f.inputs.prepare({ text: "/check" }, f.run, signal())
  expect(JSON.stringify(result.content)).toContain("STATIC_REFERENCE")
  expect(f.inputs.catalog.resources).toHaveLength(1)
})

test("frontmatter quoted booleans stay strings and shell limits are checked before execution", async () => {
  expect(frontmatter('---\ndescription: "true"\n---\nBody').fields.description).toBe("true")
  const f = await resolver({ ".codesplash/commands/check.md": "!`true`\n".repeat(5) })
  await expect(f.inputs.prepare({ text: "/check" }, f.run, signal())).rejects.toThrow("four shell")
  expect(f.calls.some((call) => call.name === "bash")).toBe(false)
})

test("ancestor rules keep root-to-cwd order and every body uses the read operation", async () => {
  const root = await fixture({ "AGENTS.md": "ROOT_RULE", "nested/AGENTS.md": "NESTED_RULE" }),
    user = await fixture()
  const git = Bun.spawn(["git", "init", "-q"], { cwd: root, stdout: "ignore", stderr: "ignore" })
  expect(await git.exited).toBe(0)
  const f = await resolver()
  const inputs = new ContextInputs(join(root, "nested"), user, true)
  const result = await inputs.prepare({ text: "hello" }, f.run, signal())
  expect(result.suffix.indexOf("ROOT_RULE")).toBeLessThan(result.suffix.indexOf("NESTED_RULE"))
  expect(f.calls.filter((c) => c.name === "context_read").length).toBeGreaterThanOrEqual(2)
})

test("resource transaction rolls back files if a later directory creation fails", async () => {
  const cwd = await fixture()
  await expect(
    writeResources(cwd, [
      { path: "collision", text: "first" },
      { path: "collision/second.md", text: "second" },
    ]),
  ).rejects.toThrow()
  expect(await lstat(join(cwd, "collision")).catch(() => undefined)).toBeUndefined()
})

test("configured include roots restrict imports even within the workspace", async () => {
  const f = await resolver({ "AGENTS.md": "@include outside.md", "outside.md": "NO", "docs/okay.md": "YES" })
  const inputs = new ContextInputs(f.cwd, f.user, true, { includeRoots: ["docs"] })
  await expect(inputs.prepare({ text: "hello" }, f.run, signal())).rejects.toThrow("allowed roots")
  await writeFile(join(f.cwd, "AGENTS.md"), "@include docs/okay.md")
  expect((await inputs.prepare({ text: "hello" }, f.run, signal())).suffix).toContain("YES")
})

test("rule reads are reused only within preparation, avoiding duplicate approvals", async () => {
  const f = await resolver({ "AGENTS.md": "FIRST" })
  await f.inputs.prepare({ text: "hello" }, f.run, signal())
  expect(f.calls.filter((c) => c.name === "context_read")).toHaveLength(1)
  await writeFile(join(f.cwd, "AGENTS.md"), "SECOND")
  expect((await f.inputs.prepare({ text: "again" }, f.run, signal())).suffix).toContain("SECOND")
  expect(f.calls.filter((c) => c.name === "context_read")).toHaveLength(2)
})

test("the reader accepts the OS canonical alias for a configured source root", async () => {
  const cwd = await fixture({ "rules.md": "RULE" })
  const aliasRoot = await fixture()
  await symlink(cwd, join(aliasRoot, "source"))
  // Real user roots are checked separately; safeRead resolves a known source root first.
  expect(await safeRead(join(aliasRoot, "source"), "rules.md")).toBe("RULE")
  await expect(safeRead(join(aliasRoot, "source"), "../outside")).rejects.toThrow()
})
