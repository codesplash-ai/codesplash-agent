import { SecretSanitizer } from "../../engines/codesplash/sandbox/env-policy.ts"

export type OutputPage = {
  text: string
  start: number
  cursor: number
  end: number
  lost: boolean
  closed: boolean
}
/** Byte cursors refer to sanitized output, never raw process bytes. */
export class TaskOutput {
  readonly #waiters = new Set<() => void>()
  #bytes = Buffer.alloc(0)
  #end = 0
  #surrogate = ""
  #closed = false
  #escape: "text" | "esc" | "csi" | "osc" | "osc-esc" = "text"
  readonly #sanitize: SecretSanitizer
  constructor(
    readonly capacity = 1024 * 1024,
    secrets: readonly string[] = [],
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1024 || capacity > 1024 * 1024)
      throw new Error("Invalid output capacity")
    if (secrets.length > 256 || secrets.some((s) => s.length > 65536))
      throw new Error("Output secret bounds exceeded")
    this.#sanitize = new SecretSanitizer(secrets, true)
  }
  append(text: string) {
    if (this.#closed) throw new Error("Task output is closed")
    // Bound intermediate allocation even for producer floods.
    for (let at = 0; at < text.length; at += 16384)
      this.#retain(this.#sanitize.push(text.slice(at, at + 16384)))
  }
  close() {
    if (this.#closed) return
    this.#retain(this.#sanitize.push("", true), true)
    this.#closed = true
    this.#notify()
  }
  #notify() {
    for (const wake of [...this.#waiters]) wake()
  }
  waitForChange(cursor: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (cursor !== this.#end || this.#closed) return Promise.resolve()
    if (this.#waiters.size >= 8) throw new Error("Task output monitor limit reached")
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.#waiters.delete(wake)
        signal.removeEventListener("abort", abort)
      }
      const wake = () => {
        cleanup()
        resolve()
      }
      const abort = () => {
        cleanup()
        reject(signal.reason)
      }
      this.#waiters.add(wake)
      signal.addEventListener("abort", abort, { once: true })
    })
  }
  #retain(text: string, final = false) {
    text = this.#surrogate + text
    this.#surrogate = ""
    const last = text.charCodeAt(text.length - 1)
    if (!final && last >= 0xd800 && last <= 0xdbff) {
      this.#surrogate = text.slice(-1)
      text = text.slice(0, -1)
    }
    let clean = ""
    for (const c of text) {
      const code = c.codePointAt(0)!
      if (this.#escape === "osc-esc") {
        this.#escape = c === "\\" ? "text" : "osc"
        continue
      }
      if (this.#escape === "osc") {
        if (c === "\x07") this.#escape = "text"
        else if (c === "\x1b") this.#escape = "osc-esc"
        continue
      }
      if (this.#escape === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.#escape = "text"
        continue
      }
      if (this.#escape === "esc") {
        this.#escape = c === "[" ? "csi" : ["]", "P", "^", "_"].includes(c) ? "osc" : "text"
        continue
      }
      if (c === "\x1b") {
        this.#escape = "esc"
        continue
      }
      if (
        (code < 32 && c !== "\n" && c !== "\t") ||
        (code >= 127 && code <= 159) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      )
        continue
      clean += c
    }
    const bytes = Buffer.from(clean)
    this.#end += bytes.length
    const combined = Buffer.concat([this.#bytes, bytes])
    let cut = Math.max(0, combined.length - this.capacity)
    while (cut < combined.length && (combined[cut]! & 0xc0) === 0x80) cut++
    this.#bytes = Buffer.from(combined.subarray(cut))
    if (bytes.length) this.#notify()
  }
  read(cursor = 0, limit = 65536): OutputPage {
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      cursor > this.#end ||
      !Number.isSafeInteger(limit) ||
      limit < 4 ||
      limit > 65536
    )
      throw new Error("Invalid task output cursor or page size")
    const oldest = this.#end - this.#bytes.length
    let start = Math.max(cursor, oldest)
    while (start < this.#end && (this.#bytes[start - oldest]! & 0xc0) === 0x80) start++
    let end = Math.min(this.#end, start + limit)
    while (end < this.#end && (this.#bytes[end - oldest]! & 0xc0) === 0x80) end--
    return {
      text: this.#bytes.subarray(start - oldest, end - oldest).toString(),
      start,
      cursor: end,
      end: this.#end,
      lost: cursor < oldest,
      closed: this.#closed,
    }
  }
}
