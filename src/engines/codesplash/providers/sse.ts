/**
 * Incremental server-sent-events parser for provider streams. Tolerates multi-line `data:`
 * fields, comment lines, CRLF/CR line endings, and chunk boundaries anywhere — including inside
 * a CRLF pair or a UTF-8 sequence. Aborting the signal ends the iteration cleanly (no throw).
 */

export type SseEvent = { event?: string; data: string }

export async function* parseSseStream(response: Response, signal?: AbortSignal): AsyncIterable<SseEvent> {
  const body = response.body
  if (!body) return
  const reader = body.getReader()
  const cancelReader = () => {
    reader.cancel().catch(() => {})
  }
  if (signal?.aborted) {
    cancelReader()
    return
  }
  signal?.addEventListener("abort", cancelReader, { once: true })

  const decoder = new TextDecoder()
  let buffered = ""
  let dataLines: string[] = []
  let eventName: string | undefined

  const finishLine = (line: string): SseEvent | undefined => {
    if (line === "") {
      if (dataLines.length === 0) {
        eventName = undefined
        return undefined
      }
      const finished: SseEvent = { data: dataLines.join("\n") }
      if (eventName !== undefined) finished.event = eventName
      dataLines = []
      eventName = undefined
      return finished
    }
    if (line.startsWith(":")) return undefined
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "data") dataLines.push(value)
    else if (field === "event") eventName = value
    return undefined
  }

  try {
    while (true) {
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try {
        chunk = await reader.read()
      } catch (error) {
        if (signal?.aborted) return
        throw error
      }
      if (signal?.aborted) return
      if (chunk.done) break
      buffered += decoder.decode(chunk.value, { stream: true })
      const { lines, rest } = splitLines(buffered, false)
      buffered = rest
      for (const line of lines) {
        const finished = finishLine(line)
        if (finished) yield finished
        if (signal?.aborted) return
      }
    }
    buffered += decoder.decode()
    const { lines, rest } = splitLines(buffered, true)
    if (rest !== "") lines.push(rest)
    for (const line of lines) {
      const finished = finishLine(line)
      if (finished) yield finished
    }
    // Tolerance: an event the stream ended on without its terminating blank line still counts.
    const trailing = finishLine("")
    if (trailing) yield trailing
  } finally {
    signal?.removeEventListener("abort", cancelReader)
    cancelReader()
  }
}

/** A trailing bare CR is held back unless atEnd — the LF of a split CRLF may be in flight. */
function splitLines(buffer: string, atEnd: boolean): { lines: string[]; rest: string } {
  const lines: string[] = []
  let index = 0
  while (index < buffer.length) {
    const cr = buffer.indexOf("\r", index)
    const lf = buffer.indexOf("\n", index)
    if (cr === -1 && lf === -1) break
    if (cr !== -1 && (lf === -1 || cr < lf)) {
      if (cr === buffer.length - 1 && !atEnd) break
      lines.push(buffer.slice(index, cr))
      index = buffer[cr + 1] === "\n" ? cr + 2 : cr + 1
    } else {
      lines.push(buffer.slice(index, lf))
      index = lf + 1
    }
  }
  return { lines, rest: buffer.slice(index) }
}
