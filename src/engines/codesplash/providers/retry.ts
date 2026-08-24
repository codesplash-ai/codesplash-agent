/**
 * Retry engine for provider connections. Retryable failures are ProviderHttpError with status
 * 408/429/5xx and network-level errors — TypeError (Node/undici convention) or a plain Error
 * carrying a Bun network code; everything else propagates on the first attempt.
 */
import { ProviderHttpError, type RetryOptions } from "../contracts.ts"

const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_BASE_DELAY_MS = 500
const DEFAULT_MAX_DELAY_MS = 30_000

/**
 * Bun's fetch rejects transient network failures with plain Errors carrying these `code`s
 * (verified: a refused connection rejects with ctor Error, code "ConnectionRefused"); Node-style
 * codes are included for compatibility.
 */
const RETRYABLE_NETWORK_CODES = new Set([
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
  "Timeout",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
])

export async function withRetries<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const signal = options.signal

  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted()
    try {
      return await operation()
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryable(error)) throw error
      signal?.throwIfAborted()
      await sleepUnlessAborted(delayBeforeRetry(error, attempt, baseDelayMs, maxDelayMs), signal)
    }
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof ProviderHttpError) {
    const status = error.status
    if (status === undefined) return false
    return status === 408 || status === 429 || (status >= 500 && status <= 599)
  }
  if (error instanceof TypeError) return true
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return typeof code === "string" && (RETRYABLE_NETWORK_CODES.has(code) || code.startsWith("DNS"))
  }
  return false
}

/** Retry-After wins over backoff; both are capped at maxDelayMs. Backoff uses full jitter. */
function delayBeforeRetry(error: unknown, attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  if (error instanceof ProviderHttpError && error.retryAfterMs !== undefined) {
    return Math.min(Math.max(0, error.retryAfterMs), maxDelayMs)
  }
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
  return Math.random() * cap
}

function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted.", "AbortError")
}
