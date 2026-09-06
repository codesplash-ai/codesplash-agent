/** read_file: paged reads capped at 2000 lines / 50KB per call; directories and >5MB files refused. */
import { readFile, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import {
  type HarnessTool,
  type PermissionTargets,
  type ToolContext,
  ToolInputError,
  type ToolOutcome,
} from "../contracts.ts"

const MAX_LINES_PER_CALL = 2000
const MAX_BYTES_PER_CALL = 50 * 1024
const MAX_FILE_BYTES = 5 * 1024 * 1024

type ReadInput = { path: string; offset?: number; limit?: number }

function parseInput(input: unknown): ReadInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolInputError("read_file expects an object input: { path, offset?, limit? }")
  }
  const { path, offset, limit } = input as Record<string, unknown>
  if (typeof path !== "string" || path.length === 0) {
    throw new ToolInputError("read_file requires path to be a non-empty string")
  }
  if (offset !== undefined && (!Number.isInteger(offset) || (offset as number) < 1)) {
    throw new ToolInputError("read_file offset must be an integer of at least 1 (line numbers are 1-based)")
  }
  if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1)) {
    throw new ToolInputError("read_file limit must be an integer of at least 1")
  }
  return { path, offset: offset as number | undefined, limit: limit as number | undefined }
}

function displayPath(resolved: string, cwd: string): string {
  const relativePath = relative(cwd, resolved)
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath)
    ? relativePath
    : resolved
}

function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)}MB`
  if (size >= 1024) return `${(size / 1024).toFixed(1)}KB`
  return `${size} bytes`
}

function clipToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text
  return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8").replace(/�+$/, "")
}

async function runRead(input: ReadInput, context: ToolContext): Promise<ToolOutcome> {
  const resolved = resolve(context.cwd, input.path)
  const display = displayPath(resolved, context.cwd)

  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(resolved)
  } catch {
    throw new ToolInputError(`read_file: ${display} does not exist`)
  }
  if (info.isDirectory()) {
    throw new ToolInputError(`read_file: ${display} is a directory, not a file`)
  }
  if (info.size > MAX_FILE_BYTES) {
    throw new ToolInputError(
      `read_file: ${display} is ${formatBytes(info.size)}, over the 5MB cap for file reads`,
    )
  }

  const raw = await readFile(resolved, { encoding: "utf8", signal: context.signal })
  const content = context.sanitizeOutput?.(raw) ?? raw
  if (content === "") return { text: `${display} is an empty file`, label: display }

  const lines = content.split("\n")
  if (content.endsWith("\n")) lines.pop()
  const totalLines = lines.length
  const offset = input.offset ?? 1
  if (offset > totalLines) {
    throw new ToolInputError(
      `read_file: offset ${offset} is past the end of ${display} (${totalLines} line${totalLines === 1 ? "" : "s"})`,
    )
  }
  const limit = Math.min(input.limit ?? MAX_LINES_PER_CALL, MAX_LINES_PER_CALL)

  const output: string[] = []
  let bytes = 0
  let index = offset - 1
  let clippedLine = false
  while (index < totalLines && output.length < limit) {
    let line = lines[index] ?? ""
    let size = Buffer.byteLength(line, "utf8") + 1
    if (bytes + size > MAX_BYTES_PER_CALL) {
      if (output.length > 0) break
      line = clipToBytes(line, MAX_BYTES_PER_CALL - 1)
      size = Buffer.byteLength(line, "utf8") + 1
      clippedLine = true
    }
    output.push(`${String(index + 1).padStart(6)}\t${line}`)
    bytes += size
    index += 1
  }

  const lastLine = offset + output.length - 1
  let text = output.join("\n")
  if (clippedLine) text += `\n[line ${offset} clipped to fit the 50KB read cap]`
  if (lastLine < totalLines) {
    text += `\n[showing lines ${offset}-${lastLine} of ${totalLines}; continue with offset=${lastLine + 1}]`
  }
  return { text, label: display }
}

export const readFileTool: HarnessTool = {
  name: "read_file",
  description:
    "Read a file from the workspace. Returns line-numbered content. Reads are capped at 2000 lines and " +
    "50KB per call; page through larger files with offset (1-based start line) and limit (line count). " +
    "Directories and files over 5MB are refused.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path, absolute or relative to the working directory.",
      },
      offset: {
        type: "integer",
        minimum: 1,
        description: "1-based line number to start reading from. Defaults to 1.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        description: "Maximum number of lines to return. Defaults to 2000; capped at 2000.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  isReadOnly: () => true,
  permissionTargets: (input, context): PermissionTargets => ({
    paths: [resolve(context.cwd, parseInput(input).path)],
  }),
  permission: () => ({ kind: "none" }),
  run: async (input, context) => runRead(parseInput(input), context),
}
