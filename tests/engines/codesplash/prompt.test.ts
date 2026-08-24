import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionPolicy } from "../../../src/core/index.ts"
import type { ModelInfo } from "../../../src/engines/codesplash/contracts.ts"
import {
  buildSystemPrompt,
  discoverProjectRules,
  PROJECT_RULES_FILE_CAP_BYTES,
  PROJECT_RULES_TOTAL_CAP_BYTES,
} from "../../../src/engines/codesplash/prompt.ts"

const cleanups: string[] = []

afterAll(async () => {
  for (const path of cleanups) await rm(path, { recursive: true, force: true })
})

async function makeTempDir(): Promise<string> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "codesplash-prompt-")))
  cleanups.push(base)
  return base
}

async function gitInit(directory: string): Promise<void> {
  const child = Bun.spawn(["git", "init", "-q"], {
    cwd: directory,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`git init failed in ${directory}`)
}

const model: ModelInfo = {
  id: "claude-fable-5",
  displayName: "Claude Fable 5",
  provider: "anthropic",
  contextWindow: 200000,
  maxOutputTokens: 32000,
  isDefault: true,
  supportsReasoning: true,
}

const workspaceWrite: SessionPolicy = { sandbox: "workspace-write", approvalPolicy: "on-request" }

const toolNames = ["read_file", "write_file", "edit_file", "glob", "grep", "bash", "todo_write", "ask_user"]

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

describe("discoverProjectRules", () => {
  test("collects rules from the repo root down to cwd, oldest ancestor first", async () => {
    const repo = await makeTempDir()
    await gitInit(repo)
    await writeFile(join(repo, "AGENTS.md"), "Root rules here.")
    await mkdir(join(repo, "packages", "app"), { recursive: true })
    await writeFile(join(repo, "packages", "app", "CLAUDE.md"), "App rules here.")

    const rules = await discoverProjectRules(join(repo, "packages", "app"))

    expect(rules).toEqual([
      { path: join(repo, "AGENTS.md"), text: "Root rules here." },
      { path: join(repo, "packages", "app", "CLAUDE.md"), text: "App rules here." },
    ])
  })

  test("ignores rule files below cwd and outside the chain", async () => {
    const repo = await makeTempDir()
    await gitInit(repo)
    await mkdir(join(repo, "a", "deeper"), { recursive: true })
    await mkdir(join(repo, "sibling"), { recursive: true })
    await writeFile(join(repo, "a", "deeper", "AGENTS.md"), "Below cwd.")
    await writeFile(join(repo, "sibling", "AGENTS.md"), "Sibling branch.")
    await writeFile(join(repo, "a", "AGENTS.md"), "On the chain.")

    const rules = await discoverProjectRules(join(repo, "a"))

    expect(rules).toEqual([{ path: join(repo, "a", "AGENTS.md"), text: "On the chain." }])
  })

  test("prefers AGENTS.md over CLAUDE.md in the same directory", async () => {
    const repo = await makeTempDir()
    await gitInit(repo)
    await writeFile(join(repo, "AGENTS.md"), "Agents wins.")
    await writeFile(join(repo, "CLAUDE.md"), "Claude loses.")

    const rules = await discoverProjectRules(repo)

    expect(rules).toEqual([{ path: join(repo, "AGENTS.md"), text: "Agents wins." }])
  })

  test("falls back to CLAUDE.md when AGENTS.md is empty", async () => {
    const repo = await makeTempDir()
    await gitInit(repo)
    await writeFile(join(repo, "AGENTS.md"), "   \n")
    await writeFile(join(repo, "CLAUDE.md"), "Claude rules.")

    const rules = await discoverProjectRules(repo)

    expect(rules).toEqual([{ path: join(repo, "CLAUDE.md"), text: "Claude rules." }])
  })

  test("caps each file at 24KB without splitting code points", async () => {
    const repo = await makeTempDir()
    await gitInit(repo)
    // "a" then 3-byte snowmen: the cap lands mid-character and must back off cleanly.
    await writeFile(join(repo, "AGENTS.md"), `a${"☃".repeat(9000)}`)

    const rules = await discoverProjectRules(repo)

    expect(rules).toHaveLength(1)
    expect(rules[0]?.text).toBe(`a${"☃".repeat(8191)}`)
    expect(byteLength(rules[0]?.text ?? "")).toBeLessThanOrEqual(PROJECT_RULES_FILE_CAP_BYTES)
  })

  test("caps the collection at 48KB total, dropping files past the budget", async () => {
    const repo = await makeTempDir()
    await gitInit(repo)
    const twentyKb = "r".repeat(20 * 1024)
    await mkdir(join(repo, "a", "b", "c"), { recursive: true })
    await writeFile(join(repo, "AGENTS.md"), twentyKb)
    await writeFile(join(repo, "a", "AGENTS.md"), twentyKb)
    await writeFile(join(repo, "a", "b", "AGENTS.md"), twentyKb)
    await writeFile(join(repo, "a", "b", "c", "AGENTS.md"), twentyKb)

    const rules = await discoverProjectRules(join(repo, "a", "b", "c"))

    expect(rules.map((rule) => rule.path)).toEqual([
      join(repo, "AGENTS.md"),
      join(repo, "a", "AGENTS.md"),
      join(repo, "a", "b", "AGENTS.md"),
    ])
    expect(byteLength(rules[0]?.text ?? "")).toBe(20 * 1024)
    expect(byteLength(rules[1]?.text ?? "")).toBe(20 * 1024)
    expect(byteLength(rules[2]?.text ?? "")).toBe(8 * 1024)
    const total = rules.reduce((sum, rule) => sum + byteLength(rule.text), 0)
    expect(total).toBe(PROJECT_RULES_TOTAL_CAP_BYTES)
  })

  test("scans only cwd when it is not inside a git repo", async () => {
    const base = await makeTempDir()
    await mkdir(join(base, "parent", "child"), { recursive: true })
    await writeFile(join(base, "parent", "CLAUDE.md"), "Parent rules.")
    await writeFile(join(base, "parent", "child", "CLAUDE.md"), "Child rules.")

    const rules = await discoverProjectRules(join(base, "parent", "child"))

    expect(rules).toEqual([{ path: join(base, "parent", "child", "CLAUDE.md"), text: "Child rules." }])
  })

  test("returns empty when no rule files exist", async () => {
    const repo = await makeTempDir()
    await gitInit(repo)

    expect(await discoverProjectRules(repo)).toEqual([])
  })
})

describe("buildSystemPrompt", () => {
  test("includes identity, environment, policy, tools, and project rules", async () => {
    const repo = await makeTempDir()
    await gitInit(repo)
    await writeFile(join(repo, "AGENTS.md"), "Always use tabs.")

    const prompt = await buildSystemPrompt({ cwd: repo, model, policy: workspaceWrite, toolNames })

    expect(prompt).toContain("CodeSplash Agent, a coding harness running in a terminal")
    expect(prompt).toContain(`Working directory: ${repo}`)
    expect(prompt).toContain(`Platform: ${process.platform}`)
    expect(prompt).toMatch(/Today's date: \d{4}-\d{2}-\d{2}/)
    expect(prompt).toContain("Model: claude-fable-5")
    expect(prompt).toContain("workspace-write")
    expect(prompt).toContain("bash commands require user approval")
    for (const name of toolNames) expect(prompt).toContain(name)
    expect(prompt).toContain("Project instructions")
    expect(prompt).toContain(join(repo, "AGENTS.md"))
    expect(prompt).toContain("Always use tabs.")
  })

  test("summarizes each policy row from the permission table", async () => {
    const cwd = await makeTempDir()
    const promptFor = (policy: SessionPolicy) => buildSystemPrompt({ cwd, model, policy, toolNames })

    const readOnly = await promptFor({ sandbox: "read-only", approvalPolicy: "on-request" })
    expect(readOnly).toContain("read-only")
    expect(readOnly).toContain("refused")
    expect(readOnly).toContain("every bash command requires user approval")

    const onRequest = await promptFor({ sandbox: "workspace-write", approvalPolicy: "on-request" })
    expect(onRequest).toContain("workspace-write with on-request approvals")
    expect(onRequest).toContain("inside the working directory run without approval")

    const untrusted = await promptFor({ sandbox: "workspace-write", approvalPolicy: "untrusted" })
    expect(untrusted).toContain("workspace-write with untrusted approvals")
    expect(untrusted).toContain("Every file write, edit, and bash command requires user approval")

    const fullAccess = await promptFor({ sandbox: "danger-full-access", approvalPolicy: "on-request" })
    expect(fullAccess).toContain("danger-full-access")
    expect(fullAccess).toContain("without approval")
  })

  test("omits the project instructions section when no rules exist", async () => {
    const cwd = await makeTempDir()

    const prompt = await buildSystemPrompt({ cwd, model, policy: workspaceWrite, toolNames })

    expect(prompt).not.toContain("Project instructions")
  })
})
