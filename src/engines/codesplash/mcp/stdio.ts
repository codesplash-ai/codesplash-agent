import { type JSONRPCMessage, parseJSONRPCMessage, type Transport } from "@modelcontextprotocol/client"
import type { PermissionMode } from "../contracts.ts"
import type { SandboxRuntime } from "../sandbox/contracts.ts"
import type { SandboxDuplex } from "../sandbox/duplex.ts"
import { boundedJson, MCP_FRAME_BYTES } from "./bounds.ts"

/** SDK protocol handling over a harness-owned process, never the SDK's unrestricted launcher. */
export class SandboxedMcpTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  readonly #abort = new AbortController()
  #opening?: Promise<SandboxDuplex>
  #stream?: SandboxDuplex
  #pending: Uint8Array[] = []
  #pendingBytes = 0
  #closed = false
  constructor(
    readonly options: {
      sandbox: SandboxRuntime
      argv: string[]
      signal: AbortSignal
      mode: PermissionMode
      environment?: readonly string[]
      diagnostic?: (text: string) => void
    },
  ) {}
  async start(): Promise<void> {
    if (this.#opening || this.#closed) throw new Error("MCP transport cannot be started again")
    if (!this.options.sandbox.openDuplex)
      throw new Error("This runtime cannot sandbox persistent MCP processes")
    this.#opening = this.options.sandbox.openDuplex(
      this.options.argv,
      AbortSignal.any([this.options.signal, this.#abort.signal]),
      (chunk) => this.#receive(chunk),
      this.options.mode,
      this.options.environment,
    )
    try {
      this.#stream = await this.#opening
      void this.#stream.finished
        .then(
          (result) => {
            if (result.stderr)
              this.options.diagnostic?.(
                this.options.sandbox.sanitize?.(result.stderr) ?? "MCP process diagnostic",
              )
            if (!this.#closed && result.kind !== "success") this.#fail(new Error("MCP process disconnected"))
            this.#finish()
          },
          () => {
            this.#fail(new Error("MCP process failed"))
          },
        )
        .catch(() => {
          this.#finish()
        })
    } catch (error) {
      this.#fail(error)
      throw error
    }
  }
  #receive(chunk: Uint8Array): void {
    if (this.#closed) return
    try {
      let start = 0
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start)
        const end = newline < 0 ? chunk.length : newline
        if (this.#pendingBytes + end - start > MCP_FRAME_BYTES || this.#pending.length >= 16_384)
          throw new Error("MCP stdio frame exceeds 16 MiB")
        this.#pending.push(chunk.subarray(start, end))
        this.#pendingBytes += end - start
        if (newline < 0) break
        if (this.#pendingBytes) {
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(this.#pending, this.#pendingBytes),
          )
          const raw: unknown = JSON.parse(decoded)
          boundedJson(raw)
          this.onmessage?.(parseJSONRPCMessage(raw))
        }
        this.#pending = []
        this.#pendingBytes = 0
        start = newline + 1
      }
    } catch {
      this.#fail(new Error("Invalid or oversized MCP stdio message"))
    }
  }
  #finish(): void {
    if (this.#closed) return
    this.#closed = true
    this.#pending = []
    this.#pendingBytes = 0
    this.onclose?.()
  }
  #fail(error: unknown): void {
    this.#abort.abort(error)
    try {
      this.onerror?.(error instanceof Error ? error : new Error("MCP transport failed"))
    } finally {
      this.#finish()
    }
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.#stream || this.#closed) throw new Error("MCP transport is closed")
    await this.#stream.write(Buffer.from(`${boundedJson(message)}\n`))
  }
  async close(): Promise<void> {
    this.#abort.abort(new Error("MCP transport closed"))
    const stream = await this.#opening?.catch(() => undefined)
    await stream?.close()
    this.#finish()
  }
}
