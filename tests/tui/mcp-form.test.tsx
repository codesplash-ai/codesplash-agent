import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "@opentui/react"
import { useState } from "react"
import type { InteractionForm } from "../../src/core/forms.ts"
import { brandThemes } from "../../src/tui/brand.ts"
import { approvalChoiceForKey } from "../../src/tui/codex-session.tsx"
import { McpFormPanel } from "../../src/tui/mcp-form.tsx"

const form: InteractionForm = {
  message: "Choose a label",
  source: { server: "fixture", generation: "generation", operation: "echo" },
  fields: [{ name: "label", label: "Label", type: "string", required: true }],
}
test("MCP form letters are input, never approval shortcuts", () => {
  const request = {
    id: "form",
    requestKind: "elicitation" as const,
    form,
    title: "Form",
    detail: "",
    choices: ["accept", "decline"],
  }
  for (const key of ["a", "c", "d", "y", "1", "return"])
    expect(approvalChoiceForKey(key, request)).toBeUndefined()
  expect(approvalChoiceForKey("escape", request)).toBe("cancel")
})

test("rendered MCP form preserves an unfinished answer across focus changes and requires review", async () => {
  const setup = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true })
  const root = createRoot(setup.renderer)
  const decisions: unknown[] = []
  let focus: (active: boolean) => void = () => {}
  function App() {
    const [active, setActive] = useState(true)
    focus = setActive
    return (
      <McpFormPanel
        form={form}
        palette={brandThemes.dark}
        active={active}
        onDecision={(choice, data) => {
          decisions.push({ choice, data })
        }}
      />
    )
  }
  const settle = async () => {
    await setup.flush()
    await Bun.sleep(10)
    await setup.flush()
  }
  try {
    root.render(<App />)
    await settle()
    await setup.mockInput.typeText("draft")
    await settle()
    expect(setup.captureCharFrame()).toContain("draft")
    focus(false)
    await settle()
    expect(setup.captureCharFrame()).toContain("draft")
    focus(true)
    await settle()
    await setup.mockInput.typeText("-kept")
    await settle()
    setup.mockInput.pressEnter()
    await settle()
    expect(decisions).toEqual([])
    setup.mockInput.pressEnter()
    await settle()
    expect(decisions).toEqual([{ choice: "accept", data: { label: "draft-kept" } }])
  } finally {
    setup.renderer.destroy()
  }
})
