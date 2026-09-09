import type { SessionUsageSnapshot } from "../../core/engine.ts"
import {
  type AgentEvent,
  type AgentEventInput,
  AsyncQueue,
  type UserInput as CoreUserInput,
  defaultSessionPolicy,
  type EngineCapabilities,
  type EngineDecision,
  type EngineDriver,
  type EngineModel,
  type EngineProbe,
  type EngineSession,
  type OpenSessionOptions,
  redactSensitiveText,
} from "../../core/index.ts"
import { BranchStore } from "../../core/session/branches.ts"
import { MemorySessionState } from "../../core/session/control.ts"
import { forkLocalSession } from "../../core/session/fork.ts"
import { type InputIntent, InputQueue } from "../../core/session/input-queue.ts"
import type { RecoveryRequest, RecoveryResult } from "../../core/session/recovery-contract.ts"
import {
  CodexAppServerClient,
  codexVersionCompatibility,
  MINIMUM_CODEX_CLI_VERSION,
  SUPPORTED_CODEX_CLI_VERSION,
} from "./app-server-client.ts"
import type { CodexAppServerProcessOptions } from "./app-server-process.ts"
import type { CommandExecutionRequestApprovalParams } from "./generated/v2/CommandExecutionRequestApprovalParams.ts"
import type { FileChangeRequestApprovalParams } from "./generated/v2/FileChangeRequestApprovalParams.ts"
import type { ThreadForkParams } from "./generated/v2/ThreadForkParams.ts"
import type { ThreadForkResponse } from "./generated/v2/ThreadForkResponse.ts"
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.ts"
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse.ts"
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.ts"
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse.ts"
import type { TurnInterruptParams } from "./generated/v2/TurnInterruptParams.ts"
import type { TurnStartParams } from "./generated/v2/TurnStartParams.ts"
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.ts"
import type { TurnSteerParams } from "./generated/v2/TurnSteerParams.ts"
import type { TurnSteerResponse } from "./generated/v2/TurnSteerResponse.ts"
import type { UserInput } from "./generated/v2/UserInput.ts"
import type { JsonRpcRequest } from "./json-rpc.ts"
import { CodexEventNormalizer, normalizeItem } from "./normalize.ts"
import { CodexQueuedTurns } from "./queued-turns.ts"

const CODEX_CAPABILITIES: EngineCapabilities = {
  nativeTranscript: true,
  approvals: true,
  interrupt: true,
  resume: true,
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
      const compatibility = codexVersionCompatibility(version)
      client = new CodexAppServerClient({ ...this.processOptions, binary })
      await client.initialize()
      const account = await client.readAccount()
      const accountLabel = describeAccount(account.account)
      return {
        available: true,
        authenticated: account.account !== null,
        compatible: compatibility.compatible,
        version,
        detail: compatibility.compatible
          ? [accountLabel, compatibility.warning].filter(Boolean).join(" · ")
          : `${accountLabel} · requires Codex CLI ${MINIMUM_CODEX_CLI_VERSION} or newer — install with: npm i -g @openai/codex@${SUPPORTED_CODEX_CLI_VERSION}`,
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
  readonly inputQueue: InputQueue
  readonly #branches: BranchStore
  #recoveryBusy = false
  #eventStart = 0
  #lastPromptId: string | undefined
  #lastPrompt = "Provider turn"
  #usage: SessionUsageSnapshot = {}
  readonly #turns: CodexQueuedTurns
  readonly #normalizer: CodexEventNormalizer
  readonly #pendingRequests = new Map<string, PendingServerRequest>()
  readonly #unsubscribeNotification: () => void
  #threadId: string | undefined
  #turnId: string | undefined
  #model: string | undefined
  #modelOverride: string | undefined
  #closed = false

  constructor(
    readonly client: CodexAppServerClient,
    readonly options: OpenSessionOptions,
  ) {
    this.events = this.#eventQueue
    this.#normalizer = new CodexEventNormalizer(options.localSessionId, options.firstSequence ?? 0)
    const state = options.sessionState ?? new MemorySessionState()
    this.#branches = new BranchStore(state)
    this.inputQueue = new InputQueue({
      state,
      cwd: options.cwd,
      ...options.promptHistory,
    })
    this.#turns = new CodexQueuedTurns(this.inputQueue, {
      busy: () => this.#recoveryBusy,
      start: (input, id) => this.#start(input, id),
      steer: async (input, id, expectedTurnId) => {
        const params: TurnSteerParams = {
          threadId: this.#requireThread(),
          clientUserMessageId: id,
          input: toCodexInput(input),
          expectedTurnId,
        }
        this.#userMessage(input, id)
        const response = await client.process.connection.request<TurnSteerResponse>("turn/steer", params)
        return response.turnId
      },
      interrupt: async (turnId) => {
        const params: TurnInterruptParams = { threadId: this.#requireThread(), turnId }
        await client.process.connection.request("turn/interrupt", params)
      },
      error: (error) =>
        this.#eventQueue.push(
          this.#normalizer.event(
            "queue/error",
            undefined,
            { threadId: this.#threadId },
            { kind: "error", payload: { message: error.message, recoverable: true } },
          ),
        ),
    })
    this.#unsubscribeNotification = client.process.connection.onNotification((notification) => {
      const notificationThreadId = getStringField(notification.params, "threadId")
      if (this.#threadId && notificationThreadId && notificationThreadId !== this.#threadId) return

      for (const event of this.#normalizer.normalize(notification)) {
        if (event.kind === "usage.updated")
          this.#usage = Object.fromEntries(
            Object.entries({
              inputTokens: event.payload.inputTokens,
              outputTokens: event.payload.outputTokens,
              cachedInputTokens: event.payload.cachedInputTokens,
            }).filter(([, value]) => value !== undefined),
          )
        if (
          event.kind === "turn.completed" &&
          event.native?.turnId &&
          event.payload.status === "completed" &&
          !this.#branches
            .view()
            .nodes.some((node) => node.threadId === this.#threadId && node.turnId === event.native?.turnId)
        ) {
          try {
            this.#branches.capture({
              kind: "turn",
              label: this.#lastPrompt.slice(0, 200),
              promptId: this.#lastPromptId,
              threadId: this.#threadId,
              turnId: event.native.turnId,
              eventSequence: event.sequence,
              eventStart: this.#eventStart,
              usage: this.#usage,
            })
          } catch (error) {
            this.#turns.runner.halt(error)
          }
        }
        if (event.kind === "turn.started" && event.native?.turnId) {
          this.#turnId = event.native.turnId
          this.#turns.started(event.native.turnId)
        }
        if (event.kind === "turn.completed" && event.native?.turnId) {
          this.#turns.completed(
            event.native.turnId,
            event.payload.status === "interrupted" ? "cancelled" : event.payload.status,
          )
          if (this.#turnId === event.native.turnId) {
            this.#turnId = undefined
            for (const [id, pending] of this.#pendingRequests) {
              pending.resolve({ decision: "cancel" })
              this.#eventQueue.push(
                this.#normalizer.event(
                  "turn/requestCancelled",
                  undefined,
                  { threadId: this.#threadId, requestId: id },
                  { kind: "request.resolved", payload: { id, decision: "cancel" } },
                ),
              )
            }
            this.#pendingRequests.clear()
          }
        }
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

    void client.process.connection.waitForClose().then(() => this.#turns.disconnected())
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
    const selectedThread = this.#branches.view().activeThreadId ?? this.options.nativeSessionId
    if (selectedThread) {
      const params: ThreadResumeParams = { threadId: selectedThread, ...common }
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
    if (!this.#branches.view().head) {
      const turns = resumedThread?.turns ?? [],
        lastCompleted = turns.findLastIndex((turn) => turn.status === "completed")
      this.#branches.capture({
        kind: "base",
        label:
          lastCompleted < 0
            ? "No completed provider boundary retained"
            : "Provider history when recovery opened",
        threadId: lastCompleted < 0 ? undefined : this.#threadId,
        turnId: turns[lastCompleted]?.id,
        evidenceTurnIds: turns.slice(0, lastCompleted + 1).map((turn) => turn.id),
        eventSequence: this.#normalizer.nextSequence - 1,
        eventStart: 0,
        usage: {},
      })
    }
    if (this.options.resumeQueuedInput === false) this.inputQueue.pause()
    this.#turns.runner.wake()
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

  async listModels(): Promise<EngineModel[]> {
    this.#requireThread()
    const models = await this.client.listModels()
    return models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      description: model.description || undefined,
      isDefault: model.isDefault,
    }))
  }

  /** Applies to the next `turn/start`, which Codex carries forward to subsequent turns. */
  async setModel(model: string): Promise<void> {
    this.#requireThread()
    if (this.#turns.busy || this.#recoveryBusy)
      throw new Error("Wait for the current turn before switching models")

    this.#modelOverride = model
    this.#model = model
    this.#eventQueue.push(
      this.#normalizer.event(
        "client/modelSelected",
        undefined,
        { threadId: this.#threadId },
        { kind: "session.status", payload: { status: "ready", model } },
      ),
    )
  }

  async submit(input: CoreUserInput, intent: InputIntent = "follow-up", id?: string) {
    this.#requireThread()
    return this.#turns.submit(input, intent, id)
  }

  async send(input: CoreUserInput): Promise<void> {
    this.#requireThread()
    if (this.#recoveryBusy) throw new Error("Wait for session recovery to settle")
    await this.#turns.send(input)
  }

  #userMessage(input: CoreUserInput, id: string): void {
    this.#eventQueue.push(
      this.#normalizer.event(
        "client/userMessage",
        input,
        { threadId: this.#threadId },
        { kind: "user.message", payload: { id, text: input.text } },
        true,
      ),
    )
  }

  async #start(input: CoreUserInput, id: string): Promise<string> {
    const threadId = this.#requireThread()
    this.#eventStart = this.#normalizer.nextSequence
    this.#lastPrompt = input.text
    this.#lastPromptId = id
    this.#userMessage(input, id)
    const params: TurnStartParams = {
      threadId,
      clientUserMessageId: id,
      input: toCodexInput(input),
      summary: "auto",
      model: this.#modelOverride,
    }
    const response = await this.client.process.connection.request<TurnStartResponse>("turn/start", params)
    this.#modelOverride = undefined
    return response.turn.id
  }

  async exportHistory(options: import("../../core/session/portable.ts").ExportOptions) {
    this.#requireThread()
    if (this.#turns.busy || this.#recoveryBusy)
      throw new Error("Wait for the current operation before exporting")
    this.#recoveryBusy = true
    try {
      await this.options.flushSessionEvents?.()
      const { exportPortable } = await import("../../core/session/portable.ts"),
        now = new Date().toISOString()
      return await exportPortable(
        this.#branches,
        {
          engine: "codex",
          schemaVersion: 2,
          localSessionId: this.localSessionId,
          projectId: "live",
          projectPath: this.options.cwd,
          title: "Codex session",
          createdAt: now,
          updatedAt: now,
          lastStatus: "ready",
          lastSequence: this.#normalizer.nextSequence - 1,
        },
        options,
      )
    } finally {
      this.#recoveryBusy = false
      this.#turns.runner.wake()
    }
  }

  async sessionRecovery(request: RecoveryRequest): Promise<RecoveryResult> {
    this.#requireThread()
    if (request.action === "tree") return { title: "Provider branch tree", data: this.#branches.view() }
    if (request.action === "acknowledge-fork") {
      if (this.#turns.busy || this.#recoveryBusy) throw new Error("Wait for the current operation")
      this.#branches.acknowledgeProviderFork(request.id, request.revision)
      return {
        title: "Fork uncertainty acknowledged; any remote thread remains with Codex",
        data: this.#branches.view(),
      }
    }
    if (request.action !== "fork" && request.action !== "rewind")
      throw new Error("Codex supports conversation fork/rewind here; native file checkpoints are unavailable")
    if (this.#turns.busy || this.#recoveryBusy) throw new Error("Wait for the current turn before branching")
    this.#recoveryBusy = true
    try {
      this.inputQueue.pause()
      const node = this.#branches.node(request.node),
        view = this.#branches.view()
      if (!node.threadId || !node.turnId)
        throw new Error("No completed provider boundary is available; select a completed turn from the tree")
      if (request.action === "rewind" && !request.apply)
        return {
          title: "Provider rewind preview",
          data: {
            node,
            revision: view.revision,
            files: "unchanged",
            mechanism: "Fork the completed boundary into a new provider thread; preserve the old thread",
          },
        }
      if (request.action === "rewind" && request.revision !== view.revision)
        throw new Error("Apply requires the current reviewed branch revision")
      if (!node.threadId) throw new Error("Provider history is unavailable at this boundary")
      await this.options.flushSessionEvents?.()
      const pendingFork = view.providerFork
      if (pendingFork)
        throw new Error(
          `Previous fork ${pendingFork.id} requires review; ${pendingFork.threadId ? `provider thread ${pendingFork.threadId} was created` : "the provider may have created a thread"}. Inspect /tree, then /acknowledge-fork ID --apply --revision REV before another attempt.`,
        )
      const receipt = this.#branches.beginProviderFork(node.id, request.action)
      const params: ThreadForkParams = {
        threadId: node.threadId,
        lastTurnId: node.turnId,
        cwd: this.options.cwd,
        model: this.#model,
        sandbox: this.options.policy?.sandbox ?? defaultSessionPolicy.sandbox,
        approvalPolicy: this.options.policy?.approvalPolicy ?? defaultSessionPolicy.approvalPolicy,
        approvalsReviewer: "user",
      }
      const response = await this.client.process.connection.request<ThreadForkResponse>("thread/fork", params)
      if (!response.thread?.id)
        throw new Error("Codex returned no forked thread identity; inspect the pending fork receipt")
      this.#branches.providerForkResponse(receipt, response.thread.id)
      if (request.action === "fork") {
        const fork = await forkLocalSession(this.#branches, node.id, response.thread.id)
        this.#branches.acknowledgeProviderFork(receipt, this.#branches.view().revision)
        return { title: "Independent Codex fork created", data: fork, fork }
      }
      this.#branches.capture({
        kind: "fork",
        label: `Rewind: ${node.label}`.slice(0, 200),
        parent: node.id,
        threadId: response.thread.id,
        turnId: node.turnId,
        eventSequence: this.#normalizer.nextSequence - 1,
        eventStart: this.#normalizer.nextSequence,
        usage: this.#usage,
        activateThread: true,
      })
      this.#threadId = response.thread.id
      this.#branches.acknowledgeProviderFork(receipt, this.#branches.view().revision)
      this.#eventQueue.push(
        this.#normalizer.event(
          "thread/selected",
          undefined,
          { threadId: this.#threadId },
          { kind: "session.status", payload: { status: "ready", model: this.#model } },
        ),
      )
      return { title: "Provider branch selected", data: this.#branches.view() }
    } finally {
      this.#recoveryBusy = false
      this.#turns.runner.wake()
    }
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
    this.#requireThread()
    await this.#turns.interrupt()
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
    await this.#turns.close()
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
