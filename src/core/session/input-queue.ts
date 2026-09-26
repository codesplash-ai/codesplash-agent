import { lstatSync } from "node:fs"
import { resolve } from "node:path"
import type { UserInput } from "../engine.ts"
import { redactSensitiveText } from "../redaction.ts"
import { MemorySessionState, type SessionStateAccess } from "./control.ts"
import { component, digest } from "./files.ts"

export type InputIntent = "follow-up" | "steering" | "interject"
export type InputStatus =
  | "queued"
  | "admitted"
  | "running"
  | "completed"
  | "cancelled"
  | "failed"
  | "blocked"
  | "execution-uncertain"
export type AttachmentReference = {
  kind: "image" | "file" | "inline-image" | "remote-image"
  source: string
  fingerprint?: string
  size?: number
  contentHash?: string
}
export type AcceptedPrompt = {
  id: string
  input: UserInput
  references: AttachmentReference[]
  created: string
  cwd: string
  redacted: boolean
}
export type InputItem = AcceptedPrompt & {
  intent: InputIntent
  status: InputStatus
  fingerprint: string
  updated: string
  issue?: string
  recovered?: boolean
  requiresEdit?: boolean
  boundary?: "new-turn" | "within-turn"
}
export type DraftStash = AcceptedPrompt & { name: string }
type QueueData = {
  version: 1
  epoch: string
  paused: boolean
  items: InputItem[]
  history: AcceptedPrompt[]
  stashes: DraftStash[]
  historyClearedAt?: string
  reviewedForResume?: boolean
}
export type InputQueueSnapshot = QueueData & { revision: string }
export type InputAcknowledgment = { id: string; status: InputStatus; revision: string }
const terminal = new Set<InputStatus>(["completed", "cancelled", "failed"])
const mutable = new Set<InputStatus>(["queued", "blocked"])
const statuses = new Set<InputStatus>([
  "queued",
  "admitted",
  "running",
  "completed",
  "cancelled",
  "failed",
  "blocked",
  "execution-uncertain",
])
const intents = new Set<InputIntent>(["follow-up", "steering", "interject"])

/** Metadata is captured at enqueue; authorized content hashes are attached at admission. */
export function attachmentIdentity(path: string): { fingerprint: string; size: number } | undefined {
  try {
    const info = lstatSync(path, { bigint: true })
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) return undefined
    return {
      size: Number(info.size),
      fingerprint: digest(
        JSON.stringify(
          [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map((value) => value.toString()),
        ),
      ),
    }
  } catch {
    return undefined
  }
}

/** Durable intent model, also used by ephemeral sessions and inactive CLI edits. No execution here. */
export class InputQueue {
  readonly #state: SessionStateAccess
  readonly #raw = new Map<string, { input: UserInput; references: AttachmentReference[] }>()
  readonly #listeners = new Set<() => void>()
  constructor(
    readonly options: {
      state?: SessionStateAccess
      cwd: string
      sanitize?: (text: string) => string
      mentions?: (text: string) => string[]
      recover?: boolean
      history?: AcceptedPrompt[]
      historyClearedAt?: string
    },
  ) {
    this.#state = options.state ?? new MemorySessionState()
    const record = this.#state.read()
    if (record.state.values.inputQueue === undefined)
      this.#state.update(record.revision, "input/initialize", (state) => {
        state.values.inputQueue = {
          version: 1,
          epoch: crypto.randomUUID(),
          paused: false,
          items: [],
          history: [],
          stashes: [],
        } satisfies QueueData
      })
    else this.snapshot()
    if (options.recover !== false) {
      const before = this.snapshot()
      if (before.items.some((item) => !terminal.has(item.status)))
        this.#update(before.revision, "recover", (data) => {
          const reviewed = data.reviewedForResume === true
          data.reviewedForResume = false
          if (!reviewed) data.paused = true
          for (const item of data.items) {
            if (item.status === "admitted" || item.status === "running") {
              data.paused = true
              item.status = "execution-uncertain"
              item.issue =
                "Execution may have started before shutdown; inspect effects before explicitly retrying"
            } else if (item.status === "queued" && !reviewed) {
              item.status = "blocked"
              item.recovered = true
              item.issue = "Recovered pending input; review and resume"
            }
          }
        })
    }
  }
  snapshot(): InputQueueSnapshot {
    const record = this.#state.read(),
      data = record.state.values.inputQueue as QueueData
    if (
      !data ||
      data.version !== 1 ||
      typeof data.epoch !== "string" ||
      !/^[a-f0-9-]{36}$/.test(data.epoch) ||
      typeof data.paused !== "boolean" ||
      !Array.isArray(data.items) ||
      data.items.length > 1000 ||
      !Array.isArray(data.history) ||
      data.history.length > 100 ||
      !Array.isArray(data.stashes) ||
      data.stashes.length > 32
    )
      throw new Error("Unsupported or corrupt input queue; preserve session state before recovery")
    for (const item of data.items)
      if (
        !item ||
        typeof item.id !== "string" ||
        !statuses.has(item.status) ||
        !intents.has(item.intent) ||
        !validPrompt(item) ||
        !/^[a-f0-9]{64}$/.test(item.fingerprint) ||
        !validDate(item.updated) ||
        (item.issue !== undefined && typeof item.issue !== "string") ||
        (item.recovered !== undefined && typeof item.recovered !== "boolean") ||
        (item.requiresEdit !== undefined && typeof item.requiresEdit !== "boolean") ||
        (item.boundary !== undefined && !["new-turn", "within-turn"].includes(item.boundary))
      )
        throw new Error("Corrupt queued input")
    if (
      data.history.some((item) => !validPrompt(item)) ||
      data.stashes.some(
        (item) => !validPrompt(item) || typeof item.name !== "string" || !item.name || item.name.length > 100,
      ) ||
      [data.items, data.history, data.stashes].some(
        (rows) => new Set(rows.map((item) => item.id)).size !== rows.length,
      ) ||
      (data.historyClearedAt !== undefined && !validDate(data.historyClearedAt)) ||
      (data.reviewedForResume !== undefined && typeof data.reviewedForResume !== "boolean")
    )
      throw new Error("Corrupt prompt history or stashes")
    const cleared = [data.historyClearedAt, this.options.historyClearedAt]
      .filter((value): value is string => !!value)
      .sort()
      .at(-1)
    const history = [
      ...new Map([...(this.options.history ?? []), ...data.history].map((item) => [item.id, item])).values(),
    ]
      .filter((item) => item.cwd === this.options.cwd && (!cleared || item.created > cleared))
      .sort((a, b) => b.created.localeCompare(a.created))
      .slice(0, 100)
    return { ...structuredClone(data), history: structuredClone(history), revision: record.revision }
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  newSubmissionId(): string {
    return `${this.snapshot().epoch}.${crypto.randomUUID()}`
  }
  submit(
    input: UserInput,
    intent: InputIntent = "follow-up",
    id = this.newSubmissionId(),
  ): InputAcknowledgment {
    const before = this.snapshot(),
      fingerprint = digest(
        JSON.stringify([
          input.text,
          input.images ?? [],
          input.files ?? [],
          input.sourceText,
          intent,
          this.options.cwd,
        ]),
      )
    component(id)
    if (!intents.has(intent)) throw new Error("Unknown input intent")
    const previous = before.items.find((item) => item.id === id)
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new Error("Submission id already acknowledges different input")
      return { id, status: previous.status, revision: before.revision }
    }
    if (!id.startsWith(`${before.epoch}.`))
      throw new Error("Submission acknowledgment expired; create a new submission id")
    if (
      before.items.filter((item) => !terminal.has(item.status)).length >= 100 ||
      before.items.length >= 1000
    )
      throw new Error("Input queue is full; clear completed items or remove pending input")
    const captured = this.#capture(input, id),
      capture = captured.prompt,
      now = new Date().toISOString()
    const item: InputItem = { ...capture, intent, status: "queued", fingerprint, updated: now }
    const next = this.#update(
      before.revision,
      "submit",
      (data) => {
        data.items.push(item)
        data.history = [capture, ...data.history].slice(0, 100)
        const completed = data.items.filter((item) => terminal.has(item.status))
        for (const item of completed.slice(0, -100)) {
          item.input = { text: "" }
          item.references = []
        }
      },
      false,
    )
    this.#raw.set(id, { input: structuredClone(input), references: captured.references })
    this.#notify()
    return { id, status: item.status, revision: next.revision }
  }
  edit(id: string, input: UserInput, revision: string, intent?: InputIntent): InputQueueSnapshot {
    const captured = this.#capture(input, id),
      capture = captured.prompt
    const next = this.#update(
      revision,
      "edit",
      (data) => {
        const item = this.#item(data, id)
        if (!mutable.has(item.status)) throw new Error("Only queued or blocked input can be edited")
        if (intent && !intents.has(intent)) throw new Error("Unknown input intent")
        data.history = [capture, ...data.history.filter((previous) => previous.id !== id)].slice(0, 100)
        Object.assign(item, capture, {
          status: "queued",
          issue: undefined,
          recovered: false,
          requiresEdit: false,
          updated: new Date().toISOString(),
          ...(intent ? { intent } : {}),
        })
      },
      false,
    )
    this.#raw.set(id, { input: structuredClone(input), references: captured.references })
    this.#notify()
    return next
  }
  move(id: string, position: number, revision: string): InputQueueSnapshot {
    return this.#update(revision, "reorder", (data) => {
      const item = this.#item(data, id)
      if (
        !mutable.has(item.status) ||
        !Number.isInteger(position) ||
        position < 0 ||
        position >= data.items.length
      )
        throw new Error("Invalid queue position or active input")
      data.items.splice(data.items.indexOf(item), 1)
      data.items.splice(position, 0, item)
    })
  }
  remove(id: string, revision: string): InputQueueSnapshot {
    const next = this.#update(revision, "remove", (data) => {
      const item = this.#item(data, id)
      if (item.status === "admitted" || item.status === "running")
        throw new Error("Interrupt active input before removing it")
      item.status = "cancelled"
      item.updated = new Date().toISOString()
    })
    this.#raw.delete(id)
    return next
  }
  retry(id: string, revision: string, acknowledgeUncertain = false): InputQueueSnapshot {
    return this.#update(revision, "retry", (data) => {
      const item = this.#item(data, id)
      if (item.requiresEdit || item.cwd !== this.options.cwd)
        throw new Error("Working directory changed; edit this input and reattach files before retrying")
      if (item.status === "execution-uncertain" && !acknowledgeUncertain)
        throw new Error("Retry may repeat external effects; explicitly acknowledge uncertain execution")
      if (!["blocked", "failed", "cancelled", "execution-uncertain"].includes(item.status))
        throw new Error("This input does not need retry")
      const needsEdit = item.redacted && !this.#raw.has(id)
      item.status = needsEdit ? "blocked" : "queued"
      item.issue = needsEdit ? "Restored input was redacted; edit it before use" : undefined
      item.recovered = false
      item.updated = new Date().toISOString()
    })
  }
  pause(revision = this.snapshot().revision): InputQueueSnapshot {
    const before = this.snapshot()
    if (before.revision !== revision) throw new Error("Session changed; reload before pausing")
    if (before.paused && !before.reviewedForResume) return before
    return this.#update(revision, "pause", (data) => {
      data.paused = true
      data.reviewedForResume = false
    })
  }
  resume(revision = this.snapshot().revision): InputQueueSnapshot {
    return this.#update(revision, "resume", (data) => {
      data.paused = false
      data.reviewedForResume = true
      for (const item of data.items)
        if (
          item.status === "blocked" &&
          item.recovered &&
          !item.requiresEdit &&
          !item.redacted &&
          item.references.every((ref) => ref.kind !== "inline-image")
        ) {
          item.status = "queued"
          item.issue = undefined
          item.recovered = false
        }
    })
  }
  clearCompleted(revision: string): InputQueueSnapshot {
    const result = this.#update(revision, "clear-completed", (data) => {
      data.items = data.items.filter((item) => !terminal.has(item.status))
      data.epoch = crypto.randomUUID()
    })
    this.#pruneRaw()
    return result
  }
  holdForDirectoryChange(): void {
    this.#update(this.snapshot().revision, "directory-review", (data) => {
      data.paused = true
      data.reviewedForResume = false
      for (const item of data.items) {
        item.requiresEdit = true
        if (item.status === "queued" || item.status === "blocked") {
          item.status = "blocked"
          item.recovered = false
          item.issue = "Working directory changed; edit this input and reattach files before use"
        }
      }
    })
    this.#raw.clear()
  }
  clearHistory(revision: string): InputQueueSnapshot {
    const result = this.#update(revision, "clear-history", (data) => {
      data.history = []
      data.historyClearedAt = new Date().toISOString()
    })
    this.#pruneRaw()
    return result
  }
  history(query = ""): AcceptedPrompt[] {
    return this.snapshot().history.filter((item) =>
      item.input.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    )
  }
  saveStash(name: string, input: UserInput, revision: string): DraftStash {
    if (!name.trim() || name.length > 100) throw new Error("Stash name requires 1–100 characters")
    const captured = this.#capture(input, crypto.randomUUID()),
      stash: DraftStash = { ...captured.prompt, name: this.#clean(name.trim()) }
    this.#update(
      revision,
      "stash-save",
      (data) => {
        if (data.stashes.length >= 32 || data.stashes.some((item) => item.name === stash.name))
          throw new Error("Stash name exists or stash limit reached")
        data.stashes.push(stash)
      },
      false,
    )
    this.#raw.set(stash.id, { input: structuredClone(input), references: captured.references })
    this.#notify()
    return stash
  }
  stash(id: string): DraftStash {
    const matches = this.snapshot().stashes.filter((item) => item.id === id || item.name === id)
    if (matches.length !== 1) throw new Error("Stash not found or name is ambiguous")
    return matches[0] as DraftStash
  }
  dropStash(id: string, revision: string): InputQueueSnapshot {
    const stash = this.stash(id),
      next = this.#update(revision, "stash-drop", (data) => {
        data.stashes = data.stashes.filter((item) => item.id !== stash.id)
      })
    this.#raw.delete(stash.id)
    return next
  }
  /** Restores only draft data. The caller performs its draft-revision check before pop. */
  recall(prompt: AcceptedPrompt): UserInput {
    return this.#validatedInput(prompt)
  }
  next(intent?: InputIntent): InputItem | undefined {
    const view = this.snapshot()
    return view.paused
      ? undefined
      : view.items.find((item) => item.status === "queued" && (!intent || item.intent === intent))
  }
  admit(id: string, allowPaused = false, boundary: "new-turn" | "within-turn" = "new-turn"): UserInput {
    const before = this.snapshot(),
      item = this.#item(before, id)
    if (item.status !== "queued" || (before.paused && !allowPaused))
      throw new Error("Input is not ready for admission")
    const input = this.#validatedInput(item)
    this.#update(before.revision, "admit", (data) => {
      const item = this.#item(data, id)
      item.status = "admitted"
      data.reviewedForResume = false
      item.boundary = boundary
      item.updated = new Date().toISOString()
    })
    return input
  }
  references(id: string): AttachmentReference[] {
    return structuredClone(this.#raw.get(id)?.references ?? this.#item(this.snapshot(), id).references)
  }
  recordAttachmentHash(id: string, source: string, hash: string): void {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid attachment hash")
    const refs = this.references(id),
      index = refs.findIndex((ref) => ref.source === source)
    if (index < 0) return
    this.#update(this.snapshot().revision, "attachment-hash", (data) => {
      const ref = this.#item(data, id).references[index]
      if (ref) ref.contentHash = hash
      const historic = data.history.find((item) => item.id === id)?.references[index]
      if (historic) historic.contentHash = hash
    })
  }
  running(id: string): void {
    this.#transition(id, "running")
  }
  finish(
    id: string,
    status: "completed" | "cancelled" | "failed" | "blocked" | "execution-uncertain",
    issue?: string,
  ): void {
    this.#transition(id, status, issue)
    if (terminal.has(status)) this.#pruneRaw()
  }
  #pruneRaw(): void {
    const data = this.snapshot()
    const retained = new Set(
      [...data.items.filter((item) => !terminal.has(item.status)), ...data.history, ...data.stashes].map(
        (item) => item.id,
      ),
    )
    for (const id of this.#raw.keys()) if (!retained.has(id)) this.#raw.delete(id)
  }
  #validatedInput(prompt: AcceptedPrompt): UserInput {
    const raw = this.#raw.get(prompt.id)
    if (prompt.redacted && !raw) throw new Error("Restored prompt was redacted; edit it before use")
    for (const ref of raw?.references ?? prompt.references) {
      if (ref.kind === "inline-image") {
        if (!raw) throw new Error("Inline image bytes are unavailable after restart; attach the image again")
        continue
      }
      if (ref.kind === "remote-image") continue
      const current = attachmentIdentity(ref.source)
      if (!current || !ref.fingerprint || current.fingerprint !== ref.fingerprint)
        throw new Error(
          `Attachment is missing or changed; reattach before admission: ${this.#clean(ref.source)}`,
        )
      if (ref.kind === "image" && current.size > 8 * 1024 * 1024) throw new Error("Image exceeds 8 MiB")
    }
    return structuredClone(raw?.input ?? prompt.input)
  }
  #capture(input: UserInput, id: string): { prompt: AcceptedPrompt; references: AttachmentReference[] } {
    if (
      typeof input.text !== "string" ||
      (input.literal !== undefined && typeof input.literal !== "boolean") ||
      Buffer.byteLength(input.text) > 64 * 1024 ||
      (input.sourceText !== undefined &&
        (typeof input.sourceText !== "string" || Buffer.byteLength(input.sourceText) > 64 * 1024)) ||
      (!input.text.trim() && !input.images?.length && !input.files?.length)
    )
      throw new Error("Prompt requires text or attachments, with text limited to 64 KiB")
    if (
      (input.images !== undefined && (!Array.isArray(input.images) || input.images.length > 16)) ||
      (input.files !== undefined && (!Array.isArray(input.files) || input.files.length > 16))
    )
      throw new Error("At most 16 typed attachment references are allowed")
    const inputBytes = (value: UserInput) =>
      Buffer.byteLength(value.text) +
      Buffer.byteLength(value.sourceText ?? "") +
      (value.images ?? []).reduce(
        (sum, source) => sum + (typeof source === "string" ? Buffer.byteLength(source) : 0),
        0,
      )
    const retained = [...this.#raw.entries()]
      .filter(([key]) => key !== id)
      .reduce((sum, [, value]) => sum + inputBytes(value.input), 0)
    if (retained + inputBytes(input) > 64 * 1024 * 1024)
      throw new Error("In-memory input attachments exceed 64 MiB; remove pending input or stashes")
    const references: AttachmentReference[] = []
    const images = (input.images ?? []).map((source) => {
      if (typeof source !== "string") throw new Error("Invalid image reference")
      if (source.startsWith("data:")) {
        if (source.length > 12 * 1024 * 1024) throw new Error("Inline image exceeds its limit")
        const hash = digest(source)
        references.push({ kind: "inline-image", source: `ephemeral:${hash}`, fingerprint: hash })
        return `ephemeral:${hash}`
      }
      if (/^https?:\/\//.test(source)) {
        references.push({ kind: "remote-image", source, fingerprint: digest(source) })
        return source
      }
      if (source.length > 4096) throw new Error("Image path exceeds 4,096 characters")
      const path = resolve(this.options.cwd, source)
      references.push({ kind: "image", source: path, ...attachmentIdentity(path) })
      return path
    })
    const files = [
      ...new Set([
        ...(input.files ?? []),
        ...(input.literal ? [] : (this.options.mentions?.(input.text) ?? [])),
      ]),
    ]
    if (files.length + images.length > 16) throw new Error("At most 16 attachment references are allowed")
    for (const source of files) {
      if (typeof source !== "string" || source.length > 4096) throw new Error("Invalid file reference")
      const path = resolve(this.options.cwd, source)
      references.push({ kind: "file", source: path, ...attachmentIdentity(path) })
    }
    if (references.length > 16) throw new Error("At most 16 attachment references are allowed")
    const stored: UserInput = {
      text: input.text,
      ...(input.literal === undefined ? {} : { literal: input.literal }),
      ...(input.sourceText === undefined ? {} : { sourceText: input.sourceText }),
      ...(images.length ? { images } : {}),
      ...(input.files?.length ? { files: input.files } : {}),
    }
    const clean = {
      input: {
        ...stored,
        text: this.#clean(stored.text),
        ...(stored.sourceText === undefined ? {} : { sourceText: this.#clean(stored.sourceText) }),
        ...(stored.images ? { images: stored.images.map((value) => this.#clean(value)) } : {}),
        ...(stored.files ? { files: stored.files.map((value) => this.#clean(value)) } : {}),
      },
      references: references.map((ref) => ({ ...ref, source: this.#clean(ref.source) })),
    }
    return {
      prompt: {
        id,
        ...clean,
        created: new Date().toISOString(),
        cwd: this.#clean(this.options.cwd),
        redacted: JSON.stringify(clean) !== JSON.stringify({ input: stored, references }),
      },
      references,
    }
  }
  #clean(text: string): string {
    return this.#state.durable ? (this.options.sanitize ?? redactSensitiveText)(text) : text
  }
  #item(data: QueueData, id: string): InputItem {
    const item = data.items.find((item) => item.id === id)
    if (!item) throw new Error("Queued input not found")
    return item
  }
  #transition(id: string, status: InputStatus, issue?: string): void {
    this.#update(this.snapshot().revision, `status/${status}`, (data) => {
      const item = this.#item(data, id)
      if (status === "running" && item.status !== "admitted")
        throw new Error("Input must be admitted before running")
      item.status = status
      item.issue = issue ? this.#clean(issue) : undefined
      item.updated = new Date().toISOString()
    })
  }
  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch {
        process.stderr.write("codesplash: input queue observer failed\n")
      }
    }
  }
  #update(
    revision: string,
    operation: string,
    change: (data: QueueData) => void,
    notify = true,
  ): InputQueueSnapshot {
    this.#state.update(revision, `input/${operation}`, (state) => {
      const data = state.values.inputQueue as QueueData
      change(data)
    })
    if (notify) this.#notify()
    return this.snapshot()
  }
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value))
}
function validPrompt(value: unknown): value is AcceptedPrompt {
  if (!value || typeof value !== "object") return false
  const item = value as AcceptedPrompt
  return (
    typeof item.id === "string" &&
    /^[a-zA-Z0-9.-]{1,128}$/.test(item.id) &&
    validDate(item.created) &&
    typeof item.cwd === "string" &&
    item.cwd.length <= 4096 &&
    typeof item.redacted === "boolean" &&
    !!item.input &&
    typeof item.input.text === "string" &&
    (item.input.literal === undefined || typeof item.input.literal === "boolean") &&
    Buffer.byteLength(item.input.text) <= 64 * 1024 &&
    (item.input.sourceText === undefined ||
      (typeof item.input.sourceText === "string" && Buffer.byteLength(item.input.sourceText) <= 64 * 1024)) &&
    [item.input.images, item.input.files].every(
      (values) =>
        values === undefined ||
        (Array.isArray(values) &&
          values.length <= 16 &&
          values.every((value) => typeof value === "string" && value.length <= 8192)),
    ) &&
    Array.isArray(item.references) &&
    item.references.length <= 16 &&
    item.references.every(
      (ref) =>
        ref &&
        ["image", "file", "inline-image", "remote-image"].includes(ref.kind) &&
        typeof ref.source === "string" &&
        ref.source.length <= 8192 &&
        [ref.fingerprint, ref.contentHash].every(
          (hash) => hash === undefined || (typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)),
        ) &&
        (ref.size === undefined || (Number.isSafeInteger(ref.size) && ref.size >= 0)),
    )
  )
}
