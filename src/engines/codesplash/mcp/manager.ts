import { Client, SUPPORTED_PROTOCOL_VERSIONS, type Transport } from "@modelcontextprotocol/client"
import type { AgentConfig, PermissionMode } from "../../../core/config.ts"
import { digest } from "../../../core/session/files.ts"
import type { SandboxRuntime } from "../sandbox/contracts.ts"
import { SecretSanitizer } from "../sandbox/env-policy.ts"
import { boundedJson, jsonObject, MCP_FRAME_BYTES } from "./bounds.ts"
import { type McpServerConfig, mcpToolPermitted } from "./config.ts"
import { McpElicitationOwner } from "./elicitation.ts"
import { openMcpHttpTransport } from "./http.ts"
import { McpOAuth } from "./oauth.ts"
import { BoundedSchemaValidators, boundedSchema } from "./schema.ts"
import { SandboxedMcpTransport } from "./stdio.ts"
import { hasMcpTrust, type McpReview, reviewMcpServer } from "./trust.ts"

export type McpTool = {
  id: string
  serverId: string
  originalName: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  generation: string
  fingerprint: string
  readOnly: boolean
  transport: McpServerConfig["transport"]
}
export type McpStatus = {
  id: string
  state: "ready" | "unavailable"
  generation: string
  reason?: string
  tools: number
  resources: boolean
}
type Connection = {
  client: Client
  abort: AbortController
  review: McpReview
  config: McpServerConfig
  mode: PermissionMode
  generation: string
  tools: Map<string, McpTool>
  ready: boolean
  reason?: string
  active: number
  catalogBytes: number
  resourcePermitted: (name: string) => boolean
  live: Map<string, { operation: string; signal: AbortSignal }>
}

/** One session owns every client and request. Construction and inspection perform no I/O. */
export class McpManager {
  readonly #abort = new AbortController()
  readonly #connections = new Map<string, Connection>()
  readonly #opening = new Map<string, { abort: AbortController; work: Promise<void> }>()
  readonly #operations = new Set<Promise<unknown>>()
  readonly #schemas = new BoundedSchemaValidators()
  readonly #outputSchemas = new BoundedSchemaValidators(MCP_FRAME_BYTES, 20000)
  readonly #credentialValues = new Set<string>()
  readonly #elicitation: McpElicitationOwner
  #revision = 0
  constructor(
    readonly options: {
      cwd: string
      dataDir: string
      sandbox: SandboxRuntime
      mode: () => PermissionMode
      resolveConfig: () => Promise<AgentConfig>
      toolAllowed?: (id: string, readOnly: boolean) => boolean
      env?: NodeJS.ProcessEnv
      /** Production pins the execution policy at session construction. */
      configurationBoundary?: AgentConfig
      elicitation?: ConstructorParameters<typeof McpElicitationOwner>[0]
      /** Trusted fixture/embedding seam. Production defaults to the harness sandbox transport. */
      transport?: (
        review: McpReview,
        signal: AbortSignal,
        mode: PermissionMode,
      ) => Transport | Promise<Transport>
      diagnostic?: (text: string) => void
      changed?: () => void
    },
  ) {
    this.#elicitation = new McpElicitationOwner({
      ...options.elicitation,
      sanitize: (text) => this.sanitize(text),
    })
  }

  get revision(): number {
    return this.#revision
  }
  sanitize(text: string): string {
    const clean = new SecretSanitizer([...this.#credentialValues]).redact(text)
    return this.options.sandbox.sanitize?.(clean) ?? clean
  }
  #rememberCredential(value: string): void {
    if (value.length > 16_384 || (!this.#credentialValues.has(value) && this.#credentialValues.size >= 512))
      throw new Error("MCP credential retention limit reached; start a new session")
    this.#credentialValues.add(value)
  }
  statuses(): McpStatus[] {
    return [...this.#connections.entries()].map(([id, entry]) => ({
      id,
      state: entry.ready ? "ready" : "unavailable",
      generation: entry.generation,
      tools: entry.ready ? entry.tools.size : 0,
      resources: entry.ready && !!entry.client.getServerCapabilities()?.resources,
      ...(entry.reason ? { reason: entry.reason } : {}),
    }))
  }
  catalog(): McpTool[] {
    return [...this.#connections.values()]
      .filter((entry) => entry.ready)
      .flatMap((entry) => [...entry.tools.values()])
      .filter((tool) => this.options.toolAllowed?.(tool.id, tool.readOnly) !== false)
      .map((tool) => structuredClone(tool))
  }
  #changed(): void {
    this.#revision++
    try {
      this.options.changed?.()
    } catch {
      /* A diagnostic consumer cannot break resource ownership. */
    }
  }
  #permitted(config: AgentConfig, id: string, tool?: string): McpServerConfig {
    const server = config.mcp?.servers[id]
    const constraints = config.resolution?.constraints
    if (!server?.enabled || (constraints?.mcpServers && !constraints.mcpServers.includes(id)))
      throw new Error("MCP server is disabled or denied by managed policy")
    if (server.allowLoopback && constraints?.allowedHosts !== undefined)
      throw new Error("Managed public-host policy does not permit MCP loopback exceptions")
    if (
      tool &&
      (!mcpToolPermitted(server, tool) ||
        (constraints?.mcpTools && !constraints.mcpTools.includes(`${id}/${tool}`)))
    )
      throw new Error("MCP tool is denied by policy")
    return server
  }
  async #review(id: string, tool?: string): Promise<{ config: AgentConfig; review: McpReview }> {
    if (this.#abort.signal.aborted) throw new Error("MCP manager is closed")
    const config = await this.options.resolveConfig()
    this.#permitted(config, id, tool)
    const boundary = this.options.configurationBoundary
    const policy = (value: AgentConfig) =>
      JSON.stringify([value.codex.sandbox, value.sandbox, value.resolution?.constraints])
    if (boundary && policy(config) !== policy(boundary))
      throw new Error("MCP execution policy changed; start a new session to apply its sandbox boundary")
    const review = await reviewMcpServer(config, id, this.options.cwd, this.#abort.signal)
    if (!hasMcpTrust(this.options.dataDir, review))
      throw new Error("MCP source requires explicit fingerprint trust")
    return { config, review }
  }
  connect(id: string): Promise<void> {
    if (this.#opening.has(id)) return Promise.reject(new Error("MCP connection is already being prepared"))
    if (this.#abort.signal.aborted) return Promise.reject(new Error("MCP manager is closed"))
    if (!this.#connections.has(id) && this.#connections.size + this.#opening.size >= 32)
      return Promise.reject(new Error("MCP connection limit reached"))
    const abort = new AbortController()
    const work = this.#connect(id, abort).finally(() => {
      this.#opening.delete(id)
    })
    this.#opening.set(id, { abort, work })
    return work
  }
  async #connect(id: string, abort: AbortController): Promise<void> {
    const { config, review } = await this.#review(id)
    const mode = this.options.mode()
    const signal = AbortSignal.any([abort.signal, this.#abort.signal])
    const discoverySignal = AbortSignal.any([signal, AbortSignal.timeout(review.config.initializeTimeoutMs)])
    signal.throwIfAborted()
    const client = new Client(
      { name: "codesplash-agent", version: "0.1.4" },
      {
        jsonSchemaValidator: this.#schemas,
        enforceStrictCapabilities: true,
        capabilities: { elicitation: { form: {} } },
      },
    )
    const entry: Connection = {
      client,
      abort,
      review,
      config: review.config,
      mode,
      generation: crypto.randomUUID(),
      tools: new Map(),
      ready: false,
      active: 0,
      catalogBytes: 0,
      resourcePermitted: (name) =>
        mcpToolPermitted(review.config, name) &&
        (!config.resolution?.constraints.mcpTools ||
          config.resolution.constraints.mcpTools.includes(`${id}/${name}`)),
      live: new Map(),
    }
    const invalidate = (reason: string) => {
      entry.ready = false
      entry.reason = reason
      if (this.#connections.get(id) === entry) this.#changed()
    }
    client.onclose = () => invalidate("MCP transport disconnected; reconnect explicitly")
    client.setRequestHandler("elicitation/create", async (request, context) => {
      const operation = entry.live.size === 1 ? [...entry.live.values()][0] : undefined
      if (!entry.ready || !operation) return { action: "decline" as const }
      return this.#elicitation.handle(request.params, {
        server: id,
        generation: entry.generation,
        operation: operation.operation,
        signal: AbortSignal.any([operation.signal, context.mcpReq.signal]),
      })
    })
    client.onerror = () => {
      try {
        this.options.diagnostic?.(`MCP ${id}: protocol or transport error`)
      } catch {}
    }
    client.setNotificationHandler("notifications/tools/list_changed", () =>
      invalidate("MCP catalog changed; reconnect before selecting tools"),
    )
    let transport: Transport | undefined
    try {
      transport = this.options.transport
        ? await this.options.transport(review, signal, mode)
        : review.argv
          ? new SandboxedMcpTransport({
              sandbox: this.options.sandbox,
              argv: review.argv,
              signal,
              mode,
              environment: review.config.environment,
              diagnostic: this.options.diagnostic,
            })
          : await openMcpHttpTransport({
              server: review.config,
              profile: this.options.sandbox.profile,
              signal,
              bearerToken: async () => {
                if (review.config.oauth) {
                  const value = await new McpOAuth({
                    review,
                    profile: this.options.sandbox.profile,
                    dataDir: this.options.dataDir,
                  }).token(signal)
                  this.#rememberCredential(value)
                  return value
                }
                const name = review.config.bearerEnv
                if (!name) return undefined
                const value = (this.options.env ?? process.env)[name]
                if (!value) throw new Error("MCP bearer credential environment variable is unset")
                this.#rememberCredential(value)
                return value
              },
            })
      signal.throwIfAborted()
      await client.connect(transport, { signal: discoverySignal, timeout: review.config.initializeTimeoutMs })
      const negotiated = client.getNegotiatedProtocolVersion()
      if (!negotiated || !SUPPORTED_PROTOCOL_VERSIONS.includes(negotiated))
        throw new Error("Unsupported negotiated MCP protocol version")
      let total = 0
      const names = new Set<string>()
      if (client.getServerCapabilities()?.tools) {
        let cursor: string | undefined
        const cursors = new Set<string>()
        for (let page = 0; ; page++) {
          if (page >= 100) throw new Error("MCP catalog exceeds 100 pages")
          // Raw typed requests deliberately avoid the SDK's auto-aggregation/cache/header mirroring.
          const result = await client.request(
            { method: "tools/list", params: cursor === undefined ? {} : { cursor } },
            { signal: discoverySignal, timeout: review.config.requestTimeoutMs },
          )
          total += Buffer.byteLength(boundedJson(result))
          if (total > MCP_FRAME_BYTES || names.size + result.tools.length > 5000)
            throw new Error("MCP catalog exceeds its aggregate limit")
          for (const tool of result.tools) {
            if (
              !tool.name ||
              tool.name.length > 256 ||
              Array.from(tool.name).some((char) => char.charCodeAt(0) < 32) ||
              names.has(tool.name)
            )
              throw new Error("MCP catalog has an invalid or duplicate tool identity")
            names.add(tool.name)
            if (
              !mcpToolPermitted(review.config, tool.name) ||
              (config.resolution?.constraints.mcpTools &&
                !config.resolution.constraints.mcpTools.includes(`${id}/${tool.name}`))
            )
              continue
            if (this.sanitize(boundedJson(tool)) !== boundedJson(tool))
              throw new Error("MCP catalog contains credential material")
            const inputSchema = boundedSchema(tool.inputSchema)
            if (!jsonObject(inputSchema) || inputSchema.type !== "object")
              throw new Error("MCP tool input must be an object schema")
            const outputSchema =
              tool.outputSchema === undefined ? undefined : boundedSchema(tool.outputSchema)
            if (outputSchema !== undefined && !jsonObject(outputSchema))
              throw new Error("Invalid MCP output schema")
            const sourceIdentity = JSON.stringify([
              review.cwd,
              review.sources.map((source) => [source.id, source.path ?? ""]),
              tool.name,
            ])
            const identity = `mcp_${id}_${digest(sourceIdentity).slice(0, 24)}`
            if (entry.tools.has(identity)) throw new Error("MCP tool namespace collision")
            entry.tools.set(identity, {
              id: identity,
              serverId: id,
              originalName: tool.name,
              description: tool.description?.slice(0, 8192) ?? "External MCP operation",
              inputSchema,
              ...(outputSchema ? { outputSchema } : {}),
              generation: entry.generation,
              fingerprint: review.fingerprint,
              readOnly: review.config.readOnlyTools?.includes(tool.name) === true,
              transport: review.config.transport,
            })
          }
          cursor = result.nextCursor
          if (cursor === undefined) break
          if (!cursor || cursor.length > 8192 || cursors.has(cursor))
            throw new Error("MCP catalog returned an invalid or repeated cursor")
          cursors.add(cursor)
        }
      }
      discoverySignal.throwIfAborted()
      const current = await this.#review(id)
      if (current.review.fingerprint !== review.fingerprint || mode !== this.options.mode())
        throw new Error("MCP source or mode changed during connection")
      discoverySignal.throwIfAborted()
      if (entry.reason) throw new Error(entry.reason)
      const others = [...this.#connections.entries()]
        .filter(([name]) => name !== id)
        .map(([, connection]) => connection)
      if (
        others.reduce((sum, connection) => sum + connection.tools.size, entry.tools.size) > 5000 ||
        others.reduce((sum, connection) => sum + connection.catalogBytes, total) > MCP_FRAME_BYTES
      )
        throw new Error("MCP session catalog exceeds its aggregate limit")
      entry.catalogBytes = total
      const previous = this.#connections.get(id)
      entry.ready = true
      this.#connections.set(id, entry)
      this.#changed()
      if (previous) {
        previous.abort.abort()
        await previous.client.close().catch(() => {})
      }
    } catch (error) {
      abort.abort(error)
      await client.close().catch(() => {})
      await transport?.close().catch(() => {})
      throw error
    }
  }

  /** The harness resolves this target before permission/readonly classification. */
  lookup(id: string, generation: string): McpTool {
    for (const entry of this.#connections.values()) {
      const tool = entry.tools.get(id)
      if (
        tool &&
        entry.ready &&
        entry.generation === generation &&
        this.options.toolAllowed?.(tool.id, tool.readOnly) !== false
      )
        return structuredClone(tool)
    }
    throw new Error("MCP selection is stale or unavailable; search and select again")
  }
  validate(id: string, generation: string, input: unknown): McpTool {
    const tool = this.lookup(id, generation)
    const validation = this.#schemas.getValidator(tool.inputSchema)(input)
    if (!validation.valid || !jsonObject(input))
      throw new Error(validation.errorMessage ?? "MCP input must be an object")
    return tool
  }
  async #revalidate(entry: Connection, tool?: string): Promise<void> {
    try {
      const reviewed = await this.#review(entry.review.serverId, tool)
      if (reviewed.review.fingerprint !== entry.review.fingerprint || entry.mode !== this.options.mode())
        throw new Error("MCP source or permission mode changed; reconnect required")
    } catch (error) {
      entry.ready = false
      entry.reason = "MCP source or policy changed; reconnect required"
      entry.abort.abort()
      this.#changed()
      await entry.client.close().catch(() => {})
      throw error
    }
  }
  async revalidate(): Promise<void> {
    for (const entry of this.#connections.values()) {
      if (!entry.ready) continue
      try {
        await this.#revalidate(entry)
      } catch {
        this.options.diagnostic?.(
          `MCP ${entry.review.serverId}: source or policy changed; inspect and reconnect`,
        )
      }
    }
  }
  async suspend(): Promise<void> {
    await Promise.allSettled(
      [...this.#opening.keys(), ...this.#connections.keys()].map((id) => this.disconnect(id)),
    )
  }
  call(id: string, generation: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    const work = this.#call(id, generation, input, signal)
    this.#operations.add(work)
    void work
      .finally(() => {
        this.#operations.delete(work)
      })
      .catch(() => {})
    return work
  }
  #resourceOperation<T>(
    serverId: string,
    generation: string,
    operationName: string,
    signal: AbortSignal,
    run: (entry: Connection, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const work = (async () => {
      const entry = this.#connections.get(serverId)
      if (!entry?.ready || entry.generation !== generation)
        throw new Error("MCP resource selection is stale or unavailable")
      if (entry.active >= 32) throw new Error("MCP request concurrency limit reached")
      entry.active++
      const operationAbort = new AbortController(),
        operationId = crypto.randomUUID()
      try {
        await this.#revalidate(entry, operationName)
        const combined = AbortSignal.any([
          signal,
          this.#abort.signal,
          entry.abort.signal,
          operationAbort.signal,
          AbortSignal.timeout(entry.config.requestTimeoutMs),
        ])
        combined.throwIfAborted()
        entry.live.set(operationId, { operation: "resource access", signal: combined })
        const result = await run(entry, combined)
        combined.throwIfAborted()
        if (!entry.ready || this.#connections.get(serverId) !== entry)
          throw new Error("MCP resource reply belongs to an invalidated connection")
        return result
      } finally {
        operationAbort.abort()
        entry.live.delete(operationId)
        entry.active--
      }
    })()
    this.#operations.add(work)
    void work
      .finally(() => {
        this.#operations.delete(work)
      })
      .catch(() => {})
    return work
  }
  listResources(
    serverId: string,
    generation: string,
    templates: boolean,
    signal: AbortSignal,
  ): Promise<unknown[]> {
    return this.#resourceOperation(
      serverId,
      generation,
      templates ? "resources/templates/list" : "resources/list",
      signal,
      async (entry, combined) => {
        const items: unknown[] = [],
          identities = new Set<string>(),
          cursors = new Set<string>()
        let cursor: string | undefined,
          bytes = 0
        for (let page = 0; ; page++) {
          if (page >= 100) throw new Error("MCP resource listing exceeds 100 pages")
          const params = cursor === undefined ? {} : { cursor }
          const options = { signal: combined, timeout: entry.config.requestTimeoutMs }
          const result = templates
            ? await entry.client.request({ method: "resources/templates/list", params }, options)
            : await entry.client.request({ method: "resources/list", params }, options)
          bytes += Buffer.byteLength(boundedJson(result))
          const listed = "resourceTemplates" in result ? result.resourceTemplates : result.resources
          if (!Array.isArray(listed)) throw new Error("Invalid MCP resource catalog")
          if (bytes > MCP_FRAME_BYTES || items.length + listed.length > 5000)
            throw new Error("MCP resource catalog exceeds its limit")
          for (const item of listed) {
            const identity = "uriTemplate" in item ? item.uriTemplate : item.uri
            if (
              typeof identity !== "string" ||
              !identity ||
              identity.length > 8192 ||
              identities.has(identity)
            )
              throw new Error("Invalid or duplicate MCP resource identity")
            identities.add(identity)
            items.push(item)
          }
          cursor = result.nextCursor
          if (cursor === undefined) return items
          if (!cursor || cursor.length > 8192 || cursors.has(cursor))
            throw new Error("Invalid or repeated MCP resource cursor")
          cursors.add(cursor)
        }
      },
    )
  }
  resourceTarget(serverId: string, generation: string, action: "list" | "templates" | "read"): McpTool {
    const entry = this.#connections.get(serverId)
    if (!entry?.ready || entry.generation !== generation || !entry.client.getServerCapabilities()?.resources)
      throw new Error("MCP resource selection is stale or unavailable")
    const originalName = action === "templates" ? "resources/templates/list" : `resources/${action}`
    if (!entry.resourcePermitted(originalName)) throw new Error("MCP resource operation is denied by policy")
    const id = `mcp_${serverId}_${digest(JSON.stringify([entry.review.cwd, entry.review.sources.map((source) => [source.id, source.path ?? ""]), `\0${originalName}`])).slice(0, 24)}`
    if (this.options.toolAllowed?.(id, true) === false) throw new Error("MCP resource operation is denied")
    return {
      id,
      serverId,
      originalName,
      generation,
      fingerprint: entry.review.fingerprint,
      transport: entry.config.transport,
      readOnly: true,
      description: "MCP resource access",
      inputSchema: { type: "object" },
    }
  }
  readResource(serverId: string, generation: string, uri: string, signal: AbortSignal): Promise<unknown> {
    if (!uri || uri.length > 8192 || Array.from(uri).some((char) => char.charCodeAt(0) < 32))
      return Promise.reject(new Error("Invalid MCP resource URI"))
    return this.#resourceOperation(
      serverId,
      generation,
      "resources/read",
      signal,
      async (entry, combined) => {
        // A URI is sent only to the reviewed server. It never becomes a local path or host fetch.
        const result = await entry.client.request(
          { method: "resources/read", params: { uri } },
          { signal: combined, timeout: entry.config.requestTimeoutMs },
        )
        boundedJson(result)
        return result
      },
    )
  }
  async #call(id: string, generation: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    const tool = this.lookup(id, generation)
    const entry = this.#connections.get(tool.serverId)
    if (!entry || entry.active >= 32) throw new Error("MCP request concurrency limit reached")
    entry.active++
    const operationAbort = new AbortController(),
      operationId = crypto.randomUUID()
    try {
      this.validate(id, generation, input)
      await this.#revalidate(entry, tool.originalName)
      this.lookup(id, generation)
      const combined = AbortSignal.any([
        signal,
        entry.abort.signal,
        this.#abort.signal,
        operationAbort.signal,
      ])
      combined.throwIfAborted()
      entry.live.set(operationId, { operation: tool.originalName, signal: combined })
      let result: Awaited<ReturnType<Client["callTool"]>>
      try {
        result = await entry.client.request(
          { method: "tools/call", params: { name: tool.originalName, arguments: input } },
          { signal: combined, timeout: entry.config.requestTimeoutMs },
        )
      } catch (error) {
        throw new Error(
          "MCP operation failed after dispatch; its external effects are uncertain. It was not retried.",
          { cause: error },
        )
      }
      boundedJson(result)
      if (tool.outputSchema && !result.isError) {
        const validation = this.#outputSchemas.getValidator(tool.outputSchema)(result.structuredContent)
        if (!validation.valid)
          throw new Error(
            "MCP executed but returned invalid structured output; external effects cannot be rolled back",
          )
      }
      if (!entry.ready || entry.generation !== generation || combined.aborted)
        throw new Error(
          "MCP result arrived after cancellation or catalog invalidation; external effects are uncertain",
        )
      return result
    } finally {
      operationAbort.abort()
      entry.live.delete(operationId)
      entry.active--
    }
  }
  async disconnect(id: string): Promise<void> {
    const opening = this.#opening.get(id)
    opening?.abort.abort()
    await opening?.work.catch(() => {})
    const entry = this.#connections.get(id)
    if (entry) {
      this.#connections.delete(id)
      entry.abort.abort()
      this.#changed()
      await entry.client.close()
    }
  }
  async close(): Promise<void> {
    this.#abort.abort()
    await Promise.allSettled([...this.#opening.values()].map((entry) => entry.work))
    await Promise.allSettled([...this.#connections.keys()].map((id) => this.disconnect(id)))
    await Promise.allSettled([...this.#operations])
  }
}
