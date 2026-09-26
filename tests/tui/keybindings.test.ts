import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { validateTuiConfig } from "../../src/core/config/tui.ts"
import { Keymap, parseKeybindings, VimComposer } from "../../src/tui/keybindings.ts"
import { clipboardText, copyText, osc52, terminalProfile } from "../../src/tui/terminal.ts"

test("contextual chords shadow defaults, expire and consume failed sequences", () => {
  const map = new Keymap(
    parseKeybindings({ version: 1, bindings: [{ context: "composer", keys: "ctrl+x e", action: "editor" }] }),
  )
  expect(map.resolve("ctrl+p", "overlay", 0, false)).toBeUndefined()
  const overlay = new Keymap(
    parseKeybindings({ version: 1, bindings: [{ context: "overlay", keys: "ctrl+x", action: "home" }] }),
  )
  expect(overlay.resolve("ctrl+x", "overlay", 0, false)).toBe("home")
  expect(map.resolve("ctrl+g", "composer", 0)).toBeUndefined()
  expect(map.resolve("ctrl+x", "composer", 1)).toBe("pending")
  expect(map.resolve("e", "composer", 2)).toBe("editor")
  expect(map.resolve("ctrl+x", "approval", 3)).toBeUndefined()
  expect(map.resolve("ctrl+x", "composer", 4)).toBe("pending")
  expect(map.resolve("return", "composer", 5)).toBe("none")
  expect(map.resolve("ctrl+x", "composer", 6)).toBe("pending")
  expect(map.resolve("e", "composer", 2000)).toBeUndefined()
  expect(() =>
    parseKeybindings({ version: 1, bindings: [{ context: "global", keys: "a", action: "submit" }] }),
  ).toThrow("composer")
  expect(() =>
    parseKeybindings({ version: 1, bindings: [{ context: "global", keys: "ctrl+c", action: "none" }] }),
  ).toThrow("reserved")
  expect(() =>
    parseKeybindings({ version: 1, bindings: [{ context: "global", keys: "ctrl+p x", action: "help" }] }),
  ).toThrow("Ambiguous")
})

test("vim uses native Unicode editing, escape returns to recovery and controls remain available", async () => {
  const setup = await createTestRenderer({ width: 40, height: 5 })
  const editor = new TextareaRenderable(setup.renderer, { initialValue: "日本語 test" })
  setup.renderer.root.add(editor)
  const vim = new VimComposer()
  const key = (name: string, ctrl = false) => ({ name, ctrl, shift: false, meta: false, option: false })
  try {
    editor.gotoBufferHome()
    expect(vim.handle(key("escape"), editor)).toBe(true)
    expect(vim.handle(key("escape"), editor)).toBe(false)
    vim.handle(key("x"), editor)
    expect(editor.plainText).toBe("本語 test")
    vim.handle(key("u"), editor)
    expect(editor.plainText).toBe("日本語 test")
    expect(vim.handle(key("p", true), editor)).toBe(false)
    vim.handle(key("a"), editor)
    expect(vim.mode).toBe("INSERT")
    expect(vim.handle(key("x"), editor)).toBe(false)
  } finally {
    setup.renderer.destroy()
  }
})

test("clipboard caps messages and safely emits tmux OSC52 instead of remote host copy", async () => {
  const text = clipboardText([
    { id: "a", kind: "message", status: "completed", text: "你好\x1b]52;bad" },
    { id: "b", kind: "reasoning", status: "completed", text: "private" },
  ])
  let written = ""
  const result = await copyText(text, {
    mode: "auto",
    env: { SSH_CONNECTION: "remote", TMUX: "yes" },
    write: (value) => {
      written = value
    },
  })
  expect(written).toBe(osc52(text, true))
  expect(written).not.toContain("bad")
  expect(result).toContain("request sent")
  expect(() => clipboardText([], 0)).toThrow()
  expect(terminalProfile({ TERM: "dumb" }).dumb).toBe(true)
  expect(() => validateTuiConfig({ notificationIdleMs: -1 })).toThrow()
  expect(validateTuiConfig({ mouseScroll: "linear", copyOnSelect: true }).copyOnSelect).toBe(true)
  expect(() => validateTuiConfig({ theme: "../escape" })).toThrow()
  expect(() => validateTuiConfig({ statusSegments: ["secrets"] })).toThrow()
})

test("vim delete/change operators and dot replay use native word and Unicode edits", async () => {
  const setup = await createTestRenderer({ width: 40, height: 5 })
  const editor = new TextareaRenderable(setup.renderer, { initialValue: "one two three" })
  setup.renderer.root.add(editor)
  const vim = new VimComposer()
  const key = (name: string) => ({ name, ctrl: false, shift: false, meta: false, option: false })
  try {
    editor.gotoBufferHome()
    vim.handle(key("escape"), editor)
    vim.handle(key("d"), editor)
    vim.handle(key("w"), editor)
    expect(editor.plainText).toBe("two three")
    vim.handle(key("."), editor)
    expect(editor.plainText).toBe("three")
    editor.setText("one two")
    editor.gotoBufferHome()
    vim.handle(key("c"), editor)
    vim.handle(key("w"), editor)
    expect(vim.mode).toBe("INSERT")
    editor.insertText("日本語 ")
    vim.handle(key("escape"), editor)
    vim.handle(key("."), editor)
    expect(editor.plainText).toBe("日本語 日本語 ")
  } finally {
    setup.renderer.destroy()
  }
})
