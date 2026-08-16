import {
  type AgentEvent,
  type AgentEventInput,
  AsyncQueue,
  type UserInput as CoreUserInput,
  defaultSessionPolicy,
  type EngineCapabilities,
  type EngineDecision,
  type EngineDriver,
  type EngineProbe,
  type EngineSession,
  type OpenSessionOptions,
  redactSensitiveText,
} from "../../core/index.ts"
import { CodexAppServerClient, SUPPORTED_CODEX_CLI_VERSION } from "./app-server-client.ts"
import type { CodexAppServerProcessOptions } from "./app-server-process.ts"
import type { CommandExecutionRequestApprovalParams } from "./generated/v2/CommandExecutionRequestApprovalParams.ts"
import type { FileChangeRequestApprovalParams } from "./generated/v2/FileChangeRequestApprovalParams.ts"
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.ts"
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse.ts"
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.ts"
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse.ts"
import type { TurnInterruptParams } from "./generated/v2/TurnInterruptParams.ts"
import type { TurnStartParams } from "./generated/v2/TurnStartParams.ts"
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.ts"
import type { UserInput } from "./generated/v2/UserInput.ts"
import type { JsonRpcRequest } from "./json-rpc.ts"
import { CodexEventNormalizer, normalizeItem } from "./normalize.ts"

const CODEX_CAPABILITIES: EngineCapabilities = {
  nativeTranscript: true,
  approvals: true,
  interrupt: true,
  resume: true,
  fork: true,
  usage: "tokens",
  surface: "native",
}

type PendingServerRequest = {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
}

export class CodexDriver implements EngineDriver {
  readonly id = "codex" as const

  constructor(readonly processOptions: CodexAppServerProcessOptions = {}) {}

  async probe(): Promise<EngineProbe> {
    let client: CodexAppServerClient | undefined
    try {
      const binary = this.processOptions.binary ?? Bun.which("codex")
      if (!binary) return { available: false, detail: "Codex CLI is not installed" }

      const versionProcess = Bun.spawn([binary, "--version"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const [versionOutput, versionError, exitCode] = await Promise.all([
        new Response(versionProcess.stdout).text(),
        new Response(versionProcess.stderr).text(),
        versionProcess.exited,
      ])
      if (exitCode !== 0) {
        return {
          available: false,
          detail: redactSensitiveText(versionError.trim()) || "codex --version failed",
        }
      }

      const version = versionOutput.trim().match(/\d+\.\d+\.\d+/)?.[0]
      const compatible = version === SUPPORTED_CODEX_CLI_VERSION
      client = new CodexAppServerClient({ ...this.processOptions, binary })
      await client.initialize()
      const account = await client.readAccount()
      const accountLabel = describeAccount(account.account)
      return {
        available: true,
        authenticated: account.account !== null,
        compatible,
        version,
        detail: compatible
          ? accountLabel
          : `${accountLabel} · protocol baseline is ${SUPPORTED_CODEX_CLI_VERSION}`,
      }
    } catch (error) {
      return { available: false, detail: error instanceof Error ? error.message : String(error) }
    } finally {
      await client?.close()
    }
  }

  async openSession(options: OpenSessionOptions): Promise<EngineSession> {
    const client = new CodexAppServerClient({ ...this.processOptions, cwd: options.cwd })
    const session = new CodexSession(client, options)
    try {
      await client.initialize()
      await session.open()
      return session
    } catch (error) {
      await session.close()
      throw error
    }
  }
}

function describeAccount(
  account: Awaited<ReturnType<CodexAppServerClient["readAccount"]>>["account"],
): string {
  if (!account) return "Not signed in"
  if (account.type === "chatgpt") return `ChatGPT ${account.planType}`
  if (account.type === "apiKey") return "OpenAI API key"
  return "Amazon Bedrock"
}

class CodexSession implements EngineSession {
  readonly capabilities = CODEX_CAPABILITIES
  readonly events: AsyncIterable<AgentEvent>
  readonly #eventQueue = new AsyncQueue<AgentEvent>()
  readonly #normalizer: CodexEventNormalizer
  readonly #pendingRequests = new Map<string, PendingServerRequest>()
  readonly #unsubscribeNotification: () => void
  #threadId: string | undefined
  #turnId: string | undefined
  #model: string | undefined
  #closed = false

  constructor(
    readonly client: CodexAppServerClient,
    readonly options: OpenSessionOptions,
  ) {
    this.events = this.#eventQueue
    this.#normalizer = new CodexEventNormalizer(options.localSessionId, options.firstSequence ?? 0)
    this.#unsubscribeNotification = client.process.connection.onNotification((notification) => {
      const notificationThreadId = getStringField(notification.params, "threadId")
      if (this.#threadId && notificationThreadId && notificationThreadId !== this.#threadId) return

      for (const event of this.#normalizer.normalize(notification)) {
        if (event.kind === "turn.started") this.#turnId = event.native?.turnId
        if (event.kind === "turn.completed") this.#turnId = undefined
        this.#eventQueue.push(event)
      }
    })
    client.process.connection.setRequestHandler((request) => this.#handleServerRequest(request))

    this.#eventQueue.push(
      this.#normalizer.event(
        "session/opening",
        undefined,
        {},
        {
          kind: "session.status",
          payload: { status: "starting" },
        },
      ),
    )

    void Promise.all([client.process.connection.waitForClose(), client.process.exited]).then(
      ([, exitCode]) => {
        if (!this.#closed) {
          const diagnostics = client.process.getStderr().trim()
          for (const [requestId, pending] of this.#pendingRequests) {
            pending.reject(new Error("Codex app-server exited while awaiting approval"))
            this.#eventQueue.push(
              this.#normalizer.event(
                "process/requestCancelled",
                undefined,
                { threadId: this.#threadId, turnId: this.#turnId, requestId },
                { kind: "request.resolved", payload: { id: requestId, decision: "cancel" } },
              ),
            )
          }
          this.#pendingRequests.clear()
          this.#eventQueue.push(
            this.#normalizer.event(
              "process/exited",
              undefined,
              { threadId: this.#threadId, turnId: this.#turnId },
              { kind: "session.status", payload: { status: "failed" } },
            ),
          )
          this.#eventQueue.push(
            this.#normalizer.event(
              "process/exited",
              undefined,
              { threadId: this.#threadId },
              {
                kind: "error",
                payload: {
                  message: [
                    `Codex app-server exited with status ${exitCode}`,
                    diagnostics ? diagnostics.split(/\r?\n/).at(-1) : undefined,
                  ]
                    .filter(Boolean)
                    .join(": "),
                  recoverable: true,
                },
              },
            ),
          )
        }
        this.#eventQueue.end()
      },
    )
  }

  get localSessionId(): string {
    return this.options.localSessionId
  }

  get nativeSessionId(): string | undefined {
    return this.#threadId
  }

  async open(): Promise<void> {
    const policy = this.options.policy ?? defaultSessionPolicy
    const common = {
      cwd: this.options.cwd,
      model: this.options.model,
      approvalPolicy: policy.approvalPolicy,
      approvalsReviewer: "user" as const,
      sandbox: policy.sandbox,
    }

    let resumedThread: ThreadResumeResponse["thread"] | undefined
    if (this.options.nativeSessionId) {
      const params: ThreadResumeParams = { threadId: this.options.nativeSessionId, ...common }
      const response = await this.client.process.connection.request<ThreadResumeResponse>(
        "thread/resume",
        params,
      )
      this.#threadId = response.thread.id
      this.#model = response.model
      resumedThread = response.thread
    } else {
      const params: ThreadStartParams = { ...common, ephemeral: false }
      const response = await this.client.process.connection.request<ThreadStartResponse>(
        "thread/start",
        params,
      )
      this.#threadId = response.thread.id
      this.#model = response.model
    }

    this.#eventQueue.push(
      this.#normalizer.event(
        "session/opened",
        undefined,
        { threadId: this.#threadId },
        {
          kind: "session.status",
          payload: { status: "ready", model: this.#model },
        },
      ),
    )

    if (resumedThread) this.#reconcileResumedTurns(resumedThread)
  }

  /** Synthesizes events for provider turns missing from local history so both sides converge. */
  #reconcileResumedTurns(thread: ThreadResumeResponse["thread"]): void {
    const known = new Set(this.options.knownTurnIds ?? [])
    for (const turn of thread.turns ?? []) {
      if (known.has(turn.id)) continue

      const native = { threadId: thread.id, turnId: turn.id }
      const push = (event: AgentEventInput, itemId?: string, sensitive = false) => {
        this.#eventQueue.push(
          this.#normalizer.event("thread/resume", undefined, { ...native, itemId }, event, sensitive),
        )
      }

      push({ kind: "turn.started", payload: {} })
      for (const item of turn.items) {
        if (item.type === "userMessage") {
          const text = item.content
            .map((input) => (input.type === "text" ? input.text : ""))
            .filter(Boolean)
            .join("\n")
          push({ kind: "user.message", payload: { id: item.id, text } }, item.id, true)
        } else if (item.type === "agentMessage") {
          push({ kind: "message.completed", payload: { id: item.id, text: item.text } }, item.id, true)
        } else if (item.type === "reasoning") {
          const text = (item.summary.length > 0 ? item.summary : item.content).join("\n")
          push({ kind: "reasoning.completed", payload: { id: item.id, text } }, item.id, true)
        } else {
          const normalized = normalizeItem(item, turn.status === "inProgress" ? "failed" : "completed")
          if (normalized) push(normalized, item.id, true)
        }
      }
      push({
        kind: "turn.completed",
        payload: { status: turn.status === "inProgress" ? "failed" : turn.status },
      })
    }
  }

  async send(input: CoreUserInput): Promise<void> {
    const threadId = this.#requireThread()
    if (this.#turnId) throw new Error("A Codex turn is already running")

    this.#eventQueue.push(
      this.#normalizer.event(
        "client/userMessage",
        input,
        { threadId },
        {
          kind: "user.message",
          payload: { id: crypto.randomUUID(), text: input.text },
        },
        true,
      ),
    )

    const params: TurnStartParams = {
      threadId,
      input: toCodexInput(input),
      summary: "auto",
    }
    const response = await this.client.process.connection.request<TurnStartResponse>("turn/start", params)
    this.#turnId = response.turn.id
  }

  async resolveRequest(requestId: string, decision: EngineDecision): Promise<void> {
    const pending = this.#pendingRequests.get(requestId)
    if (!pending) throw new Error(`Unknown Codex request ${requestId}`)

    const allowed = new Set(["accept", "acceptForSession", "decline", "cancel"])
    if (!allowed.has(decision.choice))
      throw new Error(`Unsupported Codex approval decision ${decision.choice}`)

    this.#pendingRequests.delete(requestId)
    pending.resolve({ decision: decision.choice })
    this.#eventQueue.push(
      this.#normalizer.event(
        "serverRequest/resolved",
        undefined,
        { threadId: this.#threadId, turnId: this.#turnId, requestId },
        { kind: "request.resolved", payload: { id: requestId, decision: decision.choice } },
      ),
    )
  }

  async interrupt(): Promise<void> {
    const threadId = this.#requireThread()
    if (!this.#turnId) return

    const params: TurnInterruptParams = { threadId, turnId: this.#turnId }
    await this.client.process.connection.request("turn/interrupt", params)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#unsubscribeNotification()
    this.client.process.connection.setRequestHandler(undefined)

    for (const pending of this.#pendingRequests.values()) {
      pending.reject(new Error("Codex session closed while awaiting approval"))
    }
    this.#pendingRequests.clear()

    await this.client.close()
  }

  #handleServerRequest(request: JsonRpcRequest): Promise<unknown> {
    if (
      request.method !== "item/commandExecution/requestApproval" &&
      request.method !== "item/fileChange/requestApproval"
    ) {
      throw new Error(`Unsupported Codex server request ${request.method}`)
    }

    const requestId = String(request.id)
    if (this.#pendingRequests.has(requestId)) throw new Error(`Duplicate Codex request ${requestId}`)

    const description = describeApproval(request)
    this.#eventQueue.push(
      this.#normalizer.event(
        request.method,
        request.params,
        {
          threadId: getStringField(request.params, "threadId") ?? this.#threadId,
          turnId: getStringField(request.params, "turnId") ?? this.#turnId,
          itemId: getStringField(request.params, "itemId"),
          requestId,
        },
        {
          kind: "request.opened",
          payload: {
            id: requestId,
            requestKind: "approval",
            title: description.title,
            detail: description.detail,
            choices: ["accept", "acceptForSession", "decline", "cancel"],
          },
        },
        true,
      ),
    )

    return new Promise((resolve, reject) => {
      this.#pendingRequests.set(requestId, { method: request.method, resolve, reject })
    })
  }

  #requireThread(): string {
    if (this.#closed) throw new Error("Codex session is closed")
    if (!this.#threadId) throw new Error("Codex session is not open")
    return this.#threadId
  }
}

function toCodexInput(input: CoreUserInput): UserInput[] {
  const result: UserInput[] = [{ type: "text", text: input.text, text_elements: [] }]
  for (const image of input.images ?? []) {
    result.push(
      /^(data:|https?:)/.test(image) ? { type: "image", url: image } : { type: "localImage", path: image },
    )
  }
  return result
}

function describeApproval(request: JsonRpcRequest): { title: string; detail: string } {
  if (request.method === "item/commandExecution/requestApproval") {
    const params = request.params as CommandExecutionRequestApprovalParams
    return {
      title: "Run command?",
      detail: [params.command, params.cwd, params.reason].filter(Boolean).join("\n"),
    }
  }

  const params = request.params as FileChangeRequestApprovalParams
  return {
    title: "Apply file changes?",
    detail: params.reason ?? params.grantRoot ?? "Codex requested permission to change files.",
  }
}

function getStringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === "string" ? field : undefined
}
