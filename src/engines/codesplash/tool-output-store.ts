import { constants } from "node:fs"
import { mkdir, open, readdir, unlink } from "node:fs/promises"
import { join } from "node:path"
import { reminderText } from "./context.ts"
import { type HarnessTool, ToolInputError } from "./contracts.ts"
import { truncateToolOutput } from "./tools/truncate.ts"

export const TOOL_CONTEXT_BYTES = 8 * 1024
export const READ_TOOL_OUTPUT = "read_tool_output"
const MAX_BYTES = 16 * 1024 * 1024
const MAX_ENTRIES = 256
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Stores only sanitized, execution-capped tool results. No-history instances never touch disk. */
export class ToolOutputStore {
  #entries = new Map<string, { size: number; text?: string }>()
  #ready: Promise<void> | undefined
  #serial: Promise<unknown> = Promise.resolve()
  constructor(readonly directory?: string) {}

  async #initialize(): Promise<void> {
    if (!this.directory) return
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const entries = []
    for (const name of await readdir(this.directory)) {
      if (!ID.test(name)) continue
      const file = await open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW).catch(
        () => undefined,
      )
      if (!file) continue
      try {
        const info = await file.stat()
        if (info.isFile()) entries.push({ name, size: info.size, time: info.mtimeMs })
      } finally {
        await file.close()
      }
    }
    for (const entry of entries.sort((a, b) => a.time - b.time))
      this.#entries.set(entry.name, { size: entry.size })
    await this.#evict(0)
  }

  async #evict(incoming: number): Promise<void> {
    let total = [...this.#entries.values()].reduce((sum, entry) => sum + entry.size, 0)
    for (const [id, entry] of this.#entries) {
      if (total + incoming <= MAX_BYTES && this.#entries.size < MAX_ENTRIES) break
      if (this.directory)
        await unlink(join(this.directory, id)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
        })
      this.#entries.delete(id)
      total -= entry.size
    }
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#serial.then(async () => {
      this.#ready ??= this.#initialize()
      await this.#ready
      return operation()
    })
    this.#serial = result.catch(() => {})
    return result
  }

  async retain(text: string): Promise<string> {
    if (Buffer.byteLength(text) <= TOOL_CONTEXT_BYTES) return text
    return this.#run(async () => {
      const size = Buffer.byteLength(text)
      if (size > MAX_BYTES)
        return `${truncateToolOutput(text, { maxBytes: TOOL_CONTEXT_BYTES - 128 })}\n[Output exceeds retention limit.]`
      await this.#evict(size)
      const id = crypto.randomUUID()
      if (this.directory) {
        const handle = await open(join(this.directory, id), "wx", 0o600)
        try {
          await handle.writeFile(text)
        } catch (error) {
          await unlink(join(this.directory, id)).catch(() => {})
          throw error
        } finally {
          await handle.close()
        }
      }
      this.#entries.set(id, { size, text: this.directory ? undefined : text })
      return `${truncateToolOutput(text, { maxBytes: TOOL_CONTEXT_BYTES - 320 })}\n${reminderText({ source: "tool-output", text: `Retained output: ${id}. Use read_tool_output with this id and an offset to read more.` })}`
    }).catch(
      () =>
        `${truncateToolOutput(text, { maxBytes: TOOL_CONTEXT_BYTES - 128 })}\n[Output retention unavailable; result truncated.]`,
    )
  }

  async read(input: unknown): Promise<string> {
    if (!input || typeof input !== "object")
      throw new ToolInputError("Expected an output id and optional offset")
    const { id, offset = 0 } = input as { id?: unknown; offset?: unknown }
    if (typeof id !== "string" || !ID.test(id)) throw new ToolInputError("Invalid output id")
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)
      throw new ToolInputError("Offset must be a nonnegative integer")
    return this.#run(async () => {
      const entry = this.#entries.get(id)
      if (!entry) throw new ToolInputError("Output is unavailable or expired in this session")
      let text = entry.text ?? ""
      if (this.directory) {
        const file = await open(join(this.directory, id), constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const info = await file.stat()
          if (!info.isFile() || info.size > MAX_BYTES) throw new ToolInputError("Output is unavailable")
          text = await file.readFile("utf8")
        } finally {
          await file.close()
        }
      }
      // Character offsets, deliberately documented rather than slicing UTF-8 bytes mid-codepoint.
      let end = Math.min(text.length, offset + 1800)
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--
      return `${text.slice(offset, end)}\n[${end < text.length ? `Next offset: ${end}` : "End of retained output"}; offsets are UTF-16 characters.]`
    })
  }
}

/** Intrinsic: the loop serves it from its own session store, never the tool worker filesystem. */
export const readToolOutputTool: HarnessTool = {
  name: READ_TOOL_OUTPUT,
  description:
    "Read a retained tool result from this session by its opaque id. Offset counts UTF-16 characters; follow the returned next offset.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" }, offset: { type: "integer", minimum: 0 } },
    required: ["id"],
    additionalProperties: false,
  },
  isReadOnly: () => true,
  permission: () => ({ kind: "none" }),
  run: async () => {
    throw new ToolInputError("Retained output is unavailable in this session")
  },
}
