import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAgentsCommand } from "../../../src/commands/agents.ts"
import { defaultConfig } from "../../../src/core/config.ts"
import type { PermissionRuntime, ProviderClient } from "../../../src/engines/codesplash/contracts.ts"
import {
  parseAgentMarkdown,
  type ResolvedAgent,
  validateAgentDefinition,
} from "../../../src/engines/codesplash/orchestration/definitions.ts"
import {
  ChildBudget,
  ChildSandbox,
  scopedConfig,
  scopedPermissions,
  scopedProfile,
} from "../../../src/engines/codesplash/orchestration/scope.ts"
import { createProfile } from "../../../src/engines/codesplash/sandbox/profile.ts"

const definition = (extra = {}): ResolvedAgent => ({
  ...validateAgentDefinition({ description: "Test", prompt: "Test task", ...extra }),
  name: "test",
  id: "builtin/test",
  source: "builtin",
  fingerprint: "a".repeat(64),
})
test("definition scope refuses expansion and intersects permissions without inheriting remembered allows", async () => {
  const profile = createProfile(process.cwd(), "workspace-write")
  expect(() => scopedProfile(profile, definition({ readRoots: ["/"] }), "default")).toThrow("exceeds")
  expect(() => scopedProfile(profile, definition({ allowedHosts: ["example.com:443"] }), "default")).toThrow(
    "exceeds",
  )
  const scoped = scopedProfile(profile, definition({ mode: "plan" }), "plan")
  expect(scoped.writeRoots).toEqual([])
  const sandbox = new ChildSandbox(scoped)
  try {
    expect(() => sandbox.validateGrant({ resource: "read", target: "/", scope: "turn" }, "plan")).toThrow()
  } finally {
    await sandbox.close()
  }
  const own: PermissionRuntime = {
    mode: "default",
    decide: () => ({ kind: "ask" }),
    setMode() {},
    isReadDenied: () => undefined,
    persistGrant: async () => {},
  }
  const parent: PermissionRuntime = { ...own, decide: () => ({ kind: "allow", reason: "remembered" }) }
  expect(scopedPermissions(own, parent, definition()).decide("bash", undefined, false).kind).toBe("ask")
  expect(
    scopedPermissions(own, parent, definition({ tools: ["read_file"] })).decide(
      "write_file",
      undefined,
      false,
    ).kind,
  ).toBe("deny")
  expect(() => scopedPermissions(own, parent, definition({ mode: "plan" })).setMode("default")).toThrow(
    "envelope",
  )
  expect(() => scopedConfig(defaultConfig, definition({ mcp: { only: ["not_enabled"] } }))).toThrow("outside")
  for (const raw of [{ unknown: true }, { budgetTokens: -1 }, { mcp: "implicit" }, { tools: ["*"] }])
    expect(() => definition(raw)).toThrow()
})

test("budget reservations include ancestry and unknown usage stops subsequent requests", async () => {
  const parent = new ChildBudget(10000, 30000),
    child = new ChildBudget(9000, 30000, parent)
  const model = {
    id: "test",
    displayName: "Test",
    provider: "openai",
    protocol: "openai" as const,
    contextWindow: 10000,
    maxOutputTokens: 100,
    isDefault: true,
    supportsReasoning: false,
  }
  const client: ProviderClient = {
    id: "openai",
    models: [model],
    async *stream() {
      expect(parent.reserved).toBeGreaterThan(100)
      yield { type: "usage", usage: { inputTokens: 7, outputTokens: 3 } }
      yield { type: "done", stopReason: "end_turn" }
    },
  }
  const request = { model, system: "test", messages: [], tools: [] }
  for await (const _ of child.wrap(client).stream(request, new AbortController().signal)) {
  }
  expect(parent.used).toBe(10)
  expect(child.used).toBe(10)
  expect(parent.reserved).toBe(0)
  const unknown: ProviderClient = {
    ...client,
    async *stream() {
      yield { type: "done", stopReason: "end_turn" }
    },
  }
  const consume = async () => {
    for await (const _ of child.wrap(unknown).stream(request, new AbortController().signal)) {
    }
  }
  await expect(consume()).rejects.toThrow("unknown")
  await expect(consume()).rejects.toThrow("uncertain")
})

test("agent CLI creates disabled definitions, shows exact fingerprints and activates only reviewed bytes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cs-agent-cli-")))
  await mkdir(join(root, "config"))
  let output = ""
  const options = {
    cwd: root,
    configPath: join(root, "config", "config.toml"),
    userRoot: join(root, "user"),
    dataDir: join(root, "data"),
    output: (text: string) => {
      output = text
    },
  }
  try {
    await runAgentsCommand(["create", "reviewer", "--write"], options)
    expect(
      parseAgentMarkdown(await Bun.file(join(root, ".codesplash/agents/reviewer.md")).text(), "reviewer")
        .enabled,
    ).toBe(false)
    await runAgentsCommand(["show", "project/reviewer", "--trust"], options)
    const review = JSON.parse(output) as ResolvedAgent
    await expect(
      runAgentsCommand(["enable", "project/reviewer", "--fingerprint", "0".repeat(64), "--trust"], options),
    ).rejects.toThrow("fingerprint")
    await runAgentsCommand(
      ["enable", "project/reviewer", "--fingerprint", review.fingerprint, "--trust"],
      options,
    )
    expect(
      parseAgentMarkdown(await Bun.file(join(root, ".codesplash/agents/reviewer.md")).text(), "reviewer")
        .enabled,
    ).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("agent migration maps reviewed native semantics and leaves executable definitions disabled", async () => {
  const { previewImport, applyImport } = await import("../../../src/commands/import.ts")
  const root = await realpath(await mkdtemp(join(tmpdir(), "cs-agent-import-"))),
    source = join(root, "source"),
    target = join(root, "target")
  await mkdir(join(source, ".claude/agents"), { recursive: true })
  await mkdir(target)
  await Bun.write(
    join(source, ".claude/agents/review.md"),
    "---\nname: review\ndescription: Review code\ntools: Read, Grep\npermissionMode: plan\n---\nReview carefully.",
  )
  await Bun.write(
    join(source, ".claude/agents/unsafe.md"),
    "---\ndescription: Unsafe\nhooks: arbitrary\n---\nTask",
  )
  try {
    const preview = await previewImport("claude", source, target)
    expect(preview.files).toHaveLength(1)
    expect(preview.unsupported.join("\n")).toContain("Unsupported agent settings")
    await applyImport(preview)
    const definition = parseAgentMarkdown(
      await Bun.file(join(target, ".codesplash/agents/review.md")).text(),
      "review",
    )
    expect(definition.enabled).toBe(false)
    expect(definition.tools).toEqual(["read_file", "grep"])
    expect(definition.mode).toBe("plan")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
