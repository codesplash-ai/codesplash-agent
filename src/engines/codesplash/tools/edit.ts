/**
 * edit_file: exact-match replacement with a whitespace-normalized line-window fallback. Ambiguous
 * or missing matches raise ToolInputError naming the closest candidate line. mutatedPaths=[path].
 * Permission follows the policy table: read-only sandbox refuses, workspace-write asks outside cwd
 * (always under untrusted), danger-full-access never asks.
 */
import { realpathSync } from "node:fs"
import { readFile, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import {
  type HarnessTool,
  type ToolContext,
  ToolInputError,
  type ToolOutcome,
  type ToolPermission,
} from "../contracts.ts"

const MAX_LISTED_MATCHES = 6
const MAX_CANDIDATE_LINES = 20000
const MAX_CANDIDATE_LINE_LENGTH = 200

type EditInput = {
  path: string
  oldString: string
  newString: string
  replaceAll: boolean
}

function parseInput(input: unknown): EditInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolInputError(
      "edit_file expects an object input: { path, old_string, new_string, replace_all? }",
    )
  }
  const { path, old_string, new_string, replace_all } = input as Record<string, unknown>
  if (typeof path !== "string" || path.length === 0) {
    throw new ToolInputError("edit_file requires path to be a non-empty string")
  }
  if (typeof old_string !== "string" || old_string.length === 0) {
    throw new ToolInputError("edit_file requires old_string to be a non-empty string")
  }
  if (typeof new_string !== "string") {
    throw new ToolInputError("edit_file requires new_string to be a string")
  }
  if (old_string === new_string) {
    throw new ToolInputError("edit_file requires old_string and new_string to differ")
  }
  if (replace_all !== undefined && typeof replace_all !== "boolean") {
    throw new ToolInputError("edit_file replace_all must be a boolean")
  }
  return { path, oldString: old_string, newString: new_string, replaceAll: replace_all === true }
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

/** Physical containment: a symlink inside the workspace must not smuggle edits outside it. */
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
    throw new ToolInputError(`edit_file: the harness sandbox is read-only; refusing to modify ${display}`)
  }
}

function normalizeLine(line: string): string {
  return line.replace(/\s+/g, " ").trim()
}

function exactOccurrences(content: string, oldString: string): number[] {
  const positions: number[] = []
  let from = 0
  while (true) {
    const position = content.indexOf(oldString, from)
    if (position === -1) break
    positions.push(position)
    from = position + oldString.length
  }
  return positions
}

function lineNumberAt(content: string, position: number): number {
  let line = 1
  for (let index = 0; index < position; index++) {
    if (content.charCodeAt(index) === 10) line += 1
  }
  return line
}

function normalizedWindowMatches(contentLines: string[], normalizedOld: string[]): number[] {
  const starts: number[] = []
  for (let start = 0; start + normalizedOld.length <= contentLines.length; start++) {
    let matched = true
    for (let index = 0; index < normalizedOld.length; index++) {
      if (normalizeLine(contentLines[start + index] ?? "") !== normalizedOld[index]) {
        matched = false
        break
      }
    }
    if (matched) starts.push(start)
  }
  return starts
}

function bigramCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (let index = 0; index < text.length - 1; index++) {
    const gram = text.slice(index, index + 2)
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  return counts
}

function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const gramsA = bigramCounts(a)
  const gramsB = bigramCounts(b)
  let overlap = 0
  for (const [gram, count] of gramsA) overlap += Math.min(count, gramsB.get(gram) ?? 0)
  return (2 * overlap) / (a.length - 1 + b.length - 1)
}

function closestCandidate(
  contentLines: string[],
  normalizedOld: string[],
): { line: number; text: string } | undefined {
  const target =
    normalizedOld.find((line) => line !== "")?.slice(0, MAX_CANDIDATE_LINE_LENGTH) ??
    normalizedOld.join(" ").trim().slice(0, MAX_CANDIDATE_LINE_LENGTH)
  if (target === "") return undefined
  let best: { line: number; text: string } | undefined
  let bestScore = -1
  const limit = Math.min(contentLines.length, MAX_CANDIDATE_LINES)
  for (let index = 0; index < limit; index++) {
    const original = contentLines[index] ?? ""
    const normalized = normalizeLine(original).slice(0, MAX_CANDIDATE_LINE_LENGTH)
    if (normalized === "") continue
    const score = similarity(target, normalized)
    if (score > bestScore) {
      bestScore = score
      best = { line: index + 1, text: original.trim() }
    }
  }
  return best
}

function ambiguityError(display: string, lineNumbers: number[], total: number): ToolInputError {
  const listed = lineNumbers.slice(0, MAX_LISTED_MATCHES)
  const ellipsis = total > listed.length ? ", …" : ""
  return new ToolInputError(
    `edit_file: old_string matches ${total} locations in ${display} (lines ${listed.join(", ")}${ellipsis}); ` +
      `the closest candidate is line ${listed[0]}. Add more surrounding context to make the match ` +
      "unique, or set replace_all to true.",
  )
}

function notFoundError(display: string, contentLines: string[], normalizedOld: string[]): ToolInputError {
  const candidate = closestCandidate(contentLines, normalizedOld)
  const detail =
    candidate === undefined
      ? ""
      : `; the closest candidate is line ${candidate.line}: ${JSON.stringify(candidate.text)}`
  return new ToolInputError(`edit_file: old_string was not found in ${display}${detail}`)
}

type EditResult = { content: string; count: number; normalized: boolean }

function applyEdit(content: string, input: EditInput, display: string): EditResult {
  const positions = exactOccurrences(content, input.oldString)
  if (positions.length > 0) {
    if (input.replaceAll) {
      return {
        content: content.split(input.oldString).join(input.newString),
        count: positions.length,
        normalized: false,
      }
    }
    if (positions.length > 1) {
      const lineNumbers = positions
        .slice(0, MAX_LISTED_MATCHES)
        .map((position) => lineNumberAt(content, position))
      throw ambiguityError(display, lineNumbers, positions.length)
    }
    const position = positions[0] ?? 0
    return {
      content:
        content.slice(0, position) + input.newString + content.slice(position + input.oldString.length),
      count: 1,
      normalized: false,
    }
  }

  const contentLines = content.split("\n")
  const oldLines = input.oldString.split("\n")
  const normalizedOld = oldLines.map(normalizeLine)
  if (normalizedOld.every((line) => line === "")) {
    throw notFoundError(display, contentLines, normalizedOld)
  }

  const starts = normalizedWindowMatches(contentLines, normalizedOld)
  if (starts.length === 0) throw notFoundError(display, contentLines, normalizedOld)
  if (starts.length > 1 && !input.replaceAll) {
    throw ambiguityError(
      display,
      starts.slice(0, MAX_LISTED_MATCHES).map((start) => start + 1),
      starts.length,
    )
  }

  const newLines = input.newString.split("\n")
  const applied: number[] = []
  let nextFree = 0
  for (const start of starts) {
    if (start >= nextFree) {
      applied.push(start)
      nextFree = start + oldLines.length
    }
  }
  for (const start of [...applied].reverse()) {
    contentLines.splice(start, oldLines.length, ...newLines)
  }
  return { content: contentLines.join("\n"), count: applied.length, normalized: true }
}

async function runEdit(input: EditInput, context: ToolContext): Promise<ToolOutcome> {
  const resolved = resolve(context.cwd, input.path)
  const display = displayPath(resolved, context.cwd)
  requireMutationsAllowed(context, display)

  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(resolved)
  } catch {
    throw new ToolInputError(`edit_file: ${display} does not exist`)
  }
  if (info.isDirectory()) {
    throw new ToolInputError(`edit_file: ${display} is a directory, not a file`)
  }

  const content = await readFile(resolved, { encoding: "utf8", signal: context.signal })
  const result = applyEdit(content, input, display)
  try {
    await writeFile(resolved, result.content, { encoding: "utf8", signal: context.signal })
  } catch (error) {
    throw new ToolInputError(
      `edit_file: could not write ${display}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const note = result.normalized ? " (matched after normalizing whitespace)" : ""
  return {
    text: `Edited ${display}: replaced ${result.count} occurrence${result.count === 1 ? "" : "s"}${note}`,
    label: display,
    mutatedPaths: [resolved],
  }
}

export const editFileTool: HarnessTool = {
  name: "edit_file",
  description:
    "Replace text in an existing file. old_string must match exactly (whitespace-normalized matching " +
    "is attempted as a fallback) and must be unique in the file unless replace_all is true. Include " +
    "enough surrounding context to make the match unique.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path, absolute or relative to the working directory.",
      },
      old_string: {
        type: "string",
        description: "Existing text to replace, copied exactly from the file.",
      },
      new_string: {
        type: "string",
        description: "Replacement text.",
      },
      replace_all: {
        type: "boolean",
        description: "Replace every occurrence instead of requiring a unique match. Defaults to false.",
      },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  isReadOnly: () => false,
  permission: mutationPermission,
  run: async (input, context) => runEdit(parseInput(input), context),
}
