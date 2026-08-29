/**
 * Provider-native transcript persistence for the CodeSplash engine. The transcript IS the
 * session's model-visible history: one JSONL line `{ v: 1, message }` per ChatMessage, appended
 * after every turn and reloaded to seed a resumed session. There is no size cap.
 *
 * Healing follows the same posture as the session event log (core/sessions.ts): corrupt lines are
 * skipped on load, a torn final line (crash mid-append) is dropped, and the next append repairs
 * the torn tail first so the file stays valid JSONL.
 */
import { mkdir, open, readFile, stat, truncate } from "node:fs/promises"
import { dirname } from "node:path"
import type { ChatMessage } from "./contracts.ts"

const TRANSCRIPT_VERSION = 1

/**
 * Loads every intact message from a transcript file. A missing file is an empty transcript;
 * corrupt lines and a torn final line are skipped, never fatal.
 */
export async function loadTranscript(path: string): Promise<ChatMessage[]> {
  let source: string
  try {
    source = await readFile(path, "utf8")
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return []
    throw error
  }

  const messages: ChatMessage[] = []
  for (const line of source.split("\n")) {
    if (line.trim() === "") continue
    const message = parseTranscriptLine(line)
    if (message) messages.push(message)
  }
  return messages
}

/**
 * Appends messages as JSONL lines, creating parent directories on first write. A torn final line
 * left by a crash is healed first: an unparsable tail is truncated away (mirroring what load
 * drops), while a parseable line that only lost its newline is terminated instead of discarded.
 */
export async function appendTranscriptMessages(path: string, messages: ChatMessage[]): Promise<void> {
  if (messages.length === 0) return
  await mkdir(dirname(path), { recursive: true })
  const prefix = await healTornTail(path)

  const handle = await open(path, "a", 0o600)
  try {
    const lines = messages
      .map((message) => `${JSON.stringify({ v: TRANSCRIPT_VERSION, message })}\n`)
      .join("")
    await handle.write(`${prefix}${lines}`)
  } finally {
    await handle.close()
  }
}

/**
 * Repairs a file that does not end in a newline. Returns the prefix the next append must write
 * ("\n" when a parseable final line just lost its terminator); truncates unparsable torn bytes.
 */
async function healTornTail(path: string): Promise<string> {
  let size: number
  try {
    size = (await stat(path)).size
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return ""
    throw error
  }
  if (size === 0) return ""

  if (await endsWithNewline(path, size)) return ""

  // Rare crash-recovery path: read the whole file to find the last complete line boundary.
  const source = await readFile(path, "utf8")
  const lastNewline = source.lastIndexOf("\n")
  const tail = source.slice(lastNewline + 1)
  if (parseTranscriptLine(tail)) return "\n"
  await truncate(path, Buffer.byteLength(source.slice(0, lastNewline + 1)))
  return ""
}

async function endsWithNewline(path: string, size: number): Promise<boolean> {
  const handle = await open(path, "r")
  try {
    const buffer = Buffer.alloc(1)
    await handle.read(buffer, 0, 1, size - 1)
    return buffer[0] === 0x0a
  } finally {
    await handle.close()
  }
}

function parseTranscriptLine(line: string): ChatMessage | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    if (!isRecord(parsed) || parsed.v !== TRANSCRIPT_VERSION) return undefined
    return isChatMessage(parsed.message) ? parsed.message : undefined
  } catch {
    return undefined
  }
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value)) return false
  if (value.role !== "user" && value.role !== "assistant") return false
  return (
    Array.isArray(value.content) &&
    value.content.every((block) => isRecord(block) && typeof block.type === "string")
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value
}
