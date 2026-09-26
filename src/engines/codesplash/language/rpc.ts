import type { SandboxRuntime } from "../sandbox/contracts.ts"
import type { SandboxDuplex } from "../sandbox/duplex.ts"

/** LSP Content-Length framing is byte based, independent of JSON-RPC stdio NDJSON. */
export class LanguageRpc {
  #stream?: SandboxDuplex
  #pending = Buffer.alloc(0)
  #sequence = 0
  #waiters = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  constructor(readonly notification: (method: string, params: unknown) => void) {}
  async open(sandbox: SandboxRuntime, command: string[], signal: AbortSignal) {
    if (!sandbox.openDuplex) throw new Error("Persistent sandbox transport unavailable")
    this.#stream = await sandbox.openDuplex(command, signal, (chunk) => this.receive(chunk), "plan", [])
    void this.#stream.finished.then(
      (result) => this.fail(new Error(`Language server exited: ${result.stderr.slice(0, 2000)}`)),
      () => this.fail(new Error("Language server failed")),
    )
  }
  receive(chunk: Uint8Array) {
    try {
      this.#pending = Buffer.concat([this.#pending, chunk])
      if (this.#pending.length > 8 * 1024 * 1024) throw new Error("LSP frame exceeds 8 MiB")
      while (true) {
        const end = this.#pending.indexOf("\r\n\r\n")
        if (end < 0) {
          if (this.#pending.length > 8192) throw new Error("LSP header exceeds limit")
          return
        }
        const header = this.#pending.subarray(0, end).toString()
        const lengths = [...header.matchAll(/^Content-Length: ([0-9]+)$/gim)]
        if (lengths.length !== 1) throw new Error("Invalid LSP Content-Length")
        const size = Number(lengths[0]![1])
        if (size > 8 * 1024 * 1024) throw new Error("LSP frame exceeds limit")
        if (this.#pending.length < end + 4 + size) return
        const value = JSON.parse(this.#pending.subarray(end + 4, end + 4 + size).toString())
        this.#pending = this.#pending.subarray(end + 4 + size)
        if (value.method && value.id !== undefined) {
          // Language servers cannot apply workspace edits, run commands, or request configuration authority.
          void this.send({
            jsonrpc: "2.0",
            id: value.id,
            error: { code: -32601, message: "Client request unsupported" },
          }).catch(() => {})
        } else if (value.method) this.notification(value.method, value.params)
        else {
          const pending = this.#waiters.get(value.id)
          if (pending) {
            clearTimeout(pending.timer)
            this.#waiters.delete(value.id)
            value.error
              ? pending.reject(new Error("Language server request failed"))
              : pending.resolve(value.result)
          }
        }
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
      void this.#stream?.close()
    }
  }
  async send(value: unknown) {
    if (!this.#stream) throw new Error("Language server disconnected")
    const body = Buffer.from(JSON.stringify(value))
    await this.#stream.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
  }
  notify(method: string, params: unknown) {
    return this.send({ jsonrpc: "2.0", method, params })
  }
  request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    const id = ++this.#sequence
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.#waiters.delete(id)
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
        void this.notify("$/cancelRequest", { id }).catch(() => {})
        reject(new Error("LSP request cancelled or timed out"))
      }
      const timer = setTimeout(abort, 10000)
      const finish = (callback: () => void) => {
        signal.removeEventListener("abort", abort)
        callback()
      }
      this.#waiters.set(id, {
        timer,
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
      })
      signal.addEventListener("abort", abort, { once: true })
      void this.send({ jsonrpc: "2.0", id, method, params }).catch((error) => {
        clearTimeout(timer)
        this.#waiters.delete(id)
        finish(() => reject(error))
      })
    })
  }
  fail(error: Error) {
    for (const w of this.#waiters.values()) {
      clearTimeout(w.timer)
      w.reject(error)
    }
    this.#waiters.clear()
  }
  async close() {
    this.fail(new Error("Language client closed"))
    await this.#stream?.close()
    this.#stream = undefined
  }
}
