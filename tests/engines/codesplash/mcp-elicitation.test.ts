import { expect, test } from "bun:test"
import { validateFormValues } from "../../../src/core/forms.ts"
import { McpElicitationOwner, parseMcpForm } from "../../../src/engines/codesplash/mcp/elicitation.ts"

const source = { server: "fixture", generation: "generation", operation: "echo" }
const request = {
  message: "Choose an output label and count",
  requestedSchema: {
    type: "object",
    properties: {
      label: { type: "string", enum: ["first", "second"] },
      count: { type: "integer", minimum: 1, maximum: 4 },
      consent: { type: "boolean" },
    },
    required: ["label", "count", "consent"],
  },
}

test("MCP forms validate primitive fields and refuse credential requests and unsupported schemas", () => {
  const form = parseMcpForm(request, source)
  expect(validateFormValues(form, { label: "first", count: 2, consent: true })).toEqual({
    label: "first",
    count: 2,
    consent: true,
  })
  expect(() => validateFormValues(form, { label: "first", count: 5, consent: true })).toThrow("Invalid field")
  expect(() => validateFormValues(form, { label: "first", count: 2 })).toThrow("Required field")
  expect(() => parseMcpForm({ ...request, message: "Enter your API key" }, source)).toThrow("sensitive")
  expect(() => parseMcpForm({ ...request, mode: "url", url: "https://example.test" }, source)).toThrow(
    "Only MCP form",
  )
  expect(() =>
    parseMcpForm(
      { message: "Continue", requestedSchema: { type: "object", properties: { token: { type: "string" } } } },
      source,
    ),
  ).toThrow("sensitive")
})

test("MCP elicitation cannot replace an approval, overlap another form, or survive cancellation", async () => {
  let busy = true,
    calls = 0
  const owner = new McpElicitationOwner({
    busy: () => busy,
    respond: async () => {
      calls++
      return new Promise(() => {})
    },
  })
  const abort = new AbortController()
  const operation = { ...source, signal: abort.signal }
  expect(await owner.handle(request, operation)).toEqual({ action: "decline" })
  expect(calls).toBe(0)
  busy = false
  const pending = owner.handle(request, operation)
  expect(calls).toBe(1)
  expect(await owner.handle(request, operation)).toEqual({ action: "decline" })
  abort.abort()
  expect(await pending).toEqual({ action: "cancel" })
  expect(
    await new McpElicitationOwner().handle(request, { ...source, signal: AbortSignal.timeout(1000) }),
  ).toEqual({ action: "decline" })
})
