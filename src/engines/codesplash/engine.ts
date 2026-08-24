/**
 * The first-party CodeSplash engine behind the EngineDriver/EngineSession contract. Sessions run
 * entirely in-process: provider adapters stream model responses and the loop executes tools.
 */
import { extname } from "node:path"
import {
  type AgentEvent,
  AsyncQueue,
  defaultSessionPolicy,
  type EngineCapabilities,
  type EngineDecision,
  type EngineDriver,
  type EngineModel,
  type EngineProbe,
  type EngineSession,
  type OpenSessionOptions,
  type SessionPolicy,
  type UserInput,
} from "../../core/index.ts"
import { APP_VERSION } from "../../version.ts"
import { PROVIDER_ENV_VARS, resolveApiKey } from "./auth.ts"
import {
  availableProviders,
  catalogModels,
  defaultModelFor,
  defaultProvider,
  formatModelSelector,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_KEY_VARIABLES,
  parseModelSelector,
} from "./catalog.ts"
import type {
  ContentBlock,
  ImageBlock,
  ModelInfo,
  ProviderClient,
  ProviderId,
  ReasoningEffort,
} from "./contracts.ts"
import { CodesplashEventFactory, CodesplashLoop } from "./loop.ts"
import { buildSystemPrompt } from "./prompt.ts"
import { createAnthropicProvider } from "./providers/anthropic.ts"
import { createOpenAiProvider } from "./providers/openai.ts"
import { builtinTools, createToolRegistry, type ToolRegistry } from "./tools/registry.ts"

export const CODESPLASH_CAPABILITIES: EngineCapabilities = {
  nativeTranscript: true,
  approvals: true,
  interrupt: true,
  resume: false,
  usage: "tokens",
  surface: "native",
}

const NO_KEYS_DETAIL = "No API keys found — set ANTHROPIC_API_KEY or OPENAI_API_KEY"

export type CodesplashDriverOptions = {
  /** Provider overrides, e.g. scripted fakes in tests. */
  providers?: Partial<Record<ProviderId, ProviderClient>>
}

export class CodesplashDriver implements EngineDriver {
  readonly id = "codesplash" as const

  constructor(readonly options: CodesplashDriverOptions = {}) {}

  /**
   * Reports availability from resolvable API keys — env var first, then the credential store —
   * naming each provider's source (env/stored). Key values never appear in the probe.
   */
  async probe(): Promise<EngineProbe> {
    const resolved = (Object.keys(PROVIDER_ENV_VARS) as ProviderId[]).flatMap((provider) => {
      const credential = resolveApiKey(provider)
      return credential ? [{ provider, source: credential.source }] : []
    })
    if (resolved.length === 0) {
      return { available: false, authenticated: false, version: APP_VERSION, detail: NO_KEYS_DETAIL }
    }
    return {
      available: true,
      authenticated: true,
      version: APP_VERSION,
      detail: resolved
        .map(({ provider, source }) => `${PROVIDER_DISPLAY_NAMES[provider]} API key (${source})`)
        .join(" · "),
    }
  }

  async openSession(options: OpenSessionOptions): Promise<EngineSession> {
    if (availableProviders().length === 0) {
      throw new Error(`${NO_KEYS_DETAIL} to use the CodeSplash engine`)
    }
    return new CodesplashSession(options, {
      anthropic: this.options.providers?.anthropic ?? createAnthropicProvider(),
      openai: this.options.providers?.openai ?? createOpenAiProvider(),
    })
  }
}

class CodesplashSession implements EngineSession {
  readonly capabilities = CODESPLASH_CAPABILITIES
  readonly events: AsyncIterable<AgentEvent>
  readonly #queue = new AsyncQueue<AgentEvent>()
  readonly #factory: CodesplashEventFactory
  readonly #loop: CodesplashLoop
  readonly #registry: ToolRegistry
  readonly #providers: Record<ProviderId, ProviderClient>
  readonly #policy: SessionPolicy
  readonly #cwd: string
  #model: ModelInfo
  #reasoningEffort: ReasoningEffort | undefined
  #systemPrompt: { modelId: string; text: string } | undefined
  #turnPromise: Promise<void> | undefined
  /** Set synchronously in send() before any await so concurrent sends are refused reliably. */
  #turnReserved = false
  #closed = false
  #ended = false

  constructor(
    readonly options: OpenSessionOptions,
    providers: Record<ProviderId, ProviderClient>,
  ) {
    this.events = this.#queue
    this.#providers = providers
    this.#policy = options.policy ?? defaultSessionPolicy
    this.#cwd = options.cwd
    this.#factory = new CodesplashEventFactory(options.localSessionId, options.firstSequence ?? 0)
    this.#registry = createToolRegistry(builtinTools())
    this.#loop = new CodesplashLoop({
      cwd: options.cwd,
      policy: this.#policy,
      registry: this.#registry,
      events: this.#factory,
      emit: (event) => this.#push(event),
    })

    this.#push(
      this.#factory.event("session/opening", {}, { kind: "session.status", payload: { status: "starting" } }),
    )
    const selection = options.model
      ? parseModelSelector(options.model)
      : { model: defaultModelFor(defaultProvider()), effort: undefined }
    requireProviderKey(selection.model.provider)
    this.#model = selection.model
    this.#reasoningEffort = selection.effort
    this.#push(
      this.#factory.event(
        "session/opened",
        {},
        {
          kind: "session.status",
          payload: { status: "ready", model: formatModelSelector(this.#model, this.#reasoningEffort) },
        },
      ),
    )
  }

  get localSessionId(): string {
    return this.options.localSessionId
  }

  /** The harness session is the native session; there is no external provider thread. */
  get nativeSessionId(): string {
    return this.options.localSessionId
  }

  async send(input: UserInput): Promise<void> {
    this.#requireOpen()
    if (this.#turnReserved || this.#loop.isTurnActive) {
      throw new Error("A CodeSplash turn is already running")
    }
    // Reserve the turn before the first await: prompt building below does fs and git work, and a
    // second send arriving in that window must be refused here (to the caller) rather than crash
    // the live turn with a spurious non-recoverable error event.
    this.#turnReserved = true
    let turnStarted = false
    try {
      const provider = this.#providers[this.#model.provider]
      const system = await this.#systemPromptFor()
      const userContent = await buildUserContent(input)
      this.#requireOpen()
      this.#turnPromise = this.#loop
        .runTurn({
          provider,
          model: this.#model,
          reasoningEffort: this.#reasoningEffort,
          system,
          userText: input.text,
          userContent,
        })
        .catch((error) => {
          this.#push(
            this.#factory.event(
              "loop/crash",
              {},
              {
                kind: "error",
                payload: {
                  message: error instanceof Error ? error.message : String(error),
                  recoverable: false,
                },
              },
            ),
          )
        })
        .finally(() => {
          this.#turnPromise = undefined
          this.#turnReserved = false
        })
      turnStarted = true
    } finally {
      if (!turnStarted) this.#turnReserved = false
    }
  }

  async resolveRequest(requestId: string, decision: EngineDecision): Promise<void> {
    this.#requireOpen()
    this.#loop.resolveRequest(requestId, decision.choice)
  }

  async interrupt(): Promise<void> {
    if (this.#closed) return
    this.#loop.interrupt()
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#loop.interrupt()
    await this.#turnPromise
    this.#ended = true
    this.#queue.end()
  }

  async listModels(): Promise<EngineModel[]> {
    this.#requireOpen()
    const providers = availableProviders()
    const sessionDefault = defaultProvider()
    return catalogModels(providers).map((model) => ({
      id: model.id,
      displayName: model.displayName,
      description: describeModel(model),
      isDefault: model.provider === sessionDefault && model.isDefault,
    }))
  }

  /** Accepts `<model-id>` or `<model-id>:<low|medium|high>`; applies to subsequent turns. */
  async setModel(model: string): Promise<void> {
    this.#requireOpen()
    if (this.#turnReserved || this.#loop.isTurnActive) {
      throw new Error("Wait for the current turn before switching models")
    }
    const selection = parseModelSelector(model)
    requireProviderKey(selection.model.provider)
    this.#model = selection.model
    this.#reasoningEffort = selection.effort
    this.#push(
      this.#factory.event(
        "client/modelSelected",
        {},
        {
          kind: "session.status",
          payload: { status: "ready", model: formatModelSelector(selection.model, selection.effort) },
        },
      ),
    )
  }

  async #systemPromptFor(): Promise<string> {
    if (this.#systemPrompt?.modelId === this.#model.id) return this.#systemPrompt.text
    const text = await buildSystemPrompt({
      cwd: this.#cwd,
      model: this.#model,
      policy: this.#policy,
      toolNames: this.#registry.specs().map((spec) => spec.name),
    })
    this.#systemPrompt = { modelId: this.#model.id, text }
    return text
  }

  #push(event: AgentEvent): void {
    if (this.#ended) return
    this.#queue.push(event)
  }

  #requireOpen(): void {
    if (this.#closed) throw new Error("CodeSplash session is closed")
  }
}

/* -------------------------------------- helpers -------------------------------------- */

function requireProviderKey(provider: ProviderId): void {
  if (!process.env[PROVIDER_KEY_VARIABLES[provider]]) {
    throw new Error(
      `The ${PROVIDER_DISPLAY_NAMES[provider]} provider needs ${PROVIDER_KEY_VARIABLES[provider]} set`,
    )
  }
}

function describeModel(model: ModelInfo): string {
  return [
    PROVIDER_DISPLAY_NAMES[model.provider],
    `${Math.round(model.contextWindow / 1000)}k context`,
    model.supportsReasoning ? "reasoning" : undefined,
  ]
    .filter(Boolean)
    .join(" · ")
}

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

async function buildUserContent(input: UserInput): Promise<ContentBlock[]> {
  const content: ContentBlock[] = []
  if (input.text !== "") content.push({ type: "text", text: input.text })
  for (const image of input.images ?? []) {
    content.push(await readImageBlock(image))
  }
  if (content.length === 0) content.push({ type: "text", text: "" })
  return content
}

/** Local image paths become base64 ImageBlocks; data: URIs pass through decoded. */
async function readImageBlock(image: string): Promise<ImageBlock> {
  const dataUri = image.match(/^data:([^;,]+);base64,(.+)$/s)
  if (dataUri) {
    return { type: "image", mediaType: dataUri[1] ?? "image/png", base64Data: dataUri[2] ?? "" }
  }
  const file = Bun.file(image)
  if (!(await file.exists())) throw new Error(`Image not found: ${image}`)
  const bytes = await file.arrayBuffer()
  const mediaType = IMAGE_MEDIA_TYPES[extname(image).toLowerCase()] ?? "image/png"
  return { type: "image", mediaType, base64Data: Buffer.from(bytes).toString("base64") }
}
