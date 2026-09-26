import Ajv from "ajv"
import type { AgentEvent } from "../core/events.ts"
import { redactSensitiveText } from "../core/redaction.ts"

export const WIRE_VERSION = 1
export const MAX_FRAME = 1024 * 1024
export type RpcId = string | number
export type RpcRequest = { jsonrpc: "2.0"; id?: RpcId; method: string; params?: unknown }
export type RpcResponse = { jsonrpc: "2.0"; id: RpcId | null } & (
  | { result: unknown }
  | { error: { code: number; message: string; data?: unknown } }
)
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
  }
}
const string = { type: "string", minLength: 1, maxLength: 4096 }
const id = { type: "string", minLength: 1, maxLength: 128 }
const integer = { type: "integer", minimum: 0 }
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})
const thread = { threadId: id }
const writer = { ...thread, lease: id }
export const methods = {
  initialize: object(
    {
      version: { const: WIRE_VERSION },
      client: string,
      experimental: { type: "array", maxItems: 16, items: string },
    },
    ["version", "client"],
  ),
  "thread/list": object({}),
  "thread/create": object({ cwd: string, model: string }, ["cwd"]),
  "thread/resume": object(thread, ["threadId"]),
  "thread/snapshot": object(thread, ["threadId"]),
  "thread/replay": object(
    {
      ...thread,
      after: { type: "integer", minimum: -1 },
      limit: { type: "integer", minimum: 1, maximum: 1000 },
    },
    ["threadId"],
  ),
  "lease/acquire": object(
    { ...thread, mode: { enum: ["shared", "exclusive"] }, steal: { type: "boolean" } },
    ["threadId", "mode"],
  ),
  "lease/renew": object(writer, ["threadId", "lease"]),
  "lease/release": object(writer, ["threadId", "lease"]),
  "turn/start": object(
    {
      ...writer,
      text: { type: "string", minLength: 1, maxLength: 524288 },
      submissionId: id,
      literal: { type: "boolean" },
    },
    ["threadId", "lease", "text", "submissionId"],
  ),
  "turn/interrupt": object(writer, ["threadId", "lease"]),
  "request/respond": object({ ...writer, requestId: id, choice: string, data: {} }, [
    "threadId",
    "lease",
    "requestId",
    "choice",
  ]),
  "thread/close": object(writer, ["threadId", "lease"]),
  fuzzyFileSearch: object(
    {
      ...thread,
      query: { type: "string", maxLength: 256 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
    ["threadId", "query"],
  ),
  "tui/control": object(
    {
      ...writer,
      action: { enum: ["prompt", "dialog", "toast"] },
      text: { type: "string", maxLength: 16384 },
    },
    ["threadId", "lease", "action", "text"],
  ),
  "share/create": object(writer, ["threadId", "lease"]),
  "share/revoke": object({ ...writer, shareId: id }, ["threadId", "lease", "shareId"]),
} as const
export type Method = keyof typeof methods
const ajv = new Ajv({ allErrors: false, strict: false })
const validators = new Map(Object.entries(methods).map(([name, schema]) => [name, ajv.compile(schema)]))
export function params(method: string, value: unknown): Record<string, unknown> {
  const validate = validators.get(method)
  if (!validate) throw new RpcError(-32601, `Unknown method: ${method}`)
  if (!validate(value ?? {})) throw new RpcError(-32602, "Invalid method parameters", validate.errors)
  return (value ?? {}) as Record<string, unknown>
}
export function request(value: unknown): RpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RpcError(-32600, "Invalid request")
  const r = value as Record<string, unknown>
  if (
    r.jsonrpc !== "2.0" ||
    typeof r.method !== "string" ||
    r.method.length > 128 ||
    (r.id !== undefined &&
      !(typeof r.id === "string" && r.id.length <= 128) &&
      !(typeof r.id === "number" && Number.isSafeInteger(r.id))) ||
    Object.keys(r).some((k) => !["jsonrpc", "id", "method", "params"].includes(k))
  )
    throw new RpcError(-32600, "Invalid request")
  return r as RpcRequest
}
export function clean(value: unknown, depth = 0): unknown {
  if (depth > 24) return "[omitted]"
  if (typeof value === "string") {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal escape and NUL before public display
    return redactSensitiveText(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
  }
  if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1))
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !["raw", "providerEvent", "signature", "encrypted_content"].includes(key))
        .map(([key, v]) => [
          key,
          /password|secret|api.?key|access.?token|refresh.?token|authorization|cookie/i.test(key)
            ? "[REDACTED]"
            : clean(v, depth + 1),
        ]),
    )
  return value
}
export function publicEvent(event: AgentEvent): AgentEvent | undefined {
  if (event.kind.startsWith("reasoning.") || event.kind === "extension.ui" || event.kind === "hook.activity")
    return undefined
  // `sensitive` marks all conversation text locally; authenticated clients receive its sanitized projection.
  return clean({ ...event, sensitive: false }) as AgentEvent
}
function schemaType(value: unknown): string {
  const schema = value as {
    const?: unknown
    enum?: unknown[]
    type?: string
    items?: unknown
    properties?: Record<string, unknown>
    required?: string[]
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const)
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ")
  if (schema.type === "string" || schema.type === "boolean") return schema.type
  if (schema.type === "integer" || schema.type === "number") return "number"
  if (schema.type === "array") return `Array<${schemaType(schema.items ?? {})}>`
  if (schema.type === "object")
    return `{ ${Object.entries(schema.properties ?? {})
      .map(
        ([key, v]) => `${JSON.stringify(key)}${schema.required?.includes(key) ? "" : "?"}: ${schemaType(v)}`,
      )
      .join("; ")} }`
  return "unknown"
}
export function generatedContract() {
  const schemas = Object.fromEntries(
    Object.entries(methods).map(([name, schema]) => [name.replaceAll("/", "_"), schema]),
  )
  return {
    version: WIRE_VERSION,
    schema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "CodeSplash wire v1",
      definitions: schemas,
    },
    openapi: {
      openapi: "3.1.0",
      info: { title: "CodeSplash daemon", version: "1.0.0" },
      paths: {
        "/rpc": {
          post: {
            security: [{ bearer: [] }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    oneOf: Object.entries(methods).map(([method, schema]) =>
                      object(
                        {
                          jsonrpc: { const: "2.0" },
                          id: { oneOf: [string, integer] },
                          method: { const: method },
                          params: schema,
                        },
                        ["jsonrpc", "id", "method"],
                      ),
                    ),
                  },
                },
              },
            },
            responses: { "200": { description: "JSON-RPC result or error" } },
          },
        },
      },
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } }, schemas },
    },
    types: `// Generated CodeSplash wire version 1.\nexport type MethodParams = { ${Object.entries(methods)
      .map(([key, value]) => `${JSON.stringify(key)}: ${schemaType(value)}`)
      .join(
        "; ",
      )} };\nexport type TypedRequest<M extends Method> = { jsonrpc: "2.0"; id: string | number; method: M; params: MethodParams[M] };\nexport type Method = ${Object.keys(
      methods,
    )
      .map((k) => JSON.stringify(k))
      .join(
        " | ",
      )};\nexport type Request = { jsonrpc: "2.0"; id: string | number; method: Method; params?: Record<string, unknown> };\nexport type Response = { jsonrpc: "2.0"; id: string | number | null } & ({ result: unknown } | { error: { code: number; message: string; data?: unknown } });\n`,
  }
}
