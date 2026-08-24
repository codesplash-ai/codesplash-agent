/**
 * write_file: creates parent directories, reports bytes written, mutatedPaths=[path]. Permission
 * follows the policy table: read-only sandbox refuses, workspace-write asks outside cwd (always
 * under untrusted), danger-full-access never asks.
 */
import { realpathSync } from "node:fs"
import { mkdir, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import {
  type HarnessTool,
  type ToolContext,
  ToolInputError,
  type ToolOutcome,
  type ToolPermission,
} from "../contracts.ts"

type WriteInput = { path: string; content: string }

function parseInput(input: unknown): WriteInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolInputError("write_file expects an object input: { path, content }")
  }
  const { path, content } = input as Record<string, unknown>
  if (typeof path !== "string" || path.length === 0) {
    throw new ToolInputError("write_file requires path to be a non-empty string")
  }
  if (typeof content !== "string") {
    throw new ToolInputError("write_file requires content to be a string")
  }
  return { path, content }
}

function displayPath(resolved: string, cwd: string): string {
  const relativePath = relative(cwd, resolved)
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath)
    ? relativePath
    : resolved
}

/**
 * Resolves symlinks in the deepest existing ancestor of the path so containment checks are
 * physical rather than lexical; undefined when nothing along the path can be resolved.
 */
function physicalPath(path: string): string | undefined {
  let existing = path
  let suffix = ""
  while (true) {
    try {
      const real = realpathSync(existing)
      return suffix === "" ? real : join(real, suffix)
    } catch {
      const parent = dirname(existing)
      if (parent === existing) return undefined
      suffix = suffix === "" ? basename(existing) : join(basename(existing), suffix)
      existing = parent
    }
  }
}

/** Physical containment: a symlink inside the workspace must not smuggle writes outside it. */
function isInsideCwd(resolved: string, cwd: string): boolean {
  const realCwd = physicalPath(resolve(cwd))
  const realTarget = physicalPath(resolved)
  if (realCwd === undefined || realTarget === undefined) return false
  const relativePath = relative(realCwd, realTarget)
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
}

function pathFromInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  const { path } = input as Record<string, unknown>
  return typeof path === "string" && path.length > 0 ? path : undefined
}

function mutationPermission(input: unknown, context: ToolContext): ToolPermission {
  const path = pathFromInput(input)
  if (path === undefined) return { kind: "none" }
  const resolved = resolve(context.cwd, path)
  const approval: ToolPermission = { kind: "approval", title: "Apply file changes?", detail: resolved }
  switch (context.policy.sandbox) {
    case "read-only":
      return { kind: "none" }
    case "danger-full-access":
      return { kind: "none" }
    case "workspace-write":
      if (context.policy.approvalPolicy === "untrusted") return approval
      return isInsideCwd(resolved, context.cwd) ? { kind: "none" } : approval
  }
}

function requireMutationsAllowed(context: ToolContext, display: string): void {
  if (context.policy.sandbox === "read-only") {
    throw new ToolInputError(`write_file: the harness sandbox is read-only; refusing to modify ${display}`)
  }
}

async function runWrite(input: WriteInput, context: ToolContext): Promise<ToolOutcome> {
  const resolved = resolve(context.cwd, input.path)
  const display = displayPath(resolved, context.cwd)
  requireMutationsAllowed(context, display)

  try {
    const existing = await stat(resolved)
    if (existing.isDirectory()) {
      throw new ToolInputError(`write_file: ${display} is a directory, not a file`)
    }
  } catch (error) {
    if (error instanceof ToolInputError) throw error
  }

  const bytes = Buffer.byteLength(input.content, "utf8")
  try {
    await mkdir(dirname(resolved), { recursive: true })
    await writeFile(resolved, input.content, { encoding: "utf8", signal: context.signal })
  } catch (error) {
    throw new ToolInputError(
      `write_file: could not write ${display}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  return {
    text: `Wrote ${bytes} byte${bytes === 1 ? "" : "s"} to ${display}`,
    label: display,
    mutatedPaths: [resolved],
  }
}

export const writeFileTool: HarnessTool = {
  name: "write_file",
  description:
    "Write a file in the workspace, replacing any existing content. Parent directories are created " +
    "as needed. Prefer edit_file for small changes to existing files.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path, absolute or relative to the working directory.",
      },
      content: {
        type: "string",
        description: "Full content to write.",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  isReadOnly: () => false,
  permission: mutationPermission,
  run: async (input, context) => runWrite(parseInput(input), context),
}
