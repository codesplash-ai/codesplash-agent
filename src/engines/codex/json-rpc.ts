export type JsonRpcId = number | string

export type JsonRpcRequest = {
  id: JsonRpcId
  method: string
  params?: unknown
}

export type JsonRpcNotification = {
  method: string
  params?: unknown
}

export type JsonRpcErrorPayload = {
  code: number
  message: string
  data?: unknown
}

export type JsonRpcTransport = {
  chunks: AsyncIterable<string | Uint8Array>
  write(line: string): Promise<void> | void
  close?(): Promise<void> | void
}

export type JsonRpcConnectionOptions = {
  defaultTimeoutMs?: number
  maxLineBytes?: number
  onNotification?: (notification: JsonRpcNotification) => Promise<void> | void
  onRequest?: (request: JsonRpcRequest) => Promise<unknown> | unknown
  onProtocolError?: (error: JsonRpcProtocolError) => void
}

export type JsonRpcNotificationHandler = NonNullable<JsonRpcConnectionOptions["onNotification"]>
export type JsonRpcRequestHandler = NonNullable<JsonRpcConnectionOptions["onRequest"]>

type PendingRequest = {
  resolve(value: unknown): void
  reject(error: Error): void
  timeout: ReturnType<typeof setTimeout>
}

type JsonObject = Record<string, unknown>

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024

export class JsonRpcProtocolError extends Error {
  override readonly name = "JsonRpcProtocolError"

  constructor(
    message: string,
    readonly protocolCause?: unknown,
  ) {
    super(message)
  }
}

export class JsonRpcRemoteError extends Error {
  override readonly name = "JsonRpcRemoteError"

  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
  }
}

export class JsonRpcRequestTimeoutError extends Error {
  override readonly name = "JsonRpcRequestTimeoutError"

  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`JSON-RPC request ${method} timed out after ${timeoutMs}ms`)
  }
}

export class JsonRpcConnectionClosedError extends Error {
  override readonly name = "JsonRpcConnectionClosedError"
}

export class JsonRpcConnection {
  readonly #decoder = new TextDecoder()
  readonly #encoder = new TextEncoder()
  readonly #pending = new Map<JsonRpcId, PendingRequest>()
  readonly #notificationHandlers = new Set<JsonRpcNotificationHandler>()
  readonly #defaultTimeoutMs: number
  readonly #maxLineBytes: number
  readonly #closedPromise: Promise<void>
  readonly #resolveClosed: () => void
  #nextId = 1
  #closed = false
  #closeReason: Error | undefined
  #writeQueue = Promise.resolve()
  #requestHandler: JsonRpcRequestHandler | undefined

  constructor(
    readonly transport: JsonRpcTransport,
    readonly options: JsonRpcConnectionOptions = {},
  ) {
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES

    if (this.#defaultTimeoutMs <= 0) {
      throw new RangeError("defaultTimeoutMs must be greater than zero")
    }
    if (this.#maxLineBytes <= 0) {
      throw new RangeError("maxLineBytes must be greater than zero")
    }

    let resolveClosed = () => {}
    this.#closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve
    })
    this.#resolveClosed = resolveClosed
    if (options.onNotification) this.#notificationHandlers.add(options.onNotification)
    this.#requestHandler = options.onRequest

    void this.#readLoop()
  }

  get isClosed(): boolean {
    return this.#closed
  }

  get closeReason(): Error | undefined {
    return this.#closeReason
  }

  waitForClose(): Promise<void> {
    return this.#closedPromise
  }

  onNotification(handler: JsonRpcNotificationHandler): () => void {
    this.#notificationHandlers.add(handler)
    return () => this.#notificationHandlers.delete(handler)
  }

  setRequestHandler(handler: JsonRpcRequestHandler | undefined): void {
    this.#requestHandler = handler
  }

  request<TResult>(method: string, params?: unknown, timeoutMs = this.#defaultTimeoutMs): Promise<TResult> {
    if (this.#closed) return Promise.reject(this.#closedError())
    if (timeoutMs <= 0) return Promise.reject(new RangeError("timeoutMs must be greater than zero"))

    const id = this.#nextId++

    return new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.#pending.delete(id)) return
        reject(new JsonRpcRequestTimeoutError(method, timeoutMs))
      }, timeoutMs)

      this.#pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
        timeout,
      })

      void this.#write({ id, method, ...(params === undefined ? {} : { params }) }).catch((error) => {
        const pending = this.#pending.get(id)
        if (!pending) return
        this.#pending.delete(id)
        clearTimeout(pending.timeout)
        reject(toError(error, `Failed to write JSON-RPC request ${method}`))
      })
    })
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.#write({ method, ...(params === undefined ? {} : { params }) })
  }

  async close(): Promise<void> {
    if (this.#closed) return

    try {
      await this.transport.close?.()
    } finally {
      this.#finish(new JsonRpcConnectionClosedError("JSON-RPC connection closed by client"))
    }
  }

  async #readLoop(): Promise<void> {
    let buffer = ""
    let discardingOversizeLine = false

    try {
      for await (const chunk of this.transport.chunks) {
        if (this.#closed) break
        buffer += typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true })

        let newline = buffer.indexOf("\n")
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "")
          buffer = buffer.slice(newline + 1)

          if (discardingOversizeLine) {
            discardingOversizeLine = false
          } else {
            await this.#consumeLine(line)
          }

          newline = buffer.indexOf("\n")
        }

        if (!discardingOversizeLine && this.#byteLength(buffer) > this.#maxLineBytes) {
          this.#reportProtocolError(
            new JsonRpcProtocolError(`JSON-RPC line exceeded ${this.#maxLineBytes} bytes`),
          )
          buffer = ""
          discardingOversizeLine = true
        }
      }

      buffer += this.#decoder.decode()
      if (!discardingOversizeLine && buffer.length > 0) await this.#consumeLine(buffer.replace(/\r$/, ""))

      if (!this.#closed) {
        this.#finish(new JsonRpcConnectionClosedError("JSON-RPC input stream ended"))
      }
    } catch (error) {
      const reason = toError(error, "JSON-RPC input stream failed")
      this.#reportProtocolError(new JsonRpcProtocolError(reason.message, error))
      this.#finish(reason)
    }
  }

  async #consumeLine(line: string): Promise<void> {
    if (line.trim().length === 0) return
    if (this.#byteLength(line) > this.#maxLineBytes) {
      this.#reportProtocolError(
        new JsonRpcProtocolError(`JSON-RPC line exceeded ${this.#maxLineBytes} bytes`),
      )
      return
    }

    let value: unknown
    try {
      value = JSON.parse(line)
    } catch (error) {
      this.#reportProtocolError(new JsonRpcProtocolError("Malformed JSON-RPC line", error))
      return
    }

    if (!isObject(value)) {
      this.#reportProtocolError(new JsonRpcProtocolError("JSON-RPC message must be an object"))
      return
    }

    if (typeof value.method === "string") {
      if (isJsonRpcId(value.id)) {
        void this.#handleServerRequest({
          id: value.id,
          method: value.method,
          ...(value.params === undefined ? {} : { params: value.params }),
        }).catch((error) => {
          const reason = toError(error, `Failed to answer server request ${value.method}`)
          this.#reportProtocolError(new JsonRpcProtocolError(reason.message, error))
          this.#finish(reason)
        })
      } else if (value.id === undefined) {
        const notification = {
          method: value.method,
          ...(value.params === undefined ? {} : { params: value.params }),
        }
        for (const handler of this.#notificationHandlers) await handler(notification)
      } else {
        this.#reportProtocolError(new JsonRpcProtocolError("JSON-RPC request id must be a string or number"))
      }
      return
    }

    if (isJsonRpcId(value.id)) {
      this.#handleResponse(value.id, value)
      return
    }

    this.#reportProtocolError(new JsonRpcProtocolError("Unrecognized JSON-RPC message"))
  }

  #handleResponse(id: JsonRpcId, response: JsonObject): void {
    const pending = this.#pending.get(id)
    if (!pending) {
      this.#reportProtocolError(new JsonRpcProtocolError(`Received response for unknown request id ${id}`))
      return
    }

    this.#pending.delete(id)
    clearTimeout(pending.timeout)

    if ("error" in response) {
      const error = parseErrorPayload(response.error)
      pending.reject(new JsonRpcRemoteError(error.code, error.message, error.data))
      return
    }

    pending.resolve(response.result)
  }

  async #handleServerRequest(request: JsonRpcRequest): Promise<void> {
    if (!this.#requestHandler) {
      await this.#write({
        id: request.id,
        error: { code: -32601, message: `No handler for server request ${request.method}` },
      })
      return
    }

    try {
      const result = await this.#requestHandler(request)
      await this.#write({ id: request.id, result: result ?? null })
    } catch (error) {
      await this.#write({
        id: request.id,
        error: { code: -32603, message: toError(error, "Server request handler failed").message },
      })
    }
  }

  #write(message: JsonObject): Promise<void> {
    if (this.#closed) return Promise.reject(this.#closedError())

    const line = `${JSON.stringify(message)}\n`
    const operation = this.#writeQueue.then(() => this.transport.write(line))
    this.#writeQueue = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  #finish(reason: Error): void {
    if (this.#closed) return
    this.#closed = true
    this.#closeReason = reason

    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(reason)
    }
    this.#pending.clear()
    this.#resolveClosed()
  }

  #closedError(): Error {
    return this.#closeReason ?? new JsonRpcConnectionClosedError("JSON-RPC connection is closed")
  }

  #reportProtocolError(error: JsonRpcProtocolError): void {
    this.options.onProtocolError?.(error)
  }

  #byteLength(value: string): number {
    return this.#encoder.encode(value).byteLength
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
}

function parseErrorPayload(value: unknown): JsonRpcErrorPayload {
  if (!isObject(value)) return { code: -32603, message: "Unknown JSON-RPC error", data: value }

  return {
    code: typeof value.code === "number" ? value.code : -32603,
    message: typeof value.message === "string" ? value.message : "Unknown JSON-RPC error",
    ...(value.data === undefined ? {} : { data: value.data }),
  }
}

function toError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback, { cause: value })
}
