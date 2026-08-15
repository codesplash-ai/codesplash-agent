import { describe, expect, test } from "bun:test"
import { AsyncQueue } from "../../src/core/async-queue.ts"

describe("AsyncQueue", () => {
  test("delivers buffered and awaited values in order", async () => {
    const queue = new AsyncQueue<number>()
    const iterator = queue[Symbol.asyncIterator]()

    queue.push(1)
    expect(await iterator.next()).toEqual({ done: false, value: 1 })

    const next = iterator.next()
    queue.push(2)
    expect(await next).toEqual({ done: false, value: 2 })

    queue.end()
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
  })

  test("fails a waiting consumer", async () => {
    const queue = new AsyncQueue<number>()
    const next = queue[Symbol.asyncIterator]().next()
    queue.fail(new Error("broken"))
    await expect(next).rejects.toThrow("broken")
  })
})
