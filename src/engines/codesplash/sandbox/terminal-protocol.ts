export type TerminalSize = { cols: number; rows: number }
export type TerminalControl = { seq: number } & (
  | { kind: "stdin"; data: string }
  | { kind: "resize"; cols: number; rows: number }
  | { kind: "eof" }
)
export function terminalSize(value: TerminalSize): TerminalSize {
  if (![value.cols, value.rows].every((n) => Number.isSafeInteger(n) && n >= 1 && n <= 500))
    throw new Error("Terminal dimensions must be integers from 1 to 500")
  return { cols: value.cols, rows: value.rows }
}
export function terminalBytes(value: unknown): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length > 87384 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new Error("Invalid terminal data frame")
  const bytes = Buffer.from(value, "base64")
  if (bytes.length > 65536 || bytes.toString("base64") !== value)
    throw new Error("Terminal frame exceeds 64 KiB or has invalid encoding")
  return bytes
}
export function terminalControl(value: unknown): TerminalControl {
  if (!value || typeof value !== "object") throw new Error("Invalid terminal control")
  const frame = value as TerminalControl
  if (!Number.isSafeInteger(frame.seq) || frame.seq < 1) throw new Error("Invalid terminal sequence")
  if (frame.kind === "stdin") terminalBytes(frame.data)
  else if (frame.kind === "resize") terminalSize(frame)
  else if (frame.kind !== "eof") throw new Error("Unknown terminal control")
  return frame
}
/** Incremental bounded framing. UTF-8 decoding happens only after a complete byte frame. */
export class TerminalFrames {
  #pending = Buffer.alloc(0)
  constructor(readonly max = 128 * 1024) {}
  push(bytes: Uint8Array, receive: (frame: unknown) => void) {
    let start = 0
    for (let at = 0; at < bytes.length; at++)
      if (bytes[at] === 10) {
        if (this.#pending.length + at - start > this.max) throw new Error("Terminal protocol frame too large")
        const line = Buffer.concat([this.#pending, bytes.subarray(start, at)])
        this.#pending = Buffer.alloc(0)
        start = at + 1
        receive(JSON.parse(line.toString("utf8")))
      }
    if (this.#pending.length + bytes.length - start > this.max)
      throw new Error("Terminal protocol frame too large")
    this.#pending = Buffer.concat([this.#pending, bytes.subarray(start)])
  }
  end() {
    if (this.#pending.length) throw new Error("Truncated terminal protocol frame")
  }
}
