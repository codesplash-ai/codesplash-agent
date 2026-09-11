import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator } from "@modelcontextprotocol/client"
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js"
import { boundedJson, jsonObject, MCP_INPUT_BYTES, MCP_SCHEMA_BYTES } from "./bounds.ts"

/** Resolve only local definitions and refuse constructs with unbounded validation cost. */
export function boundedSchema(schema: unknown): Record<string, unknown> | boolean {
  boundedJson(schema, MCP_SCHEMA_BYTES, 2000)
  if (typeof schema !== "boolean" && !jsonObject(schema))
    throw new Error("MCP schema must be an object or boolean")
  let nodes = 0
  const expand = (value: unknown, references: string[] = [], depth = 0): unknown => {
    if (++nodes > 2000 || depth > 16) throw new Error("MCP schema expansion limit exceeded")
    if (typeof value === "boolean") return value
    if (!jsonObject(value)) throw new Error("Invalid MCP subschema")
    if (
      [
        "pattern",
        "patternProperties",
        "$dynamicRef",
        "$recursiveRef",
        "format",
        "unevaluatedItems",
        "unevaluatedProperties",
      ].some((key) => key in value)
    )
      throw new Error("MCP schema uses an unsupported validation construct")
    const supported = new Set([
      "$id",
      "$schema",
      "$defs",
      "definitions",
      "$ref",
      "$comment",
      "type",
      "title",
      "description",
      "default",
      "examples",
      "deprecated",
      "readOnly",
      "writeOnly",
      "enum",
      "const",
      "properties",
      "dependentSchemas",
      "dependentRequired",
      "required",
      "items",
      "additionalProperties",
      "propertyNames",
      "contains",
      "not",
      "if",
      "then",
      "else",
      "allOf",
      "anyOf",
      "oneOf",
      "prefixItems",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
      "uniqueItems",
      "minContains",
      "maxContains",
      "minProperties",
      "maxProperties",
    ])
    if (Object.keys(value).some((key) => !supported.has(key)))
      throw new Error("MCP schema uses an unsupported keyword")
    const target: Record<string, unknown> = { ...value }
    if (value.$ref !== undefined) {
      const ref = value.$ref
      if (
        typeof ref !== "string" ||
        !/^#\/(\$defs|definitions)\/[^/]+$/.test(ref) ||
        references.includes(ref)
      )
        throw new Error("MCP schema references must be acyclic local definitions")
      const [, table, name] = ref.split("/")
      const definitions = jsonObject(schema) && table ? schema[table] : undefined
      const definition =
        jsonObject(definitions) && name
          ? definitions[name.replaceAll("~1", "/").replaceAll("~0", "~")]
          : undefined
      const resolved = expand(definition, [...references, ref], depth + 1)
      const siblings = { ...value }
      delete siblings.$ref
      return { allOf: [resolved, expand(siblings, references, depth + 1)] }
    }
    for (const key of ["$id", "$schema", "$defs", "definitions"]) delete target[key]
    for (const key of ["properties", "dependentSchemas"])
      if (target[key] !== undefined) {
        if (!jsonObject(target[key])) throw new Error("Invalid MCP schema property map")
        target[key] = Object.fromEntries(
          Object.entries(target[key]).map(([name, child]) => [name, expand(child, references, depth + 1)]),
        )
      }
    for (const key of [
      "items",
      "additionalProperties",
      "propertyNames",
      "contains",
      "not",
      "if",
      "then",
      "else",
    ])
      if (target[key] !== undefined) target[key] = expand(target[key], references, depth + 1)
    for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"])
      if (target[key] !== undefined) {
        if (!Array.isArray(target[key]) || target[key].length > 8)
          throw new Error("MCP schema has too many alternatives")
        target[key] = target[key].map((child) => expand(child, references, depth + 1))
      }
    return target
  }
  return expand(schema) as Record<string, unknown> | boolean
}

/** Compile lazily: discovering a large catalog never compiles every server-supplied schema. */
export class BoundedSchemaValidators implements jsonSchemaValidator {
  readonly #cache = new Map<string, ValidateFunction>()
  constructor(
    readonly maxBytes = MCP_INPUT_BYTES,
    readonly maxNodes = 5000,
  ) {}
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const normalized = boundedSchema(schema)
    const identity = boundedJson(normalized, MCP_SCHEMA_BYTES)
    return (input: unknown) => {
      try {
        boundedJson(input, this.maxBytes, this.maxNodes)
        let validate = this.#cache.get(identity)
        if (!validate) {
          const ajv = new Ajv2020({
            strict: true,
            strictTypes: false,
            allErrors: false,
            ownProperties: true,
            validateFormats: false,
          })
          validate = ajv.compile(normalized)
          if (this.#cache.size >= 128) this.#cache.delete(this.#cache.keys().next().value ?? "")
          this.#cache.set(identity, validate)
        }
        if (validate(input)) return { valid: true, data: input as T, errorMessage: undefined }
        return { valid: false, data: undefined, errorMessage: "Input does not match the MCP tool schema" }
      } catch (error) {
        return {
          valid: false,
          data: undefined,
          errorMessage: error instanceof Error ? error.message.slice(0, 512) : "MCP schema validation failed",
        }
      }
    }
  }
}
