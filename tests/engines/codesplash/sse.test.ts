import { describe, expect, test } from "bun:test"
import { parseSseStream, type SseEvent } from "../../../src/engines/codesplash/providers/sse.ts"

const encoder = new TextEncoder()

function responseOf(...chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream)
}

function pushableResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController
    },
  })
  return {
    response: new Response(stream),
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    fail: (error: unknown) => controller.error(error),
  }
}

async function collect(response: Response, signal?: AbortSignal): Promise<SseEvent[]> {
  const events: SseEvent[] = []
  for await (const event of parseSseStream(response, signal)) events.push(event)
  return events
}

describe("parseSseStream", () => {
  test("parses simple events", async () => {
    const events = await collect(responseOf("data: hello\n\ndata: world\n\n"))
    expect(events).toEqual([{ data: "hello" }, { data: "world" }])
  })

  test("joins multi-line data fields with newlines", async () => {
    const events = await collect(responseOf("data: line one\ndata: line two\ndata: line three\n\n"))
    expect(events).toEqual([{ data: "line one\nline two\nline three" }])
  })

  test("handles CRLF and lone-CR line endings", async () => {
    const events = await collect(responseOf("event: ping\r\ndata: a\r\ndata: b\r\n\r\ndata: c\r\r"))
    expect(events).toEqual([{ event: "ping", data: "a\nb" }, { data: "c" }])
  })

  test("does not split a CRLF pair straddling a chunk boundary", async () => {
    const events = await collect(responseOf("data: first\r", "\ndata: second\r\n", "\r\n"))
    expect(events).toEqual([{ data: "first\nsecond" }])
  })

  test("reassembles lines split across many chunks", async () => {
    const events = await collect(responseOf("da", "ta: hel", "lo\n", "\nda", "ta: bye\n\n"))
    expect(events).toEqual([{ data: "hello" }, { data: "bye" }])
  })

  test("reassembles a UTF-8 sequence split across chunks", async () => {
    const bytes = encoder.encode("data: café\n\n")
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 10))
        controller.enqueue(bytes.slice(10))
        controller.close()
      },
    })
    const events = await collect(new Response(stream))
    expect(events).toEqual([{ data: "café" }])
  })

  test("ignores comment lines", async () => {
    const events = await collect(
      responseOf(": keep-alive\ndata: real\n: mid-event comment\ndata: two\n\n:\n"),
    )
    expect(events).toEqual([{ data: "real\ntwo" }])
  })

  test("attaches event names and resets them between events", async () => {
    const events = await collect(
      responseOf("event: message_start\ndata: {}\n\ndata: plain\n\nevent: done\ndata: [DONE]\n\n"),
    )
    expect(events).toEqual([
      { event: "message_start", data: "{}" },
      { data: "plain" },
      { event: "done", data: "[DONE]" },
    ])
    expect(events[1]?.event).toBeUndefined()
  })

  test("an event field without data dispatches nothing and does not leak its name", async () => {
    const events = await collect(responseOf("event: orphan\n\ndata: next\n\n"))
    expect(events).toEqual([{ data: "next" }])
    expect(events[0]?.event).toBeUndefined()
  })

  test("strips only a single leading space from field values", async () => {
    const events = await collect(responseOf("data:no-space\n\ndata:  two-spaces\n\n"))
    expect(events).toEqual([{ data: "no-space" }, { data: " two-spaces" }])
  })

  test("a field name with no colon is treated as an empty value", async () => {
    const events = await collect(responseOf("data\n\n"))
    expect(events).toEqual([{ data: "" }])
  })

  test("ignores id and retry fields and unknown fields", async () => {
    const events = await collect(responseOf("id: 7\nretry: 100\nmystery: x\ndata: kept\n\n"))
    expect(events).toEqual([{ data: "kept" }])
  })

  test("blank lines with no pending data dispatch nothing", async () => {
    const events = await collect(responseOf("\n\n\ndata: only\n\n\n"))
    expect(events).toEqual([{ data: "only" }])
  })

  test("delivers a trailing event missing its final blank line", async () => {
    const events = await collect(responseOf("data: complete\n\ndata: tail"))
    expect(events).toEqual([{ data: "complete" }, { data: "tail" }])
  })

  test("yields nothing for an empty body", async () => {
    expect(await collect(responseOf(""))).toEqual([])
    expect(await collect(new Response(null))).toEqual([])
  })

  test("ends cleanly when aborted between events", async () => {
    const { response, push } = pushableResponse()
    const controller = new AbortController()
    const iterator = parseSseStream(response, controller.signal)[Symbol.asyncIterator]()

    push("data: first\n\n")
    expect(await iterator.next()).toEqual({ done: false, value: { data: "first" } })

    controller.abort()
    expect((await iterator.next()).done).toBe(true)
  })

  test("a pending read unblocks and ends cleanly on abort", async () => {
    const { response } = pushableResponse()
    const controller = new AbortController()
    const pending = collect(response, controller.signal)
    setTimeout(() => controller.abort(), 10)
    expect(await pending).toEqual([])
  })

  test("an already-aborted signal yields nothing", async () => {
    const controller = new AbortController()
    controller.abort()
    const events = await collect(responseOf("data: never\n\n"), controller.signal)
    expect(events).toEqual([])
  })

  test("does not flush a partial event on abort", async () => {
    const { response, push } = pushableResponse()
    const controller = new AbortController()
    const iterator = parseSseStream(response, controller.signal)[Symbol.asyncIterator]()

    push("data: first\n\ndata: partial\n")
    expect(await iterator.next()).toEqual({ done: false, value: { data: "first" } })

    controller.abort()
    expect((await iterator.next()).done).toBe(true)
  })

  test("propagates stream failures that are not aborts", async () => {
    const { response, push, fail } = pushableResponse()
    const iterator = parseSseStream(response)[Symbol.asyncIterator]()

    push("data: ok\n\n")
    expect(await iterator.next()).toEqual({ done: false, value: { data: "ok" } })

    fail(new Error("connection reset"))
    await expect(iterator.next()).rejects.toThrow("connection reset")
  })

  test("releases the source stream when the consumer stops early", async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: one\n\ndata: two\n\n"))
      },
      cancel() {
        cancelled = true
      },
    })
    for await (const event of parseSseStream(new Response(stream))) {
      expect(event).toEqual({ data: "one" })
      break
    }
    expect(cancelled).toBe(true)
  })
})
