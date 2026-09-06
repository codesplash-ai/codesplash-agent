/** Prompt assembly for the CodeSplash engine: project-rule discovery and the system prompt. */
import { realpath, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { registerChildProcess, type SessionPolicy } from "../../core/index.ts"
import type { ProjectRulesFile, SystemPromptOptions } from "./contracts.ts"

/** Per-file cap for a single AGENTS.md/CLAUDE.md. */
export const PROJECT_RULES_FILE_CAP_BYTES = 24 * 1024
/** Cap across all collected rule files. */
export const PROJECT_RULES_TOTAL_CAP_BYTES = 48 * 1024

const RULE_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const
const GIT_TOPLEVEL_TIMEOUT_MS = 10_000

/**
 * Collects AGENTS.md (preferred) or CLAUDE.md from each directory between the git repo root and
 * cwd inclusive, oldest ancestor first. Outside a repo only cwd itself is scanned.
 */
export async function discoverProjectRules(cwd: string): Promise<ProjectRulesFile[]> {
  const start = await resolveDirectory(cwd)
  const root = (await gitTopLevel(start)) ?? start
  const rules: ProjectRulesFile[] = []
  let remainingBytes = PROJECT_RULES_TOTAL_CAP_BYTES

  for (const directory of directoryChain(root, start)) {
    if (remainingBytes <= 0) break
    const file = await readRuleFile(directory)
    if (!file) continue
    const text = truncateToBytes(file.text, Math.min(PROJECT_RULES_FILE_CAP_BYTES, remainingBytes))
    if (text.length === 0) continue
    remainingBytes -= Buffer.byteLength(text, "utf8")
    rules.push({ path: file.path, text })
  }

  return rules
}

/** Builds the system prompt: identity, environment, policy summary, tool guidance, project rules. */
export async function buildSystemPrompt(options: SystemPromptOptions): Promise<string> {
  const workspaceTrusted = options.workspaceTrusted !== false
  // An untrusted folder's rule files are not the user's vetted instructions: discovery is skipped
  // ENTIRELY (never read, never truncated in) and the prompt says so instead of silently omitting.
  const rules = workspaceTrusted ? await discoverProjectRules(options.cwd) : []

  const sections = [
    "You are CodeSplash Agent, a coding harness running in a terminal. You complete the user's coding tasks by inspecting and editing their workspace with the tools below.",
    [
      `Working directory: ${options.cwd}`,
      `Platform: ${process.platform}`,
      `Today's date: ${localDate()}`,
      `Model: ${options.model.id}`,
    ].join("\n"),
    policySummary(options.policy),
    [
      `Available tools: ${options.toolNames.join(", ")}`,
      "",
      "Tool guidance:",
      "- Prefer the read and edit tools over bash for inspecting and changing files.",
      "- Keep edits minimal and scoped to the task.",
      "- Do not run destructive commands unless the task requires them.",
    ].join("\n"),
  ]

  if (options.permissionMode === "plan") sections.push(planModeSection())

  if (rules.length > 0) {
    const blocks = rules.map((rule) => `### ${rule.path}\n\n${rule.text}`)
    sections.push(`## Project instructions\n\n${blocks.join("\n\n")}`)
  } else if (!workspaceTrusted) {
    sections.push(
      "## Project instructions\n\nNot loaded: this workspace folder is untrusted, so project rule files (AGENTS.md/CLAUDE.md) were skipped.",
    )
  }

  return sections.join("\n\n")
}

/** Read-only posture, the plan file's path, and how to leave plan mode. */
function planModeSection(): string {
  return [
    "## Plan mode",
    "",
    "Plan mode is on: work read-only while you investigate. Write your implementation plan to",
    ".codesplash/plan.md (the only file you may write in this mode), then call exit_plan_mode to",
    "ask the user to approve it. Other mutating tools and non-read-only bash commands are refused",
    "until the plan is approved.",
  ].join("\n")
}

/** Mirrors the permission-policy table enforced by the tools. */
function policySummary(policy: SessionPolicy): string {
  if (policy.sandbox === "read-only") {
    return "Sandbox policy: read-only. File writes and edits are refused; every bash command requires user approval."
  }
  if (policy.sandbox === "danger-full-access") {
    return "Sandbox policy: danger-full-access. All tools run without approval."
  }
  if (policy.approvalPolicy === "untrusted") {
    return "Sandbox policy: workspace-write with untrusted approvals. Every file write, edit, and bash command requires user approval."
  }
  return "Sandbox policy: workspace-write with on-request approvals. File writes inside the working directory run without approval; writes outside it and bash commands require user approval."
}

function localDate(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  return `${now.getFullYear()}-${month}-${day}`
}

async function resolveDirectory(cwd: string): Promise<string> {
  const absolute = resolve(cwd)
  try {
    return await realpath(absolute)
  } catch {
    return absolute
  }
}

async function gitTopLevel(cwd: string): Promise<string | undefined> {
  try {
    const { safeGitArguments, safeGitEnvironment } = await import("../../core/git-process.ts")
    const child = Bun.spawn(["git", ...safeGitArguments(["rev-parse", "--show-toplevel"])], {
      cwd,
      env: safeGitEnvironment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
    // A dying harness (crash, second Ctrl+C, process.exit) must not orphan the git child.
    const unregisterChild = registerChildProcess(child)
    const timer = setTimeout(() => child.kill(), GIT_TOPLEVEL_TIMEOUT_MS)
    try {
      const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
      if (exitCode !== 0) return undefined
      const line = output.trim()
      if (line.length === 0) return undefined
      return await resolveDirectory(line)
    } finally {
      clearTimeout(timer)
      unregisterChild()
    }
  } catch {
    return undefined
  }
}

/** Directories from root down to cwd inclusive; just [cwd] when root is not an ancestor. */
function directoryChain(root: string, cwd: string): string[] {
  const chain: string[] = []
  let current = cwd
  while (true) {
    chain.push(current)
    if (current === root) break
    const parent = dirname(current)
    if (parent === current) return [cwd]
    current = parent
  }
  chain.reverse()
  return chain
}

async function readRuleFile(directory: string): Promise<ProjectRulesFile | undefined> {
  for (const name of RULE_FILE_NAMES) {
    const path = join(directory, name)
    try {
      const stats = await stat(path)
      if (!stats.isFile()) continue
      const text = await Bun.file(path).text()
      if (text.trim().length === 0) continue
      return { path, text }
    } catch {
      // Unreadable candidate: fall through to the next name.
    }
  }
  return undefined
}

/** UTF-8 byte cap that never splits a code point. */
function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = low + Math.ceil((high - low) / 2)
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) low = mid
    else high = mid - 1
  }
  let cut = text.slice(0, low)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return cut
}
