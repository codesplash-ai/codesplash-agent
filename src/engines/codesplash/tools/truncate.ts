/**
 * Head+tail truncation for model-facing tool output. Every tool routes its result text through
 * `truncateToolOutput` so no single call can flood the context window.
 */

export type TruncateOptions = {
  /** Maximum content lines to keep; default 2000. */
  maxLines?: number
  /** Maximum UTF-8 bytes for the returned text; default 50KB. */
  maxBytes?: number
}

export const DEFAULT_TRUNCATE_MAX_LINES = 2000
export const DEFAULT_TRUNCATE_MAX_BYTES = 50 * 1024

/** Reserved from the byte budget for the elision marker line. */
const MARKER_RESERVE_BYTES = 96

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function truncateToolOutput(text: string, options: TruncateOptions = {}): string {
  const maxLines = Math.max(2, Math.floor(options.maxLines ?? DEFAULT_TRUNCATE_MAX_LINES))
  const maxBytes = Math.max(0, Math.floor(options.maxBytes ?? DEFAULT_TRUNCATE_MAX_BYTES))

  const totalBytes = Buffer.byteLength(text, "utf8")
  const endsWithNewline = text.endsWith("\n")
  const body = endsWithNewline ? text.slice(0, -1) : text
  const lines = body.split("\n")
  if (lines.length <= maxLines && totalBytes <= maxBytes) return text

  const contentBudget = Math.max(0, maxBytes - MARKER_RESERVE_BYTES)
  let head: string
  let tail: string
  if (lines.length > maxLines) {
    const headCount = Math.ceil(maxLines / 2)
    const tailCount = maxLines - headCount
    head = takeLeadingBytes(lines.slice(0, headCount).join("\n"), Math.ceil(contentBudget / 2))
    tail = takeTrailingBytes(lines.slice(lines.length - tailCount).join("\n"), Math.floor(contentBudget / 2))
  } else {
    head = takeLeadingBytes(body, Math.ceil(contentBudget / 2))
    tail = takeTrailingBytes(body, Math.floor(contentBudget / 2))
  }

  const keptBytes = Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8")
  const elidedBytes = Math.max(0, totalBytes - keptBytes)
  const elidedLines = Math.max(0, lines.length - countLines(head) - countLines(tail))
  const marker = `[... output truncated: ${elidedLines} lines (${elidedBytes} bytes) elided ...]`

  const parts = [head, marker, tail].filter((part) => part !== "")
  return parts.join("\n") + (endsWithNewline ? "\n" : "")
}

function countLines(text: string): number {
  if (text === "") return 0
  let count = 1
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1
  }
  return count
}

function takeLeadingBytes(text: string, budget: number): string {
  const bytes = encoder.encode(text)
  if (bytes.length <= budget) return text
  let end = budget
  while (end > 0 && isContinuationByte(bytes[end])) end -= 1
  return decoder.decode(bytes.subarray(0, end))
}

function takeTrailingBytes(text: string, budget: number): string {
  const bytes = encoder.encode(text)
  if (bytes.length <= budget) return text
  let start = bytes.length - budget
  while (start < bytes.length && isContinuationByte(bytes[start])) start += 1
  return decoder.decode(bytes.subarray(start))
}

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80
}
