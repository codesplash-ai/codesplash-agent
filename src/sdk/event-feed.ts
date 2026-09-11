import type { AgentEvent } from "../core/events.ts"

/** A slow consumer loses its own feed explicitly; session recording keeps running. */
export class EventFeed implements AsyncIterableIterator<AgentEvent> {
  #items: Array<{ event: AgentEvent; bytes: number }> = []
  #bytes = 0
  #done = false
  #error?: Error
  #waiting?: { resolve: (value: IteratorResult<AgentEvent>) => void; reject: (error: Error) => void }
  constructor(readonly dispose: () => void) {}
  [Symbol.asyncIterator]() {
    return this
  }
  push(event: AgentEvent): void {
    if (this.#done) return
    const bytes = Buffer.byteLength(JSON.stringify(event))
    if (bytes + this.#bytes > 8 * 1024 * 1024 || this.#items.length >= 1024) {
      this.finish(new Error("SDK event feed overflow; resubscribe or use recorded history"))
      return
    }
    if (this.#waiting) {
      this.#waiting.resolve({ done: false, value: structuredClone(event) })
      this.#waiting = undefined
    } else {
      this.#items.push({ event: structuredClone(event), bytes })
      this.#bytes += bytes
    }
  }
  next(): Promise<IteratorResult<AgentEvent>> {
    if (this.#error) return Promise.reject(this.#error)
    const item = this.#items.shift()
    if (item) {
      this.#bytes -= item.bytes
      return Promise.resolve({ done: false, value: item.event })
    }
    if (this.#done) return Promise.resolve({ done: true, value: undefined })
    if (this.#waiting) return Promise.reject(new Error("Concurrent next() calls are unsupported"))
    return new Promise((resolve, reject) => {
      this.#waiting = { resolve, reject }
    })
  }
  finish(error?: Error): void {
    if (this.#done) return
    this.#done = true
    this.#error = error
    if (error) {
      this.#items = []
      this.#bytes = 0
      this.#waiting?.reject(error)
    } else this.#waiting?.resolve({ done: true, value: undefined })
    this.#waiting = undefined
    this.dispose()
  }
  async return(): Promise<IteratorResult<AgentEvent>> {
    this.#items = []
    this.#bytes = 0
    this.finish()
    return { done: true, value: undefined }
  }
}
