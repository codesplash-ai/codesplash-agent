/**
 * apply_patch: applies the Codex patch envelope (*** Begin Patch ... *** End Patch) across one or
 * more files — add, update (multi-hunk, optional move), delete. Hunks match exactly first, then
 * fall back to whitespace-normalized line matching like edit_file. Every hunk is verified before
 * anything is written, so a non-applying patch mutates nothing. Permission mirrors write_file per
 * affected path: read-only sandbox refuses, workspace-write asks when any touched path is outside
 * cwd (always under untrusted), danger-full-access never asks; the approval detail lists every
 * touched path.
 */
import { realpathSync } from "node:fs"
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import {
  type HarnessTool,
  type ToolContext,
  ToolInputError,
  type ToolOutcome,
  type ToolPermission,
} from "../contracts.ts"
import { truncateToolOutput } from "./truncate.ts"

const BEGIN_MARKER = "*** Begin Patch"
const END_MARKER = "*** End Patch"
const EOF_MARKER = "*** End of File"
const ADD_PREFIX = "*** Add File: "
const UPDATE_PREFIX = "*** Update File: "
const DELETE_PREFIX = "*** Delete File: "
const MOVE_PREFIX = "*** Move to: "

/* ---------------------------------- input ---------------------------------- */

type ApplyPatchInput = { input: string }

function parseInput(input: unknown): ApplyPatchInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolInputError("apply_patch expects an object input: { input }")
  }
  const { input: patch } = input as Record<string, unknown>
  if (typeof patch !== "string" || patch.trim() === "") {
    throw new ToolInputError("apply_patch requires input to be a non-empty patch string")
  }
  return { input: patch }
}

function patchTextFromInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  const { input: patch } = input as Record<string, unknown>
  return typeof patch === "string" && patch.trim() !== "" ? patch : undefined
}

/* ---------------------------------- envelope parser ---------------------------------- */

type Hunk = {
  /** Anchor text from an `@@ <context>` header; located in the file before matching the hunk. */
  contextHeader?: string
  /** Context + removed lines, in order, as they must appear in the file. */
  oldLines: string[]
  /** Context + added lines, in order, as they will appear after the hunk applies. */
  newLines: string[]
  /** Set by `*** End of File`: the hunk must match at the very end of the file. */
  atEndOfFile: boolean
}

type PatchOp =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: Hunk[] }

function parseError(lineNumber: number, line: string, reason: string): ToolInputError {
  return new ToolInputError(
    `apply_patch: invalid patch at line ${lineNumber} (${JSON.stringify(line)}): ${reason}`,
  )
}

function isDirective(line: string): boolean {
  return line.startsWith("*** ") || line.trimEnd() === EOF_MARKER || line.trimEnd() === END_MARKER
}

/** A unified-diff numeric header like `-12,7 +12,8 @@`; carried by some models, useless as an anchor. */
function isLineNumberHeader(header: string): boolean {
  return /^-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?(?:\s*@@.*)?$/.test(header)
}

function requirePath(line: string, prefix: string, lineNumber: number): string {
  const path = line.slice(prefix.length).trim()
  if (path === "") throw parseError(lineNumber, line, "missing file path")
  return path
}

function parseHunks(
  rawLines: string[],
  startIndex: number,
  path: string,
): { hunks: Hunk[]; nextIndex: number } {
  const hunks: Hunk[] = []
  let index = startIndex
  let current: Hunk | undefined

  const flush = () => {
    if (
      current !== undefined &&
      (current.oldLines.length > 0 || current.newLines.length > 0 || current.contextHeader !== undefined)
    ) {
      hunks.push(current)
    }
    current = undefined
  }

  while (index < rawLines.length) {
    const line = rawLines[index] ?? ""
    if (line.trimEnd() === EOF_MARKER) {
      if (current === undefined) {
        throw parseError(index + 1, line, `"${EOF_MARKER}" must follow a hunk`)
      }
      current.atEndOfFile = true
      flush()
      index += 1
      continue
    }
    if (line.startsWith("*** ")) break
    if (line.trimEnd() === "@@" || line.startsWith("@@ ")) {
      flush()
      const rawHeader = line.trimEnd() === "@@" ? "" : line.slice(3).trim()
      const header = rawHeader === "" || isLineNumberHeader(rawHeader) ? undefined : rawHeader
      current = { contextHeader: header, oldLines: [], newLines: [], atEndOfFile: false }
      index += 1
      continue
    }
    if (current === undefined) current = { oldLines: [], newLines: [], atEndOfFile: false }
    if (line.startsWith("+")) {
      current.newLines.push(line.slice(1))
    } else if (line.startsWith("-")) {
      current.oldLines.push(line.slice(1))
    } else if (line.startsWith(" ")) {
      const text = line.slice(1)
      current.oldLines.push(text)
      current.newLines.push(text)
    } else if (line === "") {
      current.oldLines.push("")
      current.newLines.push("")
    } else {
      throw parseError(index + 1, line, `hunk lines in ${path} must start with " ", "-", "+", or "@@"`)
    }
    index += 1
  }
  flush()
  return { hunks, nextIndex: index }
}

function parsePatch(patchText: string): PatchOp[] {
  const rawLines = patchText.replaceAll("\r\n", "\n").split("\n")
  while (rawLines.length > 0 && (rawLines[rawLines.length - 1] ?? "").trim() === "") rawLines.pop()

  let index = 0
  while (index < rawLines.length && (rawLines[index] ?? "").trim() === "") index += 1
  if ((rawLines[index] ?? "").trimEnd() !== BEGIN_MARKER) {
    throw new ToolInputError(`apply_patch: the patch must start with "${BEGIN_MARKER}"`)
  }
  index += 1

  const ops: PatchOp[] = []
  while (index < rawLines.length) {
    const line = rawLines[index] ?? ""
    if (line.trimEnd() === END_MARKER) {
      if (index + 1 !== rawLines.length) {
        throw parseError(index + 2, rawLines[index + 1] ?? "", `content after "${END_MARKER}"`)
      }
      return ops
    }
    if (line.startsWith(ADD_PREFIX)) {
      const path = requirePath(line, ADD_PREFIX, index + 1)
      index += 1
      const lines: string[] = []
      while (index < rawLines.length && !isDirective(rawLines[index] ?? "")) {
        const body = rawLines[index] ?? ""
        if (body.startsWith("+")) {
          lines.push(body.slice(1))
        } else if (body === "") {
          lines.push("")
        } else {
          throw parseError(index + 1, body, `added lines for ${path} must start with "+"`)
        }
        index += 1
      }
      ops.push({ kind: "add", path, lines })
      continue
    }
    if (line.startsWith(DELETE_PREFIX)) {
      ops.push({ kind: "delete", path: requirePath(line, DELETE_PREFIX, index + 1) })
      index += 1
      continue
    }
    if (line.startsWith(UPDATE_PREFIX)) {
      const path = requirePath(line, UPDATE_PREFIX, index + 1)
      index += 1
      let moveTo: string | undefined
      if (index < rawLines.length && (rawLines[index] ?? "").startsWith(MOVE_PREFIX)) {
        moveTo = requirePath(rawLines[index] ?? "", MOVE_PREFIX, index + 1)
        index += 1
      }
      const { hunks, nextIndex } = parseHunks(rawLines, index, path)
      index = nextIndex
      if (hunks.length === 0 && moveTo === undefined) {
        throw new ToolInputError(`apply_patch: the update for ${path} contains no hunks`)
      }
      ops.push({ kind: "update", path, moveTo, hunks })
      continue
    }
    throw parseError(index + 1, line, "expected a *** directive")
  }
  throw new ToolInputError(`apply_patch: the patch is missing its closing "${END_MARKER}"`)
}

/* ---------------------------------- hunk application ---------------------------------- */

function normalizeLine(line: string): string {
  return line.replace(/\s+/g, " ").trim()
}

function matchesAt(fileLines: string[], oldLines: string[], start: number, normalized: boolean): boolean {
  for (let index = 0; index < oldLines.length; index += 1) {
    const fileLine = fileLines[start + index]
    const oldLine = oldLines[index] ?? ""
    if (fileLine === undefined) return false
    if (normalized ? normalizeLine(fileLine) !== normalizeLine(oldLine) : fileLine !== oldLine) {
      return false
    }
  }
  return true
}

function findHunkStart(
  fileLines: string[],
  hunk: Hunk,
  from: number,
): { start: number; normalized: boolean } | undefined {
  const lastStart = fileLines.length - hunk.oldLines.length
  if (hunk.atEndOfFile) {
    if (lastStart < from || lastStart < 0) return undefined
    if (matchesAt(fileLines, hunk.oldLines, lastStart, false)) return { start: lastStart, normalized: false }
    if (matchesAt(fileLines, hunk.oldLines, lastStart, true)) return { start: lastStart, normalized: true }
    return undefined
  }
  for (let start = from; start <= lastStart; start += 1) {
    if (matchesAt(fileLines, hunk.oldLines, start, false)) return { start, normalized: false }
  }
  for (let start = from; start <= lastStart; start += 1) {
    if (matchesAt(fileLines, hunk.oldLines, start, true)) return { start, normalized: true }
  }
  return undefined
}

/** The hunk line where matching first diverges, taken at the position with the longest matched prefix. */
function firstNonMatchingLine(fileLines: string[], oldLines: string[], from: number): string {
  let bestPrefix = 0
  for (let start = Math.max(0, from); start <= fileLines.length; start += 1) {
    let prefix = 0
    while (
      prefix < oldLines.length &&
      start + prefix < fileLines.length &&
      normalizeLine(fileLines[start + prefix] ?? "") === normalizeLine(oldLines[prefix] ?? "")
    ) {
      prefix += 1
    }
    if (prefix > bestPrefix) bestPrefix = prefix
  }
  return oldLines[Math.min(bestPrefix, oldLines.length - 1)] ?? ""
}

function locateContextHeader(
  fileLines: string[],
  header: string,
  from: number,
  display: string,
  hunkNumber: number,
): number {
  for (let index = from; index < fileLines.length; index += 1) {
    if (fileLines[index] === header) return index + 1
  }
  const normalizedHeader = normalizeLine(header)
  for (let index = from; index < fileLines.length; index += 1) {
    if (normalizeLine(fileLines[index] ?? "") === normalizedHeader) return index + 1
  }
  throw new ToolInputError(
    `apply_patch: hunk #${hunkNumber} does not apply to ${display}; ` +
      `the @@ context line was not found: ${JSON.stringify(header)}`,
  )
}

function applyHunks(
  content: string,
  hunks: Hunk[],
  display: string,
): { content: string; normalizedCount: number } {
  // CRLF files match with '\r' stripped (parsePatch already normalized the patch text to LF) so
  // exact matching works, and the result is re-serialized with CRLF so the patched region keeps
  // the file's line endings instead of leaving a mixed-EOL file behind.
  const usesCrlf = content.includes("\r\n")
  const lfContent = usesCrlf ? content.replaceAll("\r\n", "\n") : content
  const hadTrailingNewline = lfContent.endsWith("\n")
  const fileLines =
    lfContent === "" ? [] : (hadTrailingNewline ? lfContent.slice(0, -1) : lfContent).split("\n")
  let cursor = 0
  let normalizedCount = 0

  for (const [index, hunk] of hunks.entries()) {
    const hunkNumber = index + 1
    if (hunk.contextHeader !== undefined) {
      cursor = locateContextHeader(fileLines, hunk.contextHeader, cursor, display, hunkNumber)
    }
    let start: number
    if (hunk.oldLines.length === 0) {
      start = hunk.atEndOfFile ? fileLines.length : cursor
    } else {
      const match = findHunkStart(fileLines, hunk, cursor)
      if (match === undefined) {
        throw new ToolInputError(
          `apply_patch: hunk #${hunkNumber} does not apply to ${display}; first non-matching line: ` +
            JSON.stringify(firstNonMatchingLine(fileLines, hunk.oldLines, cursor)),
        )
      }
      start = match.start
      if (match.normalized) normalizedCount += 1
    }
    fileLines.splice(start, hunk.oldLines.length, ...hunk.newLines)
    cursor = start + hunk.newLines.length
  }

  const newContent =
    fileLines.length === 0 ? "" : fileLines.join("\n") + (hadTrailingNewline || lfContent === "" ? "\n" : "")
  return { content: usesCrlf ? newContent.replaceAll("\n", "\r\n") : newContent, normalizedCount }
}

/* ---------------------------------- path helpers (write_file-equivalent) ---------------------------------- */

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

/** Every workspace path an op touches, resolved; a move contributes both its source and target. */
function touchedPaths(ops: PatchOp[], cwd: string): string[] {
  const paths: string[] = []
  for (const op of ops) {
    paths.push(resolve(cwd, op.path))
    if (op.kind === "update" && op.moveTo !== undefined) paths.push(resolve(cwd, op.moveTo))
  }
  return [...new Set(paths)]
}

function patchPermission(input: unknown, context: ToolContext): ToolPermission {
  const patchText = patchTextFromInput(input)
  if (patchText === undefined) return { kind: "none" }
  let ops: PatchOp[]
  try {
    ops = parsePatch(patchText)
  } catch {
    return { kind: "none" }
  }
  const paths = touchedPaths(ops, context.cwd)
  if (paths.length === 0) return { kind: "none" }
  const approval: ToolPermission = {
    kind: "approval",
    title: "Apply file changes?",
    detail: paths.join("\n"),
  }
  switch (context.policy.sandbox) {
    case "read-only":
      return { kind: "none" }
    case "danger-full-access":
      return { kind: "none" }
    case "workspace-write":
      if (context.policy.approvalPolicy === "untrusted") return approval
      return paths.every((path) => isInsideCwd(path, context.cwd)) ? { kind: "none" } : approval
  }
}

/* ---------------------------------- staging and commit ---------------------------------- */

type StagedWrite = { resolved: string; display: string; content: string }
type StagedChange =
  | { kind: "write"; write: StagedWrite; removeAfterWrite?: string }
  | { kind: "delete"; resolved: string }

async function statOrUndefined(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(path)
  } catch {
    return undefined
  }
}

async function runApplyPatch(input: ApplyPatchInput, context: ToolContext): Promise<ToolOutcome> {
  const ops = parsePatch(input.input)
  if (ops.length === 0) {
    throw new ToolInputError("apply_patch: the patch contains no file operations")
  }

  const displays = touchedPaths(ops, context.cwd).map((path) => displayPath(path, context.cwd))
  if (context.policy.sandbox === "read-only") {
    throw new ToolInputError(
      `apply_patch: the harness sandbox is read-only; refusing to modify ${displays.join(", ")}`,
    )
  }

  // Stage every change first so a non-applying hunk anywhere in the patch mutates nothing.
  const changes: StagedChange[] = []
  const summary: string[] = []
  const labels: string[] = []
  const mutatedPaths: string[] = []

  // Staged view of the workspace, by resolved path (null = staged delete). Later ops read
  // through it so ops touching the same path compose — a second update sees the first update's
  // result and a delete-then-add rewrite works — instead of silently applying against the
  // original on-disk content.
  const staged = new Map<string, string | null>()
  const existsForPatch = async (path: string): Promise<boolean> => {
    const entry = staged.get(path)
    if (entry !== undefined) return entry !== null
    return (await statOrUndefined(path)) !== undefined
  }

  for (const op of ops) {
    const resolved = resolve(context.cwd, op.path)
    const display = displayPath(resolved, context.cwd)
    if (op.kind === "add") {
      if (await existsForPatch(resolved)) {
        throw new ToolInputError(`apply_patch: cannot add ${display}: the file already exists`)
      }
      const content = op.lines.length === 0 ? "" : `${op.lines.join("\n")}\n`
      staged.set(resolved, content)
      changes.push({ kind: "write", write: { resolved, display, content } })
      summary.push(`Added ${display}`)
      labels.push(display)
      mutatedPaths.push(resolved)
      continue
    }

    const stagedEntry = staged.get(resolved)
    if (stagedEntry === undefined) {
      const info = await statOrUndefined(resolved)
      if (info === undefined) {
        throw new ToolInputError(`apply_patch: cannot ${op.kind} ${display}: the file does not exist`)
      }
      if (info.isDirectory()) {
        throw new ToolInputError(`apply_patch: ${display} is a directory, not a file`)
      }
    } else if (stagedEntry === null) {
      throw new ToolInputError(`apply_patch: cannot ${op.kind} ${display}: the file does not exist`)
    }

    if (op.kind === "delete") {
      staged.set(resolved, null)
      changes.push({ kind: "delete", resolved })
      summary.push(`Deleted ${display}`)
      labels.push(display)
      mutatedPaths.push(resolved)
      continue
    }

    const content = stagedEntry ?? (await readFile(resolved, { encoding: "utf8", signal: context.signal }))
    const applied = applyHunks(content, op.hunks, display)
    const note = applied.normalizedCount > 0 ? " (matched after normalizing whitespace)" : ""
    if (op.moveTo === undefined) {
      staged.set(resolved, applied.content)
      changes.push({ kind: "write", write: { resolved, display, content: applied.content } })
      summary.push(`Updated ${display}${note}`)
      labels.push(display)
      mutatedPaths.push(resolved)
    } else {
      const target = resolve(context.cwd, op.moveTo)
      const targetDisplay = displayPath(target, context.cwd)
      if (target !== resolved) {
        // Never clobber a file the patch did not account for; a destination staged as deleted
        // earlier in the same patch is fair game.
        const targetEntry = staged.get(target)
        if (targetEntry === undefined) {
          const targetInfo = await statOrUndefined(target)
          if (targetInfo?.isDirectory() === true) {
            throw new ToolInputError(`apply_patch: move target ${targetDisplay} is a directory, not a file`)
          }
          if (targetInfo !== undefined) {
            throw new ToolInputError(
              `apply_patch: cannot move ${display} to ${targetDisplay}: the target file already exists`,
            )
          }
        } else if (targetEntry !== null) {
          throw new ToolInputError(
            `apply_patch: cannot move ${display} to ${targetDisplay}: the target file already exists`,
          )
        }
        staged.set(resolved, null)
      }
      staged.set(target, applied.content)
      changes.push({
        kind: "write",
        write: { resolved: target, display: targetDisplay, content: applied.content },
        removeAfterWrite: target === resolved ? undefined : resolved,
      })
      summary.push(`Updated ${display} -> ${targetDisplay} (moved)${note}`)
      labels.push(`${display} -> ${targetDisplay}`)
      mutatedPaths.push(resolved)
      if (target !== resolved) mutatedPaths.push(target)
    }
  }

  // Commit: every hunk has applied, so writes/deletes proceed in patch order.
  for (const change of changes) {
    try {
      if (change.kind === "delete") {
        await unlink(change.resolved)
      } else {
        await mkdir(dirname(change.write.resolved), { recursive: true })
        await writeFile(change.write.resolved, change.write.content, {
          encoding: "utf8",
          signal: context.signal,
        })
        if (change.removeAfterWrite !== undefined) await unlink(change.removeAfterWrite)
      }
    } catch (error) {
      const display =
        change.kind === "delete" ? displayPath(change.resolved, context.cwd) : change.write.display
      throw new ToolInputError(
        `apply_patch: could not apply changes to ${display}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return {
    text: truncateToolOutput(
      [`Applied patch to ${ops.length} file${ops.length === 1 ? "" : "s"}:`, ...summary].join("\n"),
    ),
    label: ops.length === 1 ? (labels[0] ?? "") : `${ops.length} files`,
    mutatedPaths: [...new Set(mutatedPaths)],
  }
}

export const applyPatchTool: HarnessTool = {
  name: "apply_patch",
  description:
    "Apply a patch to one or more files using the patch envelope format: '*** Begin Patch', then " +
    "'*** Add File: path' with '+' content lines, '*** Update File: path' (optionally followed by " +
    "'*** Move to: newpath') with hunks of ' ' context / '-' removed / '+' added lines separated by " +
    "'@@' headers, '*** Delete File: path', and finally '*** End Patch'. Use it for multi-file or " +
    "larger changes; prefer edit_file for single small edits.",
  inputSchema: {
    type: "object",
    properties: {
      input: {
        type: "string",
        description:
          "The full patch envelope, starting with '*** Begin Patch' and ending with '*** End Patch'.",
      },
    },
    required: ["input"],
    additionalProperties: false,
  },
  isReadOnly: () => false,
  permission: patchPermission,
  run: async (input, context) => runApplyPatch(parseInput(input), context),
}
