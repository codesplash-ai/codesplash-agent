/** One session-owned cancellable maintenance operation. Foreground work always has priority. */
export class OwnedMaintenance {
  #active?: { key: string; abort: AbortController; promise: Promise<unknown> }
  #closed = false
  get busy() {
    return !!this.#active
  }
  run<T>(key: string, work: (signal: AbortSignal) => Promise<T>, delayMs = 0): Promise<T> {
    if (this.#closed || this.#active)
      return Promise.reject(new Error("Session maintenance is unavailable or busy"))
    const abort = new AbortController()
    const promise = (async () => {
      await Promise.resolve()
      abort.signal.throwIfAborted()
      if (delayMs)
        await new Promise<void>((resolve, reject) => {
          const cancel = () => {
            clearTimeout(timer)
            reject(abort.signal.reason)
          }
          const timer = setTimeout(() => {
            abort.signal.removeEventListener("abort", cancel)
            resolve()
          }, delayMs)
          abort.signal.addEventListener("abort", cancel, { once: true })
        })
      abort.signal.throwIfAborted()
      return work(abort.signal)
    })().finally(() => {
      if (this.#active?.abort === abort) this.#active = undefined
    })
    this.#active = { key, abort, promise }
    // Callers still receive rejection; scheduling cannot create an unhandled background rejection.
    void promise.catch(() => {})
    return promise
  }
  cancel(reason = "Foreground work or shutdown interrupted session maintenance") {
    this.#active?.abort.abort(new Error(reason))
  }
  async settle() {
    await this.#active?.promise.catch(() => {})
  }
  async cancelAndSettle() {
    this.cancel()
    await this.settle()
  }
  async close() {
    this.#closed = true
    await this.cancelAndSettle()
  }
}
