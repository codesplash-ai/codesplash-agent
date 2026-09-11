import Ajv2020 from "ajv/dist/2020.js"
import type { InteractionForm } from "../../../core/forms.ts"
import type { PermissionTargets } from "../contracts.ts"
import { boundedJson, jsonObject } from "../mcp/bounds.ts"
import { parseMcpForm } from "../mcp/elicitation.ts"
import { boundedSchema } from "../mcp/schema.ts"

export function validateExtensionSchema(schema: Record<string, unknown>): void {
  new Ajv2020({
    strict: true,
    strictTypes: false,
    allErrors: false,
    ownProperties: true,
    validateFormats: false,
  }).compile(boundedSchema(schema))
}
export function validateExtensionTargets(value: unknown): asserts value is PermissionTargets {
  boundedJson(value, 16384, 256)
  if (!jsonObject(value) || Object.keys(value).some((key) => !["paths", "command", "urlHost"].includes(key)))
    throw new Error("Invalid extension permission targets")
  const text = (value: unknown, max: number) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !Array.from(value).some((char) => char.charCodeAt(0) < 32)
  if (
    (value.paths !== undefined &&
      (!Array.isArray(value.paths) ||
        value.paths.length > 128 ||
        value.paths.some((path) => !text(path, 4096)))) ||
    (value.command !== undefined && !text(value.command, 8192)) ||
    (value.urlHost !== undefined && !text(value.urlHost, 253))
  )
    throw new Error("Invalid extension permission target value")
}
/** Use the existing UI vocabulary and sensitive-field refusal; no parallel form renderer. */
export function validateExtensionForm(
  form: Omit<InteractionForm, "source">,
  source: InteractionForm["source"],
): InteractionForm {
  boundedJson(form, 16384, 256)
  if (
    !jsonObject(form) ||
    Object.keys(form).some((key) => !["message", "fields"].includes(key)) ||
    !Array.isArray(form.fields) ||
    form.fields.length > 16
  )
    throw new Error("Invalid extension dialog")
  const names = new Set<string>(),
    properties: Record<string, unknown> = Object.create(null),
    required: string[] = []
  for (const field of form.fields) {
    if (
      !jsonObject(field) ||
      typeof field.name !== "string" ||
      names.has(field.name) ||
      typeof field.label !== "string" ||
      typeof field.required !== "boolean" ||
      Object.keys(field).some(
        (key) =>
          ![
            "name",
            "label",
            "description",
            "type",
            "required",
            "choices",
            "minimum",
            "maximum",
            "minLength",
            "maxLength",
          ].includes(key),
      )
    )
      throw new Error("Invalid extension dialog field")
    names.add(field.name)
    if (field.required) required.push(field.name)
    const { name, label, required: _, choices, ...rest } = field
    properties[name] = { ...rest, title: label, ...(choices === undefined ? {} : { enum: choices }) }
  }
  return parseMcpForm(
    { message: form.message, requestedSchema: { type: "object", properties, required } },
    source,
  )
}
