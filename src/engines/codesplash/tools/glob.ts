/**
 * `glob` harness tool: file-name search via Bun.Glob. Read-only under every policy; results are
 * cwd-relative, `.git` and `node_modules` are excluded, ordering is mtime descending, at most
 * 500 entries are returned.
 */
import { stat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { type HarnessTool, type ToolContext, ToolInputError, type ToolOutcome } from "../contracts.ts"
import { truncateToolOutput } from "./truncate.ts"

const MAX_ENTRIES = 500
const IGNORED_DIRECTORIES = new Set([".git", "node_modules"])

function isIgnoredPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((segment) => IGNORED_DIRECTORIES.has(segment))
}

function parseGlobInput(input: unknown): { pattern: string } {
  if (typeof input !== "object" || input === null) {
    throw new ToolInputError("glob input must be an object with a `pattern` property")
  }
  const { pattern } = input as Record<string, unknown>
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new ToolInputError("glob requires a non-empty string `pattern`")
  }
  if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) {
    throw new ToolInputError(
      "glob pattern must stay relative to the working directory (no absolute paths or `..` segments)",
    )
  }
  return { pattern }
}

export const globTool: HarnessTool = {
  name: "glob",
  description:
    'Find files by glob pattern (e.g. "src/**/*.ts"), relative to the working directory. Skips .git and node_modules. Returns at most 500 paths, most recently modified first.',
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: 'Glob pattern relative to the working directory, e.g. "src/**/*.ts".',
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  isReadOnly: () => true,
  permission: () => ({ kind: "none" }),
  async run(input: unknown, context: ToolContext): Promise<ToolOutcome> {
    const { pattern } = parseGlobInput(input)
    const label = `glob ${pattern}`
    const entries: Array<{ path: string; mtimeMs: number }> = []
    try {
      const glob = new Bun.Glob(pattern)
      for await (const relativePath of glob.scan({ cwd: context.cwd, dot: true, onlyFiles: true })) {
        if (context.signal.aborted) {
          return { text: "Search aborted before completion.", isError: true, label }
        }
        if (isIgnoredPath(relativePath)) continue
        try {
          const info = await stat(join(context.cwd, relativePath))
          entries.push({ path: relativePath, mtimeMs: info.mtimeMs })
        } catch {
          // Entry disappeared between scan and stat; skip it.
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { text: `glob failed: ${message}`, isError: true, label }
    }
    if (entries.length === 0) {
      return { text: "No files matched the pattern.", label }
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const lines = entries.slice(0, MAX_ENTRIES).map((entry) => entry.path)
    if (entries.length > MAX_ENTRIES) {
      lines.push(
        `[... ${entries.length - MAX_ENTRIES} more entries omitted; showing the ${MAX_ENTRIES} most recently modified ...]`,
      )
    }
    return { text: truncateToolOutput(lines.join("\n")), label }
  },
}
