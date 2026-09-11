import type { HarnessTool, ToolContext, ToolSpec } from "../contracts.ts"
import { ToolInputError } from "../contracts.ts"
import type { ToolRegistry } from "../tools/registry.ts"
import { boundedJson, jsonObject } from "./bounds.ts"
import type { McpManager, McpTool } from "./manager.ts"
import { materializeMcpResult } from "./results.ts"

const MAX_SELECTED = 32
const MAX_SCHEMA_BYTES = 256 * 1024
const terms = (text: string) =>
  text
    .toLowerCase()
    .match(/[a-z0-9_]+/g)
    ?.slice(0, 512) ?? []

/** Bounded BM25 search; deterministic ties keep catalog ordering out of model behavior. */
export function rankMcpTools(catalog: McpTool[], query: string): McpTool[] {
  const words = [...new Set(terms(query))].slice(0, 16)
  if (!words.length) throw new ToolInputError("Search requires keywords or select:server/original-name")
  const documents = catalog.map((tool) => terms(`${tool.serverId} ${tool.originalName} ${tool.description}`))
  const average = documents.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, documents.length) || 1
  const frequencies = words.map((word) => documents.filter((doc) => doc.includes(word)).length)
  return catalog
    .map((tool, index) => {
      const doc = documents[index] ?? []
      const score = words.reduce((sum, word, wordIndex) => {
        const frequency = doc.filter((term) => term === word).length
        if (!frequency) return sum
        const count = frequencies[wordIndex] ?? 0
        const idf = Math.log(1 + (catalog.length - count + 0.5) / (count + 0.5))
        return sum + (idf * frequency * 2.2) / (frequency + 1.2 * (0.25 + (0.75 * doc.length) / average))
      }, 0)
      return { tool, score }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.tool.id.localeCompare(b.tool.id))
    .map(({ tool }) => tool)
}

function object(input: unknown, keys: string[]): Record<string, unknown> {
  boundedJson(input, 1024 * 1024, 5000)
  if (!jsonObject(input) || Object.keys(input).some((key) => !keys.includes(key)))
    throw new ToolInputError("Invalid deferred MCP input")
  return input
}
function string(value: unknown, name: string, max = 8192): string {
  if (typeof value !== "string" || !value || value.length > max)
    throw new ToolInputError(`Invalid MCP ${name}`)
  return value
}
function effectPermission(tool: McpTool, input: unknown, context: ToolContext) {
  if (!tool.readOnly && (context.policy.sandbox === "read-only" || context.permissions?.mode === "plan"))
    throw new ToolInputError("MCP operation is not reviewed as read-only and cannot run under this policy")
  return {
    kind: "approval" as const,
    title: `Run MCP ${tool.serverId}/${tool.originalName}?`,
    detail: `${tool.serverId}/${tool.originalName}\nGeneration: ${tool.generation}\nReviewed source: ${tool.fingerprint}\n${tool.readOnly ? "Locally reviewed read-only operation." : "May change external state. External effects cannot be restored by workspace checkpoints."}\n${boundedJson(input, 1024 * 1024, 5000)}`,
    sessionKey: `mcp:${tool.id}:${tool.fingerprint}:${tool.generation}`,
  }
}

/** Selection and execution share one actual HarnessTool; use_tool never recursively calls run(). */
export function createMcpToolRegistry(base: ToolRegistry, manager: McpManager): ToolRegistry {
  const selected = new Map<string, McpTool>()
  let revision = manager.revision
  const refresh = () => {
    if (revision !== manager.revision) {
      selected.clear()
      revision = manager.revision
    }
  }
  const adapter = (target: McpTool): HarnessTool => ({
    name: target.id,
    description: `MCP ${target.serverId}/${target.originalName}: ${target.description}`,
    inputSchema: target.inputSchema,
    effects: target.transport === "stdio" ? "workspace-and-external" : "external",
    allowPersistentApproval: false,
    isReadOnly: (input) => manager.validate(target.id, target.generation, input).readOnly,
    permission: (input, context) => effectPermission(target, input, context),
    run: async (input, context) => {
      // Recheck floors even when explicit permission rules skip the approval prompt.
      effectPermission(target, input, context)
      const result = await manager.call(target.id, target.generation, input, context.signal)
      try {
        return await materializeMcpResult(
          result,
          {
            server: target.serverId,
            generation: target.generation,
            operation: target.originalName,
          },
          (text) => manager.sanitize(text),
          context.signal,
        )
      } catch (error) {
        throw new Error(
          "MCP executed but its result could not be safely included; external effects are uncertain",
          { cause: error },
        )
      }
    },
  })
  const search: HarnessTool = {
    name: "search_tool",
    description:
      "Discover permitted MCP tools by keywords or exact select:server/original-name (or select:provider-id). Selects up to five schemas for subsequent direct calls or use_tool. A catalog change invalidates selections.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", maxLength: 8192 } },
      required: ["query"],
      additionalProperties: false,
    },
    isReadOnly: () => true,
    permission: () => ({ kind: "none" }),
    run: async (input) => {
      const query = string(object(input, ["query"]).query, "query").trim()
      refresh()
      const catalog = manager.catalog()
      const exact = query.startsWith("select:") ? query.slice(7).trim() : undefined
      const matches =
        exact === undefined
          ? rankMcpTools(catalog, query).slice(0, 5)
          : catalog.filter((tool) => tool.id === exact || `${tool.serverId}/${tool.originalName}` === exact)
      if (exact !== undefined && matches.length !== 1)
        throw new ToolInputError("Exact MCP selection is missing or ambiguous")
      const staged = new Map(selected)
      for (const tool of matches) staged.set(tool.id, tool)
      if (
        staged.size > MAX_SELECTED ||
        [...staged.values()].reduce((sum, tool) => sum + Buffer.byteLength(boundedJson(tool)), 0) >
          MAX_SCHEMA_BYTES
      )
        throw new ToolInputError("MCP loaded-schema limit reached; reconnect to clear selections")
      for (const [id, tool] of staged) selected.set(id, tool)
      return {
        label: "MCP tool search",
        text: boundedJson({
          catalogRevision: revision,
          tools: matches,
          servers: manager.statuses().filter((status) => status.state === "ready"),
        }),
      }
    },
  }
  const deferred: HarnessTool = {
    name: "use_tool",
    description:
      "Invoke a selected MCP operation using its exact id, generation, and input from search_tool. The harness resolves and checks the actual tool before executing.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, generation: { type: "string" }, input: { type: "object" } },
      required: ["id", "generation", "input"],
      additionalProperties: false,
    },
    isReadOnly: () => false,
    permission: () => {
      throw new ToolInputError("Deferred target was not resolved")
    },
    run: async () => {
      throw new ToolInputError("Deferred target was not resolved")
    },
  }
  const resources: HarnessTool = {
    name: "mcp_resource",
    description:
      "List MCP resources/templates or read an exact URI on a ready server. Use server id and generation from search_tool. A URI identifies server content and grants no local file or network access.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string" },
        generation: { type: "string" },
        action: { enum: ["list", "templates", "read"] },
        uri: { type: "string", maxLength: 8192 },
      },
      required: ["server", "generation", "action"],
      additionalProperties: false,
    },
    isReadOnly: () => false,
    permission: () => {
      throw new ToolInputError("Resource target was not resolved")
    },
    run: async () => {
      throw new ToolInputError("Resource target was not resolved")
    },
  }
  for (const tool of [search, deferred, resources])
    if (base.get(tool.name)) throw new Error(`MCP intrinsic collision: ${tool.name}`)
  const spec = (tool: HarnessTool): ToolSpec => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })
  const get = (name: string, generation?: string): HarnessTool | undefined => {
    refresh()
    if (generation !== undefined && generation !== `${base.generation}:mcp:${revision}`)
      throw new ToolInputError("Tool registry generation is stale")
    if (name === search.name) return search
    if (name === deferred.name) return deferred
    if (name === resources.name) return resources
    const target = selected.get(name)
    if (target) return adapter(manager.lookup(name, target.generation))
    return base.get(name)
  }
  return {
    get generation() {
      refresh()
      return `${base.generation}:mcp:${revision}`
    },
    specs() {
      refresh()
      return [
        ...base.specs(),
        ...(manager.statuses().some((status) => status.state === "ready")
          ? [spec(search), spec(deferred), spec(resources)]
          : []),
        ...[...selected.values()].map((tool) => spec(adapter(tool))),
      ]
    },
    get,
    source(name) {
      refresh()
      const tool = selected.get(name)
      return tool
        ? { id: `mcp:${tool.serverId}/${tool.originalName}`, generation: tool.generation }
        : base.source(name)
    },
    resolve(original) {
      refresh()
      let call = original
      if (original.name === resources.name) {
        const input = object(original.input, ["server", "generation", "action", "uri"])
        const server = string(input.server, "server", 32),
          generation = string(input.generation, "generation", 128)
        if (!["list", "templates", "read"].includes(input.action as string))
          throw new ToolInputError("Invalid MCP resource action")
        const action = input.action as "list" | "templates" | "read"
        if (action === "read") string(input.uri, "resource URI")
        if (action !== "read" && input.uri !== undefined)
          throw new ToolInputError("URI applies only to resource reads")
        const target = manager.resourceTarget(server, generation, action)
        const tool: HarnessTool = {
          ...adapter(target),
          source: { id: `mcp:${server}/${target.originalName}`, generation },
          inputSchema: {
            type: "object",
            properties: {
              server: { const: server },
              generation: { const: generation },
              action: { const: action },
              ...(action === "read" ? { uri: { type: "string", minLength: 1, maxLength: 8192 } } : {}),
            },
            required: ["server", "generation", "action", ...(action === "read" ? ["uri"] : [])],
            additionalProperties: false,
          },
          isReadOnly: () => {
            manager.resourceTarget(server, generation, action)
            return true
          },
          run: async (effective, context) => {
            const next = object(effective, ["server", "generation", "action", "uri"])
            if (next.server !== server || next.generation !== generation || next.action !== action)
              throw new ToolInputError("MCP resource rewrite changed the reviewed operation")
            if (action !== "read" && next.uri !== undefined)
              throw new ToolInputError("URI applies only to resource reads")
            manager.resourceTarget(server, generation, action)
            const result =
              action === "read"
                ? await manager.readResource(
                    server,
                    generation,
                    string(next.uri, "resource URI"),
                    context.signal,
                  )
                : {
                    content: [
                      {
                        type: "text",
                        text: boundedJson(
                          await manager.listResources(
                            server,
                            generation,
                            action === "templates",
                            context.signal,
                          ),
                        ),
                      },
                    ],
                  }
            return materializeMcpResult(
              result,
              { server, generation, operation: target.originalName },
              (text) => manager.sanitize(text),
              context.signal,
            )
          },
        }
        return { call: { ...original, name: target.id }, tool }
      }
      if (original.name === deferred.name) {
        const input = object(original.input, ["id", "generation", "input"])
        const id = string(input.id, "tool id", 64),
          generation = string(input.generation, "generation", 128)
        const target = selected.get(id)
        if (!target || target.generation !== generation)
          throw new ToolInputError("MCP selection is stale or unavailable; search and select again")
        manager.validate(id, generation, input.input)
        call = { ...original, name: id, input: input.input }
      }
      const target = selected.get(call.name)
      if (target) manager.validate(target.id, target.generation, call.input)
      const tool = get(call.name)
      if (!tool || tool.hidden) throw new ToolInputError(`Unknown tool: ${call.name}`)
      return { call, tool }
    },
  }
}
