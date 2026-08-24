import { describe, expect, test } from "bun:test"
import { ProviderHttpError } from "../../../src/engines/codesplash/contracts.ts"
import { withRetries } from "../../../src/engines/codesplash/providers/retry.ts"

function failingThen<T>(failures: unknown[], result: T) {
  let calls = 0
  const operation = () => {
    calls += 1
    const failure = failures[calls - 1]
    if (failure !== undefined) return Promise.reject(failure)
    return Promise.resolve(result)
  }
  return { operation, calls: () => calls }
}

describe("withRetries", () => {
  test("retries a 429 and honors Retry-After before succeeding", async () => {
    const { operation, calls } = failingThen([new ProviderHttpError("rate limited", 429, 120)], "ok")
    const started = performance.now()
    const result = await withRetries(operation, { baseDelayMs: 1 })
    const elapsed = performance.now() - started

    expect(result).toBe("ok")
    expect(calls()).toBe(2)
    expect(elapsed).toBeGreaterThanOrEqual(100)
  })

  test("caps Retry-After at maxDelayMs", async () => {
    const { operation, calls } = failingThen([new ProviderHttpError("rate limited", 429, 60_000)], "ok")
    const started = performance.now()
    const result = await withRetries(operation, { maxDelayMs: 20 })
    const elapsed = performance.now() - started

    expect(result).toBe("ok")
    expect(calls()).toBe(2)
    expect(elapsed).toBeLessThan(2_000)
  })

  test("retries 5xx responses", async () => {
    const { operation, calls } = failingThen(
      [new ProviderHttpError("bad gateway", 502), new ProviderHttpError("unavailable", 503)],
      "ok",
    )
    await expect(withRetries(operation, { baseDelayMs: 1 })).resolves.toBe("ok")
    expect(calls()).toBe(3)
  })

  test("retries 408 request timeouts", async () => {
    const { operation, calls } = failingThen([new ProviderHttpError("timeout", 408)], "ok")
    await expect(withRetries(operation, { baseDelayMs: 1 })).resolves.toBe("ok")
    expect(calls()).toBe(2)
  })

  test("retries network TypeErrors", async () => {
    const { operation, calls } = failingThen([new TypeError("fetch failed")], "ok")
    await expect(withRetries(operation, { baseDelayMs: 1 })).resolves.toBe("ok")
    expect(calls()).toBe(2)
  })

  test("retries plain Errors carrying Bun network codes", async () => {
    const refused = Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" })
    const { operation, calls } = failingThen([refused], "ok")
    await expect(withRetries(operation, { baseDelayMs: 1 })).resolves.toBe("ok")
    expect(calls()).toBe(2)
  })

  test("retries a genuine Bun fetch connect failure from a stopped listener", async () => {
    // Bun's fetch rejects a refused connection with a plain Error (code "ConnectionRefused"),
    // not the TypeError that Node/undici throw — the retry path must recognize both.
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") })
    const url = `http://127.0.0.1:${server.port}/`
    server.stop(true)

    let calls = 0
    const operation = async (): Promise<string> => {
      calls += 1
      if (calls === 1) {
        await fetch(url)
        throw new Error("unreachable: the stopped listener accepted a connection")
      }
      return "recovered"
    }
    await expect(withRetries(operation, { baseDelayMs: 1 })).resolves.toBe("recovered")
    expect(calls).toBe(2)
  })

  test("non-retryable 400 fails fast", async () => {
    const error = new ProviderHttpError("bad request", 400)
    const { operation, calls } = failingThen([error], "unreachable")
    await expect(withRetries(operation, { baseDelayMs: 1 })).rejects.toBe(error)
    expect(calls()).toBe(1)
  })

  test("ProviderHttpError without a status fails fast", async () => {
    const error = new ProviderHttpError("no status", undefined)
    const { operation, calls } = failingThen([error], "unreachable")
    await expect(withRetries(operation)).rejects.toBe(error)
    expect(calls()).toBe(1)
  })

  test("plain Errors fail fast", async () => {
    const error = new Error("boom")
    const { operation, calls } = failingThen([error], "unreachable")
    await expect(withRetries(operation)).rejects.toBe(error)
    expect(calls()).toBe(1)
  })

  test("gives up with the last error once attempts are exhausted", async () => {
    const errors = [
      new ProviderHttpError("first", 500),
      new ProviderHttpError("second", 500),
      new ProviderHttpError("last", 429),
    ]
    const { operation, calls } = failingThen(errors, "unreachable")
    await expect(withRetries(operation, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toBe(errors[2])
    expect(calls()).toBe(3)
  })

  test("abort during backoff rejects promptly without another attempt", async () => {
    const controller = new AbortController()
    const { operation, calls } = failingThen([new ProviderHttpError("rate limited", 429, 25_000)], "ok")
    const pending = withRetries(operation, { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)

    const started = performance.now()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(calls()).toBe(1)
  })

  test("abort rejects with the signal's reason", async () => {
    const controller = new AbortController()
    const reason = new Error("user interrupted")
    const { operation } = failingThen([new ProviderHttpError("rate limited", 429, 25_000)], "ok")
    const pending = withRetries(operation, { signal: controller.signal })
    setTimeout(() => controller.abort(reason), 10)
    await expect(pending).rejects.toBe(reason)
  })

  test("an already-aborted signal rejects before the first attempt", async () => {
    const controller = new AbortController()
    controller.abort()
    const { operation, calls } = failingThen([], "unreachable")
    await expect(withRetries(operation, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(calls()).toBe(0)
  })

  test("full-jitter backoff stays within the cap across attempts", async () => {
    const failures = Array.from({ length: 4 }, (_, i) => new ProviderHttpError(`try ${i}`, 500))
    const { operation, calls } = failingThen(failures, "ok")
    const started = performance.now()
    await expect(withRetries(operation, { baseDelayMs: 2, maxDelayMs: 8 })).resolves.toBe("ok")
    const elapsed = performance.now() - started

    expect(calls()).toBe(5)
    // Worst case is 2 + 4 + 8 + 8 = 22ms of delay; anything near a second means the cap failed.
    expect(elapsed).toBeLessThan(1_000)
  })
})
