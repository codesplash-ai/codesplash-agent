import { describe, expect, test } from "bun:test"
import { RGBA, TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { brandThemes } from "../../src/tui/brand.ts"
import {
  composerCursorStyle,
  composerKeyBindings,
  composerPlaceholder,
  createComposerPlaceholder,
} from "../../src/tui/codex-session.tsx"

describe("Codex composer", () => {
  test("keeps the full placeholder visible when the cursor owns the first cell", async () => {
    const setup = await createTestRenderer({ width: 70, height: 3 })
    const textarea = new TextareaRenderable(setup.renderer, {
      width: 70,
      height: 3,
      placeholder: composerPlaceholder,
    })
    setup.renderer.root.add(textarea)

    try {
      textarea.focus()
      await setup.flush()
      expect(setup.captureCharFrame()).toContain("Ask the agent…")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("keeps the cursor's blink-off cell on the composer background", async () => {
    for (const palette of [brandThemes.light, brandThemes.dark]) {
      const setup = await createTestRenderer({ width: 70, height: 3 })
      const textarea = new TextareaRenderable(setup.renderer, {
        width: 70,
        height: 3,
        placeholder: createComposerPlaceholder(palette),
        backgroundColor: palette.secondary,
        focusedBackgroundColor: palette.secondary,
        cursorColor: palette.accent,
        cursorStyle: composerCursorStyle,
      })
      setup.renderer.root.add(textarea)

      try {
        textarea.focus()
        await setup.flush()
        const firstSpan = setup.captureSpans().lines[0]?.spans[0]
        expect(firstSpan?.text.startsWith(" ")).toBe(true)
        expect(firstSpan?.bg.equals(RGBA.fromHex(palette.secondary))).toBe(true)
        expect(textarea.cursorStyle).toEqual({ style: "block", blinking: false })
      } finally {
        setup.renderer.destroy()
      }
    }
  })

  test("submits with Enter and inserts a newline with Shift+Enter", async () => {
    const setup = await createTestRenderer({ width: 70, height: 4, kittyKeyboard: true })
    let submissions = 0
    const textarea = new TextareaRenderable(setup.renderer, {
      width: 70,
      height: 4,
      keyBindings: composerKeyBindings,
      onSubmit: () => submissions++,
    })
    setup.renderer.root.add(textarea)

    try {
      textarea.focus()
      await setup.mockInput.typeText("first")
      setup.mockInput.pressEnter({ shift: true })
      await setup.mockInput.typeText("second")
      expect(textarea.plainText).toBe("first\nsecond")
      expect(submissions).toBe(0)

      setup.mockInput.pressKey("j", { ctrl: true })
      await setup.mockInput.typeText("third")
      expect(textarea.plainText).toBe("first\nsecond\nthird")

      setup.mockInput.pressEnter()
      await setup.flush()
      expect(submissions).toBe(1)
    } finally {
      setup.renderer.destroy()
    }
  })
})
