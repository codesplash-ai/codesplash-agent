/** Persists coalesced session events: full text instead of per-token deltas, never raw payloads. */
import type { AgentEvent, SessionStatus } from "./events.ts"
import type { SessionHandle } from "./sessions.ts"

const MAX_PERSISTED_LINE_BYTES = 256 * 1024
const TRUNCATION_MARKER = "…[truncated]"
const TITLE_LIMIT = 80

export class SessionRecorder {
  readonly #handle: SessionHandle
  readonly #accumulatedText = new Map<string, string>()
  readonly #knownTurnIds: string[] = []
  #chain: Promise<void> = Promise.resolve()
  #failure: Error | undefined
  #lastSequence: number
  #lastStatus: SessionStatus

  constructor(handle: SessionHandle) {
    this.#handle = handle
    this.#lastSequence = handle.meta.lastSequence
    this.#lastStatus = handle.meta.lastStatus
  }

  /** Turn IDs seen in this session's persisted history plus the live stream. */
  get knownTurnIds(): readonly string[] {
    return this.#knownTurnIds
  }

  /** Highest event sequence observed; the next session should start at lastSequence + 1. */
  get lastSequence(): number {
    return this.#lastSequence
  }

  /** First persistence failure, if any; recording stops after it. */
  get failure(): Error | undefined {
    return this.#failure
  }

  /** Seeds coalescing state from events replayed out of the on-disk log. */
  seedFromHistory(events: readonly AgentEvent[]): void {
    for (const event of events) {
      if (event.kind === "turn.started" && event.native?.turnId) this.#knownTurnIds.push(event.native.turnId)
      if (event.sequence > this.#lastSequence) this.#lastSequence = event.sequence
    }
  }

  /** Synchronous tap for SessionController; ordering is preserved by an internal write chain. */
  record = (event: AgentEvent): void => {
    if (this.#failure) return
    if (event.sequence > this.#lastSequence) this.#lastSequence = event.sequence

    switch (event.kind) {
      case "message.delta":
      case "reasoning.delta": {
        const id = event.payload.id
        if (this.#accumulatedText.has(id)) {
          this.#accumulatedText.set(id, this.#accumulatedText.get(id) + event.payload.text)
        } else {
          // Persist one empty-text marker per item so replay creates it at the same
          // transcript position as the live stream did; the text itself stays coalesced.
          this.#accumulatedText.set(id, event.payload.text)
          this.#append({ ...event, payload: { ...event.payload, text: "" } })
        }
        return
      }
      case "message.completed": {
        const text = event.payload.text ?? this.#accumulatedText.get(event.payload.id) ?? ""
        this.#accumulatedText.delete(event.payload.id)
        this.#append({ ...event, payload: { ...event.payload, text } })
        return
      }
      case "reasoning.completed": {
        const text = event.payload.text ?? this.#accumulatedText.get(event.payload.id) ?? ""
        this.#accumulatedText.delete(event.payload.id)
        this.#append({ ...event, payload: { ...event.payload, text } })
        return
      }
      case "turn.started": {
        if (event.native?.turnId) this.#knownTurnIds.push(event.native.turnId)
        this.#append(event)
        return
      }
      case "user.message": {
        if (!this.#handle.meta.title) {
          this.#enqueue(() => this.#handle.updateMeta({ title: makeTitle(event.payload.text) }))
        }
        this.#append(event)
        return
      }
      case "turn.completed": {
        this.#append(event)
        this.#enqueueMetaSync()
        return
      }
      case "session.status": {
        this.#lastStatus = event.payload.status
        this.#append(event)
        this.#enqueueMetaSync()
        return
      }
      default:
        this.#append(event)
    }
  }

  recordNativeSessionId(nativeSessionId: string): void {
    if (this.#failure) return
    this.#enqueue(() => this.#handle.updateMeta({ nativeSessionId }))
  }

  flush(): Promise<void> {
    return this.#chain
  }

  async close(finalStatus?: SessionStatus): Promise<void> {
    if (finalStatus) this.#lastStatus = finalStatus
    this.#enqueueMetaSync()
    await this.#chain
  }

  #append(event: AgentEvent): void {
    const line = serializeEvent(event)
    this.#enqueue(() => this.#handle.appendEventLines([line]))
  }

  #enqueueMetaSync(): void {
    const lastStatus = this.#lastStatus
    const lastSequence = this.#lastSequence
    this.#enqueue(() => this.#handle.updateMeta({ lastStatus, lastSequence }))
  }

  #enqueue(task: () => Promise<void>): void {
    this.#chain = this.#chain.then(async () => {
      if (this.#failure) return
      try {
        await task()
      } catch (error) {
        this.#failure = error instanceof Error ? error : new Error(String(error))
        process.stderr.write(`agent: session history disabled: ${this.#failure.message}\n`)
      }
    })
  }
}

/** Serializes an event without its raw provider payload, bounded to one JSONL line budget. */
export function serializeEvent(event: AgentEvent): string {
  const { raw: _raw, ...persistable } = event
  let line = JSON.stringify(persistable)
  if (Buffer.byteLength(line) <= MAX_PERSISTED_LINE_BYTES) return line

  const payload = { ...persistable.payload } as Record<string, unknown>
  const textFields = ["text", "output", "unified", "detail"]
    .filter((field) => typeof payload[field] === "string")
    .sort((a, b) => (payload[b] as string).length - (payload[a] as string).length)

  for (const field of textFields) {
    const value = payload[field] as string
    const excess = Buffer.byteLength(line) - MAX_PERSISTED_LINE_BYTES
    if (excess <= 0) break
    payload[field] = truncateUtf8(value, Math.max(0, value.length - excess)) + TRUNCATION_MARKER
    line = JSON.stringify({ ...persistable, payload })
  }
  return line
}

function truncateUtf8(value: string, length: number): string {
  let result = value.slice(0, length)
  // Avoid splitting a surrogate pair at the cut point.
  const last = result.charCodeAt(result.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) result = result.slice(0, -1)
  return result
}

function makeTitle(text: string): string {
  const singleLine = text.replaceAll(/\s+/g, " ").trim()
  return singleLine.length > TITLE_LIMIT ? `${singleLine.slice(0, TITLE_LIMIT - 1)}…` : singleLine
}
