/**
 * `grep` harness tool: regex content search implemented in TS. Read-only under every policy.
 * Walks the working directory via Bun.Glob over `**\/*`, skipping `.git`, `node_modules`,
 * binary-looking files, and files over 1MB. Supports `-i`, a glob file filter, and context
 * lines; capped at 200 matching lines. Output is capped head+tail through truncateToolOutput
 * (2000 lines / 50KB with an elision marker).
 */
import { readFile, stat } from "node:fs/promises"
import { basename, isAbsolute, join } from "node:path"
import { type HarnessTool, type ToolContext, ToolInputError, type ToolOutcome } from "../contracts.ts"
import { truncateToolOutput } from "./truncate.ts"

const MAX_MATCHES = 200
const MAX_FILE_BYTES = 1024 * 1024
const BINARY_SNIFF_BYTES = 8192
const IGNORED_DIRECTORIES = new Set([".git", "node_modules"])

function isIgnoredPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((segment) => IGNORED_DIRECTORIES.has(segment))
}

type GrepInput = {
  pattern: string
  ignoreCase: boolean
  filter?: string
  contextLines: number
}

function parseGrepInput(input: unknown): GrepInput {
  if (typeof input !== "object" || input === null) {
    throw new ToolInputError("grep input must be an object with a `pattern` property")
  }
  const record = input as Record<string, unknown>
  const pattern = record.pattern
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new ToolInputError("grep requires a non-empty string `pattern`")
  }
  const ignoreCase = record["-i"] ?? false
  if (typeof ignoreCase !== "boolean") {
    throw new ToolInputError("grep `-i` must be a boolean")
  }
  const filter = record.glob
  if (filter !== undefined) {
    if (typeof filter !== "string" || filter.length === 0) {
      throw new ToolInputError("grep `glob` must be a non-empty string")
    }
    if (isAbsolute(filter) || filter.split(/[\\/]/).includes("..")) {
      throw new ToolInputError(
        "grep `glob` must stay relative to the working directory (no absolute paths or `..` segments)",
      )
    }
  }
  const contextLines = record.context ?? 0
  if (typeof contextLines !== "number" || !Number.isInteger(contextLines) || contextLines < 0) {
    throw new ToolInputError("grep `context` must be a non-negative integer")
  }
  return { pattern, ignoreCase, filter, contextLines }
}

/** Groups of output lines: match lines as `path:line:text`, context lines as `path-line-text`. */
function formatFileMatches(
  path: string,
  fileLines: string[],
  matchLines: number[],
  contextLines: number,
): string[][] {
  const matchSet = new Set(matchLines)
  const ranges: Array<[number, number]> = []
  for (const line of matchLines) {
    const start = Math.max(0, line - contextLines)
    const end = Math.min(fileLines.length - 1, line + contextLines)
    const last = ranges[ranges.length - 1]
    if (last !== undefined && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end)
    } else {
      ranges.push([start, end])
    }
  }
  return ranges.map(([start, end]) => {
    const group: string[] = []
    for (let index = start; index <= end; index += 1) {
      const separator = matchSet.has(index) ? ":" : "-"
      group.push(`${path}${separator}${index + 1}${separator}${fileLines[index] ?? ""}`)
    }
    return group
  })
}

export const grepTool: HarnessTool = {
  name: "grep",
  description:
    'Search file contents with a regular expression (JavaScript syntax). Walks the working directory, skipping .git, node_modules, binary-looking files, and files over 1MB. Supports "-i" (case-insensitive), a "glob" file filter, and "context" lines around matches. Returns at most 200 matching lines.',
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regular expression (JavaScript syntax) matched against each line.",
      },
      "-i": {
        type: "boolean",
        description: "Case-insensitive matching.",
      },
      glob: {
        type: "string",
        description: 'Only search files matching this glob, e.g. "*.ts" or "src/**".',
      },
      context: {
        type: "integer",
        minimum: 0,
        description: "Lines of context to include before and after each match.",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  isReadOnly: () => true,
  permission: () => ({ kind: "none" }),
  async run(input: unknown, context: ToolContext): Promise<ToolOutcome> {
    const { pattern, ignoreCase, filter, contextLines } = parseGrepInput(input)
    const label = filter === undefined ? `grep ${pattern}` : `grep ${pattern} ${filter}`

    let regex: RegExp
    try {
      regex = new RegExp(pattern, ignoreCase ? "i" : "")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new ToolInputError(`grep pattern is not a valid regular expression: ${message}`)
    }
    let filterGlob: Bun.Glob | undefined
    if (filter !== undefined) {
      try {
        filterGlob = new Bun.Glob(filter)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new ToolInputError(`grep \`glob\` is not a valid glob pattern: ${message}`)
      }
    }

    const candidates: string[] = []
    try {
      const walker = new Bun.Glob("**/*")
      for await (const relativePath of walker.scan({ cwd: context.cwd, dot: true, onlyFiles: true })) {
        if (context.signal.aborted) {
          return { text: "Search aborted before completion.", isError: true, label }
        }
        if (isIgnoredPath(relativePath)) continue
        if (
          filterGlob !== undefined &&
          !filterGlob.match(relativePath) &&
          !filterGlob.match(basename(relativePath))
        ) {
          continue
        }
        candidates.push(relativePath)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { text: `grep failed: ${message}`, isError: true, label }
    }
    candidates.sort()

    let matchCount = 0
    let capped = false
    let skippedByPermissions = 0
    const groups: string[][] = []
    for (const relativePath of candidates) {
      if (context.signal.aborted) {
        return { text: "Search aborted before completion.", isError: true, label }
      }
      const absolutePath = join(context.cwd, relativePath)
      // Sensitive-read denials (e.g. **/.env) apply to grep content access too: skip the file
      // before reading it and account for it in the summary line, never echoing its content.
      if (context.permissions?.isReadDenied(absolutePath, "grep") !== undefined) {
        skippedByPermissions += 1
        continue
      }
      let buffer: Buffer
      try {
        const info = await stat(absolutePath)
        if (info.size > MAX_FILE_BYTES) continue
        buffer = await readFile(absolutePath)
      } catch {
        // Unreadable or vanished; skip it.
        continue
      }
      if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) continue

      const fileLines = buffer.toString("utf8").split(/\r?\n/)
      if (fileLines[fileLines.length - 1] === "") fileLines.pop()

      const matchLines: number[] = []
      for (let index = 0; index < fileLines.length; index += 1) {
        if (!regex.test(fileLines[index] ?? "")) continue
        matchLines.push(index)
        matchCount += 1
        if (matchCount >= MAX_MATCHES) {
          capped = true
          break
        }
      }
      if (matchLines.length > 0) {
        groups.push(...formatFileMatches(relativePath, fileLines, matchLines, contextLines))
      }
      if (capped) break
    }

    const skippedNote =
      skippedByPermissions > 0 ? `(${skippedByPermissions} file(s) skipped by permission rules)` : undefined
    if (matchCount === 0) {
      const text = skippedNote === undefined ? "No matches found." : `No matches found.\n${skippedNote}`
      return { text, label }
    }
    const outputLines: string[] = []
    for (const [index, group] of groups.entries()) {
      if (contextLines > 0 && index > 0) outputLines.push("--")
      outputLines.push(...group)
    }
    if (capped) {
      outputLines.push(`[... stopped at the ${MAX_MATCHES}-match cap; further matches may be omitted ...]`)
    }
    if (skippedNote !== undefined) outputLines.push(skippedNote)
    return { text: truncateToolOutput(outputLines.join("\n")), label }
  },
}
