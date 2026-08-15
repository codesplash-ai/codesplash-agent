type Waiter<T> = {
  resolve(result: IteratorResult<T>): void
  reject(error: Error): void
}

/** A small single-consumer async queue used at process and UI event boundaries. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = []
  readonly #waiters: Waiter<T>[] = []
  #ended = false
  #error: Error | undefined

  push(value: T): void {
    if (this.#ended) throw new Error("Cannot push to a closed async queue")
    const waiter = this.#waiters.shift()
    if (waiter) waiter.resolve({ done: false, value })
    else this.#values.push(value)
  }

  end(): void {
    if (this.#ended) return
    this.#ended = true
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined })
  }

  fail(error: Error): void {
    if (this.#ended) return
    this.#ended = true
    this.#error = error
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#values.shift()
        if (value !== undefined) return Promise.resolve({ done: false, value })
        if (this.#error) return Promise.reject(this.#error)
        if (this.#ended) return Promise.resolve({ done: true, value: undefined })
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }))
      },
    }
  }
}
