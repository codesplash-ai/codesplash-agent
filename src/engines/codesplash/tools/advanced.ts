import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { bytes } from "../../../core/session/files.ts"
import type { HarnessTool, ToolContext } from "../contracts.ts"
import { ToolInputError } from "../contracts.ts"
import { truncateToolOutput } from "./truncate.ts"
import { writeFileTool } from "./write.ts"

const hash = (text: string) => createHash("sha256").update(text).digest("hex")
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ToolInputError("Expected tool object")
  return value as Record<string, unknown>
}
function string(value: unknown, max = 65536): string {
  if (typeof value !== "string" || value.length > max) throw new ToolInputError("Expected bounded text")
  return value
}
const path = (input: unknown, context: ToolContext) => resolve(context.cwd, string(object(input).path, 4096))
const mutation = {
  isReadOnly: () => false,
  permissionTargets: (input: unknown, context: ToolContext) => ({ paths: [path(input, context)] }),
  permission: writeFileTool.permission,
  permissionName: "write_file",
}
export const notebookTool: HarnessTool = {
  ...mutation,
  name: "notebook_edit",
  description:
    "Edit one notebook cell by stable cell id with an exact file SHA-256 precondition; clears code outputs, never executes cells.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      sha256: { type: "string" },
      cell_id: { type: "string" },
      operation: { enum: ["replace", "insert_after", "delete"] },
      source: { type: "string" },
      cell_type: { enum: ["code", "markdown"] },
    },
    required: ["path", "sha256", "cell_id", "operation"],
    additionalProperties: false,
  },
  async run(input, context) {
    const p = object(input),
      file = path(input, context)
    if (context.policy.sandbox === "read-only") throw new ToolInputError("Notebook editing requires writes")
    const original = bytes(file, 2 * 1024 * 1024).toString()
    if (Buffer.byteLength(original) > 2 * 1024 * 1024 || hash(original) !== p.sha256)
      throw new ToolInputError("Notebook changed or exceeds 2 MiB; read it again")
    const notebook = JSON.parse(original)
    if (notebook.nbformat !== 4 || !Array.isArray(notebook.cells) || notebook.cells.length > 10000)
      throw new ToolInputError("Unsupported notebook")
    const matches = notebook.cells
      .map((cell: { id?: string }, i: number) => (cell.id === p.cell_id ? i : -1))
      .filter((i: number) => i >= 0)
    if (matches.length !== 1) throw new ToolInputError("Notebook cell id must match exactly once")
    const index = matches[0],
      source = string(p.source ?? "").split(/(?<=\n)/)
    if (p.operation === "delete") notebook.cells.splice(index, 1)
    else if (p.operation === "insert_after")
      notebook.cells.splice(index + 1, 0, {
        id: crypto.randomUUID(),
        cell_type: p.cell_type === "markdown" ? "markdown" : "code",
        metadata: {},
        source,
        ...(p.cell_type === "markdown" ? {} : { outputs: [], execution_count: null }),
      })
    else if (p.operation === "replace") {
      const cell = notebook.cells[index]
      cell.source = source
      if (cell.cell_type === "code") {
        cell.outputs = []
        cell.execution_count = null
      }
    } else throw new ToolInputError("Unknown notebook operation")
    context.signal.throwIfAborted()
    if (hash(bytes(file, 2 * 1024 * 1024).toString()) !== p.sha256)
      throw new ToolInputError("Notebook changed during edit")
    const next = JSON.stringify(notebook, null, 2) + "\n"
    if (Buffer.byteLength(next) > 2 * 1024 * 1024) throw new ToolInputError("Edited notebook exceeds 2 MiB")
    await writeFile(file, next)
    return { text: `Notebook updated; sha256=${hash(next)}`, label: "Edit notebook", mutatedPaths: [file] }
  },
}
export const anchorReadTool: HarnessTool = {
  name: "read_anchors",
  description: "Read numbered lines with content hash anchors and an exact file SHA-256 for safe edits.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
  isReadOnly: () => true,
  permissionName: "read_file",
  permission: () => ({ kind: "none" }),
  permissionTargets: (input, context) => ({ paths: [path(input, context)] }),
  async run(input, context) {
    const content = bytes(path(input, context), 1024 * 1024).toString()
    if (Buffer.byteLength(content) > 1024 * 1024) throw new ToolInputError("Anchor file exceeds 1 MiB")
    const clean = context.sanitizeOutput?.(content) ?? content
    if (clean !== content) throw new ToolInputError("Anchor reads refuse redacted files")
    return {
      text: truncateToolOutput(
        `sha256=${hash(content)}\n${content
          .split("\n")
          .map((line, i) => `${i + 1}:${hash(line).slice(0, 12)}|${line}`)
          .join("\n")}`,
      ),
      label: "Read anchors",
    }
  },
}
export const anchorEditTool: HarnessTool = {
  ...mutation,
  name: "edit_anchors",
  description: "Replace an inclusive line range only if file SHA-256 and both line hashes still match.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      sha256: { type: "string" },
      start: { type: "integer", minimum: 1 },
      end: { type: "integer", minimum: 1 },
      start_hash: { type: "string" },
      end_hash: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "sha256", "start", "end", "start_hash", "end_hash", "content"],
    additionalProperties: false,
  },
  async run(input, context) {
    const p = object(input),
      file = path(input, context)
    if (context.policy.sandbox === "read-only") throw new ToolInputError("Anchor editing requires writes")
    const original = bytes(file, 1024 * 1024).toString(),
      lines = original.split("\n"),
      start = Number(p.start),
      end = Number(p.end)
    if (
      original.length > 1024 * 1024 ||
      hash(original) !== p.sha256 ||
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 1 ||
      end < start ||
      end > lines.length ||
      hash(lines[start - 1]!).slice(0, 12) !== p.start_hash ||
      hash(lines[end - 1]!).slice(0, 12) !== p.end_hash
    )
      throw new ToolInputError("Stale or invalid anchors; read the file again")
    lines.splice(start - 1, end - start + 1, ...string(p.content).split("\n"))
    context.signal.throwIfAborted()
    if (hash(bytes(file, 1024 * 1024).toString()) !== p.sha256)
      throw new ToolInputError("File changed during anchored edit")
    const next = lines.join("\n")
    if (Buffer.byteLength(next) > 1024 * 1024) throw new ToolInputError("Edited anchor file exceeds 1 MiB")
    await writeFile(file, next)
    return { text: "Anchored edit applied", label: "Edit anchors", mutatedPaths: [file] }
  },
}
export const clockTool: HarnessTool = {
  name: "clock",
  description: "Read current UTC time or wait up to 30 seconds; waiting is cancelled with the turn.",
  inputSchema: {
    type: "object",
    properties: { sleep_ms: { type: "integer", minimum: 0, maximum: 30000 } },
    additionalProperties: false,
  },
  isReadOnly: () => true,
  permission: () => ({ kind: "none" }),
  async run(input, context) {
    const ms = object(input).sleep_ms ?? 0
    if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 0 || ms > 30000)
      throw new ToolInputError("Wait must be 0–30000 ms")
    await new Promise<void>((resolve, reject) => {
      context.signal.throwIfAborted()
      const abort = () => {
          clearTimeout(timer)
          reject(context.signal.reason)
        },
        timer = setTimeout(() => {
          context.signal.removeEventListener("abort", abort)
          resolve()
        }, ms)
      context.signal.addEventListener("abort", abort, { once: true })
    })
    return { text: new Date().toISOString(), label: "Clock" }
  },
}
export const codeModeTool: HarnessTool = {
  name: "code_mode",
  description:
    "Run bounded JavaScript in the native OS sandbox worker. No host tool dispatch. Workspace writes require explicit approval and native checkpoints.",
  inputSchema: {
    type: "object",
    properties: { code: { type: "string", maxLength: 65536 } },
    required: ["code"],
    additionalProperties: false,
  },
  isReadOnly: () => false,
  effects: "workspace-and-external",
  alwaysAsk: () => true,
  allowPersistentApproval: false,
  permission: () => ({
    kind: "approval",
    title: "Run sandboxed code?",
    detail: "JavaScript may access the sandbox's allowed workspace and network resources.",
  }),
  async run(input, context) {
    if (!process.argv.includes("--internal-sandbox-worker"))
      throw new ToolInputError("Code mode requires the native OS worker")
    const code = string(object(input).code),
      AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
    const result = await new AsyncFunction("signal", `"use strict";\n${code}`)(context.signal)
    return {
      text: truncateToolOutput(
        context.sanitizeOutput?.(JSON.stringify(result) ?? "undefined") ??
          JSON.stringify(result) ??
          "undefined",
      ),
      label: "Sandboxed code",
    }
  },
}
export const advancedTools = () => [notebookTool, anchorReadTool, anchorEditTool, clockTool, codeModeTool]
