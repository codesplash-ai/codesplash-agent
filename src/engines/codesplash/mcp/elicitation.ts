import {
  type FormResponse,
  type InteractionField,
  type InteractionForm,
  validateFormValues,
} from "../../../core/forms.ts"
import { boundedJson, jsonObject } from "./bounds.ts"

const sensitive =
  /password|passphrase|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|secret|credential|verification[ _-]?code|one[ _-]?time[ _-]?(?:pass|code)|private[ _-]?key/i
const text = (value: unknown, max: number) => {
  if (typeof value !== "string" || value.length > max || sensitive.test(value))
    throw new Error("Unsupported or sensitive MCP form")
  return Array.from(value)
    .filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
    .join("")
}
export function parseMcpForm(params: unknown, source: InteractionForm["source"]): InteractionForm {
  boundedJson(params, 32 * 1024, 2000)
  if (
    !jsonObject(params) ||
    (params.mode !== undefined && params.mode !== "form") ||
    !jsonObject(params.requestedSchema)
  )
    throw new Error("Only MCP form elicitation is supported")
  const schema = params.requestedSchema
  if (
    schema.type !== "object" ||
    !jsonObject(schema.properties) ||
    Object.keys(schema.properties).length > 16 ||
    Object.keys(schema).some(
      (key) => !["type", "properties", "required", "additionalProperties"].includes(key),
    )
  )
    throw new Error("Unsupported MCP form schema")
  const required = schema.required ?? []
  if (
    !Array.isArray(required) ||
    required.length > 16 ||
    required.some((name) => typeof name !== "string" || !Object.hasOwn(schema.properties as object, name))
  )
    throw new Error("Invalid MCP required fields")
  const fields: InteractionField[] = []
  for (const [name, raw] of Object.entries(schema.properties)) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) ||
      ["constructor", "prototype", "token", "otp"].includes(name.toLowerCase()) ||
      sensitive.test(name) ||
      !jsonObject(raw)
    )
      throw new Error("Unsupported or sensitive MCP form field")
    if (
      !["string", "number", "integer", "boolean"].includes(raw.type as string) ||
      Object.keys(raw).some(
        (key) =>
          ![
            "type",
            "title",
            "description",
            "enum",
            "enumNames",
            "minimum",
            "maximum",
            "minLength",
            "maxLength",
            "default",
          ].includes(key),
      )
    )
      throw new Error("Unsupported MCP form field schema")
    const field: InteractionField = {
      name,
      label: text(raw.title ?? name, 256),
      type: raw.type as InteractionField["type"],
      required: required.includes(name),
      ...(raw.description === undefined ? {} : { description: text(raw.description, 1024) }),
    }
    for (const key of ["minimum", "maximum", "minLength", "maxLength"] as const) {
      const value = raw[key]
      if (value === undefined) continue
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (["minLength", "maxLength"].includes(key) && (!Number.isInteger(value) || value < 0 || value > 4096))
      )
        throw new Error("Invalid MCP form constraint")
      field[key] = value
    }
    if (
      (field.minimum ?? -Number.MAX_VALUE) > (field.maximum ?? Number.MAX_VALUE) ||
      (field.minLength ?? 0) > (field.maxLength ?? 4096)
    )
      throw new Error("Inconsistent MCP form constraints")
    if (
      raw.enumNames !== undefined ||
      ((raw.minimum !== undefined || raw.maximum !== undefined) &&
        !["number", "integer"].includes(field.type)) ||
      ((raw.minLength !== undefined || raw.maxLength !== undefined) && field.type !== "string")
    )
      throw new Error("Unsupported MCP form constraint for field type")
    if (raw.enum !== undefined) {
      if (raw.type !== "string" || !Array.isArray(raw.enum) || !raw.enum.length || raw.enum.length > 32)
        throw new Error("Unsupported MCP form choices")
      field.choices = raw.enum.map((value) => text(value, 256))
      if (new Set(field.choices).size !== field.choices.length) throw new Error("Duplicate MCP form choices")
    }
    if (raw.default !== undefined)
      validateFormValues({ message: "", source, fields: [field] }, { [name]: raw.default })
    fields.push(field)
  }
  return { message: text(params.message, 8192), fields, source }
}

/** A session has one correlated external form, subordinate to existing pending approvals. */
export class McpElicitationOwner {
  #pending = false
  constructor(
    readonly options: {
      sanitize?: (text: string) => string
      busy?: () => boolean
      respond?: (form: InteractionForm, signal: AbortSignal) => Promise<FormResponse>
    } = {},
  ) {}
  async handle(
    params: unknown,
    operation: (InteractionForm["source"] & { signal: AbortSignal }) | undefined,
  ): Promise<FormResponse> {
    if (
      !operation ||
      operation.signal.aborted ||
      this.#pending ||
      this.options.busy?.() ||
      !this.options.respond
    )
      return { action: "decline" }
    let form: InteractionForm
    try {
      const { signal: _signal, ...source } = operation
      const encoded = boundedJson(params, 32 * 1024, 2000)
      if (this.options.sanitize && this.options.sanitize(encoded) !== encoded)
        throw new Error("MCP form contains credential material")
      form = parseMcpForm(params, source)
    } catch {
      return { action: "decline" }
    }
    this.#pending = true
    let cancel: () => void = () => {}
    const cancelled = new Promise<FormResponse>((resolve) => {
      cancel = () => resolve({ action: "cancel" })
      operation.signal.addEventListener("abort", cancel, { once: true })
    })
    try {
      const response = await Promise.race([this.options.respond(form, operation.signal), cancelled])
      if (operation.signal.aborted) return { action: "cancel" }
      if (response.action === "accept") {
        const content = validateFormValues(form, response.content)
        const encoded = JSON.stringify(content)
        if (this.options.sanitize && this.options.sanitize(encoded) !== encoded) return { action: "decline" }
        return { action: "accept", content }
      }
      return { action: response.action === "cancel" ? "cancel" : "decline" }
    } catch {
      return { action: "decline" }
    } finally {
      operation.signal.removeEventListener("abort", cancel)
      this.#pending = false
    }
  }
}
