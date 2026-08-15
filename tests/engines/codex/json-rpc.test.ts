import { describe, expect, test } from "bun:test"
import {
  JsonRpcConnection,
  JsonRpcConnectionClosedError,
  JsonRpcRequestTimeoutError,
  type JsonRpcTransport,
} from "../../../src/engines/codex/json-rpc.ts"

class ChunkQueue implements AsyncIterable<string | Uint8Array> {
  readonly #values: Array<string | Uint8Array> = []
  readonly #waiters: Array<(result: IteratorResult<string | Uint8Array>) => void> = []
  #ended = false

  push(value: string | Uint8Array): void {
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ done: false, value })
    else this.#values.push(value)
  }

  end(): void {
    this.#ended = true
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array> {
    return {
      next: () => {
        const value = this.#values.shift()
        if (value !== undefined) return Promise.resolve({ done: false, value })
        if (this.#ended) return Promise.resolve({ done: true, value: undefined })
        return new Promise((resolve) => this.#waiters.push(resolve))
      },
    }
  }
}

function createHarness(overrides: Partial<JsonRpcTransport> = {}) {
  const chunks = new ChunkQueue()
  const writes: string[] = []
  const transport: JsonRpcTransport = {
    chunks,
    write(line) {
      writes.push(line)
    },
    close() {
      chunks.end()
    },
    ...overrides,
  }
  return { chunks, transport, writes }
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      assertion()
      return
    } catch {
      await Bun.sleep(1)
    }
  }
  assertion()
}

describe("JsonRpcConnection", () => {
  test("frames split chunks and preserves notification order", async () => {
    const { chunks, transport, writes } = createHarness()
    const notifications: string[] = []
    const connection = new JsonRpcConnection(transport, {
      onNotification(notification) {
        notifications.push(notification.method)
      },
    })

    const response = connection.request<{ account: string }>("account/read", {})
    await eventually(() => expect(writes).toHaveLength(1))
    const outbound = JSON.parse(writes[0] ?? "{}")

    chunks.push('{"method":"thread/started","params":{"threadId":"t1"}}\n{"met')
    chunks.push(`hod":"turn/started","params":{}}\n{"id":${outbound.id},"result":{"account":"chatgpt"}}\n`)

    await expect(response).resolves.toEqual({ account: "chatgpt" })
    expect(notifications).toEqual(["thread/started", "turn/started"])
    await connection.close()
  })

  test("correlates responses that arrive out of order", async () => {
    const { chunks, transport, writes } = createHarness()
    const connection = new JsonRpcConnection(transport)
    const first = connection.request<string>("first")
    const second = connection.request<string>("second")
    await eventually(() => expect(writes).toHaveLength(2))

    const firstId = JSON.parse(writes[0] ?? "{}").id
    const secondId = JSON.parse(writes[1] ?? "{}").id
    chunks.push(`{"id":${secondId},"result":"two"}\n{"id":${firstId},"result":"one"}\n`)

    await expect(first).resolves.toBe("one")
    await expect(second).resolves.toBe("two")
    await connection.close()
  })

  test("answers server-initiated requests", async () => {
    const { chunks, transport, writes } = createHarness()
    const connection = new JsonRpcConnection(transport, {
      onRequest(request) {
        expect(request.method).toBe("item/commandExecution/requestApproval")
        return { decision: "decline" }
      },
    })

    chunks.push(
      '{"id":"approval-1","method":"item/commandExecution/requestApproval","params":{"command":"false"}}\n',
    )
    await eventually(() => expect(writes).toHaveLength(1))

    expect(JSON.parse(writes[0] ?? "{}")).toEqual({
      id: "approval-1",
      result: { decision: "decline" },
    })
    await connection.close()
  })

  test("isolates malformed and oversized lines", async () => {
    const { chunks, transport, writes } = createHarness()
    const errors: string[] = []
    const connection = new JsonRpcConnection(transport, {
      maxLineBytes: 64,
      onProtocolError(error) {
        errors.push(error.message)
      },
    })

    const response = connection.request<string>("still-alive")
    await eventually(() => expect(writes).toHaveLength(1))
    const id = JSON.parse(writes[0] ?? "{}").id

    chunks.push("not-json\n")
    chunks.push(`${"x".repeat(80)}\n`)
    chunks.push(`{"id":${id},"result":"ok"}\n`)

    await expect(response).resolves.toBe("ok")
    expect(errors).toEqual(["Malformed JSON-RPC line", "JSON-RPC line exceeded 64 bytes"])
    await connection.close()
  })

  test("rejects timed out and pending requests", async () => {
    const { chunks, transport } = createHarness()
    const connection = new JsonRpcConnection(transport, { defaultTimeoutMs: 5 })

    await expect(connection.request("slow")).rejects.toBeInstanceOf(JsonRpcRequestTimeoutError)

    const pending = connection.request("pending", undefined, 1_000)
    chunks.end()
    await expect(pending).rejects.toBeInstanceOf(JsonRpcConnectionClosedError)
    expect(connection.isClosed).toBe(true)
  })
})
