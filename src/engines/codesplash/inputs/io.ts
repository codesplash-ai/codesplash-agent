import { execFile } from "node:child_process"
import { constants, type Dir } from "node:fs"
import { lstat, open, opendir, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { promisify } from "node:util"
import type { HarnessTool, ToolContext } from "../contracts.ts"
import { contains, physicalPath } from "../sandbox/profile.ts"
import { INPUT_FILE_BYTES } from "./contracts.ts"

export async function safeRead(root: string, path: string, signal?: AbortSignal): Promise<string> {
  const base = await realpath(root)
  const absolute = resolve(base, path)
  if (!contains(base, absolute)) throw new Error("Context resource leaves its source root")
  let current = base
  for (const part of relative(base, absolute).split(/[\\/]/)) {
    current = join(current, part)
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Context resources cannot use symlinks")
  }
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.nlink !== 1)
      throw new Error("Context resources must be regular, singly-linked files")
    if (info.size > INPUT_FILE_BYTES) throw new Error("Context resource exceeds 24 KiB")
    signal?.throwIfAborted()
    const bytes = Buffer.alloc(INPUT_FILE_BYTES + 1)
    let size = 0
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, null)
      if (!read.bytesRead) break
      size += read.bytesRead
    }
    if (size > INPUT_FILE_BYTES) throw new Error("Context resource exceeds 24 KiB")
    signal?.throwIfAborted()
    return bytes.subarray(0, size).toString("utf8")
  } finally {
    await file.close()
  }
}

const SOURCE_DIRECTORIES = [
  ".codesplash/commands",
  ".codesplash/skills",
  ".claude/commands",
  ".claude/skills",
  ".cursor/rules",
  ".agents/skills",
  "commands",
  "skills",
]
export async function resourcePaths(
  root: string,
  signal?: AbortSignal,
  sources = SOURCE_DIRECTORIES,
): Promise<string[]> {
  if (!sources.every((source) => SOURCE_DIRECTORIES.includes(source)))
    throw new Error("Invalid context discovery source")
  const paths: string[] = []
  let count = 0
  async function walk(path: string, depth: number) {
    if (depth > 4) return
    let directory: Dir
    try {
      directory = await opendir(join(root, path))
    } catch {
      return
    }
    for await (const entry of directory) {
      signal?.throwIfAborted()
      if (++count > 5000) throw new Error("Context discovery exceeds 5000 entries")
      if (entry.isSymbolicLink()) continue
      const name = path ? `${path}/${entry.name}` : entry.name
      if (entry.isFile() && /(?:\.mdc?|\.json)$/.test(name)) {
        paths.push(name)
        if (paths.length > 128) throw new Error("Context discovery exceeds 128 files")
      } else if (entry.isDirectory() && ![".git", "node_modules"].includes(entry.name))
        await walk(name, depth + 1)
    }
  }
  // Never walk arbitrary workspace content while discovering instruction sources.
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const info = await lstat(join(root, name)).catch(() => undefined)
    if (info?.isFile() && !info.isSymbolicLink()) paths.push(name)
  }
  for (const path of sources) {
    // Reject symlinked source directories and ancestors too.
    let current = root,
      valid = true
    for (const part of path.split("/")) {
      current = join(current, part)
      const info = await lstat(current).catch(() => undefined)
      if (!info?.isDirectory() || info.isSymbolicLink()) {
        valid = false
        break
      }
    }
    if (valid) await walk(path, 0)
  }
  return paths.sort()
}

function inputOf(input: unknown) {
  if (!input || typeof input !== "object") throw new Error("Invalid context input")
  const { root, path } = input as { root?: unknown; path?: unknown }
  if (typeof root !== "string" || !isAbsolute(root) || (path !== undefined && typeof path !== "string"))
    throw new Error("Invalid context path")
  return { root, path: path as string | undefined }
}
export function contextReadTool(userRoot?: string): HarnessTool {
  return {
    name: userRoot ? "user_context_read" : "context_read",
    hidden: true,
    permissionName: "read_file",
    description: "Read a bounded context resource",
    inputSchema: { type: "object" },
    isReadOnly: () => true,
    permission: () => ({ kind: "none" }),
    permissionTargets(input) {
      const value = inputOf(input)
      return { paths: [physicalPath(resolve(value.root, value.path ?? ""))] }
    },
    async run(input, context) {
      const { root, path } = inputOf(input)
      if (!path || (userRoot && root !== userRoot)) throw new Error("Invalid context source")
      const text = await safeRead(root, path, context.signal)
      return { text: JSON.stringify({ text: context.sanitizeOutput?.(text) ?? text }), label: path }
    },
  }
}
export const contextListTool: HarnessTool = {
  name: "context_list",
  hidden: true,
  permissionName: "glob",
  description: "List context resource paths",
  inputSchema: { type: "object" },
  isReadOnly: () => true,
  permission: () => ({ kind: "none" }),
  permissionTargets(input) {
    return { paths: [inputOf(input).root] }
  },
  async run(input, context: ToolContext) {
    const { root } = inputOf(input)
    const paths = (
      await resourcePaths(root, context.signal, (input as { sources?: string[] }).sources)
    ).filter((path) => !context.permissions?.isReadDenied(resolve(root, path), "read_file"))
    return { text: JSON.stringify(paths), label: "Context sources" }
  },
}
export const contextFilesTool: HarnessTool = {
  name: "context_files",
  hidden: true,
  permissionName: "glob",
  description: "List ignored-aware workspace filenames",
  inputSchema: { type: "object" },
  isReadOnly: () => true,
  permission: () => ({ kind: "none" }),
  permissionTargets(input) {
    return { paths: [inputOf(input).root] }
  },
  async run(input, context) {
    const { root } = inputOf(input)
    let stdout: string
    try {
      ;({ stdout } = await promisify(execFile)(
        "rg",
        ["--files", "--null", "--hidden", "-g", "!.git", "-g", "!node_modules"],
        { cwd: root, signal: context.signal, timeout: 3000, maxBuffer: 512 * 1024, encoding: "utf8" },
      ))
    } catch (error) {
      if ((error as { code?: number }).code === 1) stdout = ""
      else throw error
    }
    const paths = stdout.split("\0").filter(Boolean)
    if (paths.length > 5000) throw new Error("Filename index exceeds 5000 files; narrow the workspace")
    return {
      text: JSON.stringify(
        paths.filter((p) => !context.permissions?.isReadDenied(resolve(root, p), "read_file")),
      ),
      label: "Workspace filenames",
    }
  },
}
export const internalContextTools = () => [contextReadTool(), contextListTool, contextFilesTool]
