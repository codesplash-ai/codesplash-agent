import type { TextareaRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { useEffect, useRef, useState } from "react"
import {
  type FormValues,
  type InteractionField,
  type InteractionForm,
  validateFormValues,
} from "../core/forms.ts"
import type { BrandPalette } from "./brand.ts"

export function formFieldValue(field: InteractionField, raw: string): string | number | boolean | undefined {
  if (!raw && !field.required) return undefined
  if (field.type === "boolean") {
    if (["true", "yes"].includes(raw.toLowerCase())) return true
    if (["false", "no"].includes(raw.toLowerCase())) return false
    throw new Error("Enter yes or no")
  }
  if (field.type === "number" || field.type === "integer") {
    if (!raw.trim()) throw new Error("Enter a number")
    return Number(raw)
  }
  if (field.choices && /^[1-9][0-9]*$/.test(raw)) return field.choices[Number(raw) - 1] ?? raw
  return raw
}

/** A separate form editor; the foreground composer and queued draft remain untouched. */
export function McpFormPanel({
  form,
  palette,
  active,
  onDecision,
}: {
  form: InteractionForm
  palette: BrandPalette
  active: boolean
  onDecision(choice: string, data?: unknown): void
}) {
  const input = useRef<TextareaRenderable>(null)
  const [index, setIndex] = useState(0)
  const [values, setValues] = useState<FormValues>({})
  const [error, setError] = useState("")
  const field = form.fields[index]
  useEffect(() => {
    const current = form.fields[index],
      name = current?.name
    const value = name ? values[name] : undefined
    input.current?.setText(
      value === undefined
        ? ""
        : current?.choices
          ? String(current.choices.indexOf(String(value)) + 1)
          : String(value),
    )
  }, [index, form.fields, values])
  useEffect(() => {
    if (active) input.current?.focus()
  }, [active])
  const next = () => {
    if (!active) return
    try {
      if (!field) {
        onDecision("accept", validateFormValues(form, values))
        return
      }
      const value = formFieldValue(field, input.current?.plainText ?? "")
      const candidate = value === undefined ? {} : { [field.name]: value }
      validateFormValues({ ...form, fields: [field] }, candidate)
      const updated = { ...values }
      delete updated[field.name]
      Object.assign(updated, candidate)
      setValues(updated)
      setIndex(index + 1)
      setError("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid form value")
    }
  }
  useKeyboard((key) => {
    if (!active) return
    if (key.name === "f2" && index > 0) {
      key.preventDefault()
      setIndex(index - 1)
      setError("")
    }
    if (!field && ["return", "kpenter", "linefeed"].includes(key.name)) {
      key.preventDefault()
      next()
    }
  })
  return (
    <box
      title={`MCP ${form.source.server}: ${form.source.operation}`}
      style={{
        position: "absolute",
        width: "80%",
        left: "10%",
        top: "10%",
        maxHeight: "80%",
        zIndex: 20,
        border: true,
        borderStyle: "double",
        borderColor: palette.action,
        backgroundColor: palette.popover,
        padding: 1,
      }}
    >
      <text fg={palette.foreground}>{form.message}</text>
      <text fg={palette.muted}>Answers go to this MCP server. Do not enter credentials.</text>
      <text fg={palette.action}>{active ? "" : "Form waiting · Tab returns to the form."}</text>
      {
        <>
          {field ? (
            <>
              <text fg={palette.foreground}>
                {index + 1}/{form.fields.length}: {field.label}
                {field.required ? " (required)" : " (optional)"}
              </text>
              {field.description ? <text fg={palette.muted}>{field.description}</text> : null}
              {field.choices ? (
                <scrollbox style={{ height: Math.min(6, field.choices.length) }}>
                  {field.choices.map((choice, at) => (
                    <text key={choice} fg={palette.foreground}>
                      {at + 1}. {choice}
                    </text>
                  ))}
                </scrollbox>
              ) : null}
              <textarea
                ref={input}
                focused={active}
                textColor={palette.foreground}
                cursorColor={palette.action}
                backgroundColor={palette.popover}
                focusedBackgroundColor={palette.popover}
                placeholder={
                  field.type === "boolean" ? "yes or no" : field.choices ? "Choice number" : field.type
                }
                style={{ height: 2 }}
                keyBindings={[
                  { name: "return", action: "submit" },
                  { name: "kpenter", action: "submit" },
                  { name: "linefeed", action: "submit" },
                ]}
                onSubmit={next}
              />
            </>
          ) : (
            <>
              <text fg={palette.foreground}>Review answers before sending:</text>
              <scrollbox style={{ height: Math.min(12, form.fields.length + 2) }}>
                <text fg={palette.foreground}>{JSON.stringify(values, null, 2)}</text>
              </scrollbox>
            </>
          )}
          {error ? <text fg={palette.destructive}>{error}</text> : null}
          <text fg={palette.action}>
            {field ? "Enter next" : "Enter sends answers"} · F2 back · Esc cancels · Tab queues a follow-up
          </text>
        </>
      }
    </box>
  )
}
