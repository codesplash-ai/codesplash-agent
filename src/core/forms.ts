/** Host-owned form contract; no protocol SDK types cross the UI/embedding boundary. */
export type InteractionField = {
  name: string
  label: string
  description?: string
  type: "string" | "number" | "integer" | "boolean"
  required: boolean
  choices?: string[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
}
export type InteractionForm = {
  message: string
  fields: InteractionField[]
  source: { server: string; generation: string; operation: string }
}
export type FormValues = Record<string, string | number | boolean>
export type FormResponse = { action: "accept"; content: FormValues } | { action: "decline" | "cancel" }

export function validateFormValues(form: InteractionForm, input: unknown): FormValues {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new Error("Form response must be an object")
  const values = input as Record<string, unknown>
  if (Object.keys(values).some((key) => !form.fields.some((field) => field.name === key)))
    throw new Error("Unknown form field")
  const output: FormValues = Object.create(null)
  let bytes = 0
  for (const field of form.fields) {
    const value = Object.hasOwn(values, field.name) ? values[field.name] : undefined
    if (value === undefined) {
      if (field.required) throw new Error(`Required field: ${field.label}`)
      continue
    }
    if (field.type === "string") {
      if (
        typeof value !== "string" ||
        value.length < (field.minLength ?? 0) ||
        value.length > (field.maxLength ?? 4096) ||
        (field.choices && !field.choices.includes(value))
      )
        throw new Error(`Invalid field: ${field.label}`)
      bytes += Buffer.byteLength(value)
    } else if (field.type === "boolean") {
      if (typeof value !== "boolean") throw new Error(`Invalid field: ${field.label}`)
    } else if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (field.type === "integer" && !Number.isSafeInteger(value)) ||
      value < (field.minimum ?? -Number.MAX_VALUE) ||
      value > (field.maximum ?? Number.MAX_VALUE)
    )
      throw new Error(`Invalid field: ${field.label}`)
    if (bytes > 16 * 1024) throw new Error("Form response exceeds 16 KiB")
    output[field.name] = value as string | number | boolean
  }
  return output
}
