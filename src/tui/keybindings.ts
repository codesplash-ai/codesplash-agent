import type { KeyEvent, TextareaRenderable } from "@opentui/core"
import { boundedLocalBytes } from "./themes.ts"

export const actions = [
  "palette",
  "editor",
  "help",
  "latest",
  "outline",
  "history",
  "stash",
  "background",
  "suspend",
  "home",
  "permission",
  "submit",
  "newline",
] as const
export type KeyAction = (typeof actions)[number]
export type KeyContext = "global" | "composer" | "approval" | "overlay"
export type KeyBinding = { context: KeyContext; keys: string; action: KeyAction | "none" }
export const defaultBindings: KeyBinding[] = [
  { context: "global", keys: "ctrl+p", action: "palette" },
  { context: "composer", keys: "ctrl+g", action: "editor" },
  { context: "global", keys: "f1", action: "help" },
  { context: "global", keys: "ctrl+l", action: "latest" },
  { context: "global", keys: "ctrl+o", action: "outline" },
  { context: "composer", keys: "ctrl+r", action: "history" },
  { context: "composer", keys: "ctrl+s", action: "stash" },
  { context: "global", keys: "ctrl+b", action: "background" },
  { context: "global", keys: "ctrl+z", action: "suspend" },
  { context: "global", keys: "ctrl+q", action: "home" },
  { context: "global", keys: "shift+tab", action: "permission" },
]
export function keyToken(key: Pick<KeyEvent, "name" | "ctrl" | "shift" | "meta" | "option">): string {
  return `${key.ctrl ? "ctrl+" : ""}${key.meta || key.option ? "alt+" : ""}${key.shift ? "shift+" : ""}${key.name === "kpenter" ? "return" : key.name}`
}
export function parseKeybindings(value: unknown): KeyBinding[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid keybindings file")
  const { version, bindings } = value as { version?: unknown; bindings?: unknown }
  if (version !== 1 || !Array.isArray(bindings) || bindings.length > 128)
    throw new Error("Expected keybindings version 1 and at most 128 bindings")
  const custom: KeyBinding[] = []
  for (const row of bindings) {
    if (
      !row ||
      typeof row !== "object" ||
      !["global", "composer", "approval", "overlay"].includes(row.context) ||
      ![...actions, "none"].includes(row.action) ||
      typeof row.keys !== "string" ||
      !/^(?:(?:ctrl\+)?(?:alt\+)?(?:shift\+)?[a-z0-9]+)(?: (?:(?:ctrl\+)?(?:alt\+)?(?:shift\+)?[a-z0-9]+)){0,2}$/.test(
        row.keys,
      )
    )
      throw new Error("Invalid keybinding")
    if (row.keys.split(" ").some((key: string) => ["escape", "ctrl+c"].includes(key)))
      throw new Error("Escape and Ctrl+C are reserved for recovery")
    if (
      ["editor", "submit", "newline", "stash", "history"].includes(row.action) &&
      row.context !== "composer"
    )
      throw new Error(`${row.action} requires composer context`)
    if (row.context === "overlay" && !["home", "palette", "help", "suspend", "none"].includes(row.action))
      throw new Error("Overlay bindings support home, palette, help, suspend or none")
    custom.push({ context: row.context, keys: row.keys, action: row.action })
  }
  const merged = [
    ...defaultBindings.filter(
      (row) =>
        !custom.some(
          (item) =>
            item.context === row.context &&
            (item.keys === row.keys || (item.action === row.action && item.action !== "none")),
        ),
    ),
    ...custom,
  ]
  for (let i = 0; i < merged.length; i++)
    for (const other of merged.slice(i + 1)) {
      const row = merged[i]!
      if (
        row.context === other.context &&
        (row.keys === other.keys ||
          `${row.keys} `.startsWith(`${other.keys} `) ||
          `${other.keys} `.startsWith(`${row.keys} `))
      )
        throw new Error("Ambiguous keybinding or chord prefix")
    }
  return merged
}
export function readKeybindings(path: string): KeyBinding[] {
  try {
    const bytes = boundedLocalBytes(path, 65536)
    return parseKeybindings(JSON.parse(bytes.toString("utf8")))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultBindings
    throw error
  }
}
export class Keymap {
  pending = ""
  deadline = 0
  context?: KeyContext
  constructor(public bindings = defaultBindings) {}
  resolve(
    key: string,
    context: KeyContext,
    now = Date.now(),
    globalFallback = true,
  ): KeyAction | "none" | "pending" | undefined {
    if (context !== this.context || now > this.deadline) this.pending = ""
    this.context = context
    const source = this.pending ? `${this.pending} ${key}` : key
    const matching = (scope: KeyContext) =>
      this.bindings.filter(
        (row) => row.context === scope && (row.keys === source || row.keys.startsWith(`${source} `)),
      )
    const specific = matching(context),
      rows = specific.length ? specific : globalFallback ? matching("global") : []
    const exact = rows.find((row) => row.keys === source)
    if (exact) {
      this.pending = ""
      return exact.action
    }
    if (rows.length) {
      this.pending = source
      this.deadline = now + 1000
      return "pending"
    }
    const wasPending = !!this.pending
    this.pending = ""
    // An unmatched chord is consumed so it cannot accidentally type/submit its final key.
    return wasPending ? "none" : undefined
  }
}

export class VimComposer {
  mode: "INSERT" | "NORMAL" = "INSERT"
  private operator?: "d" | "c"
  private repeat?: (editor: TextareaRenderable) => void
  private insertion?: { before: string; prepare: (editor: TextareaRenderable) => void }
  private beginInsert(editor: TextareaRenderable, prepare: (editor: TextareaRenderable) => void = () => {}) {
    this.insertion = { before: editor.plainText, prepare }
    this.mode = "INSERT"
  }
  private finishInsert(editor: TextareaRenderable) {
    const insertion = this.insertion
    this.insertion = undefined
    if (!insertion || insertion.before === editor.plainText) return
    const before = [...insertion.before],
      after = [...editor.plainText]
    let start = 0,
      suffix = 0
    while (start < before.length && start < after.length && before[start] === after[start]) start++
    while (
      suffix < before.length - start &&
      suffix < after.length - start &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    )
      suffix++
    const added = after.slice(start, after.length - suffix).join("")
    this.repeat = (target) => {
      insertion.prepare(target)
      target.insertText(added)
    }
  }
  handle(
    key: Pick<KeyEvent, "name" | "ctrl" | "shift" | "meta" | "option">,
    editor: TextareaRenderable,
  ): boolean {
    if (key.name === "escape") {
      const changed = this.mode !== "NORMAL"
      if (changed) this.finishInsert(editor)
      this.mode = "NORMAL"
      this.operator = undefined
      return changed
    }
    if (key.meta || key.option || (key.ctrl && key.name !== "r")) return false
    if (this.mode === "INSERT") {
      if (!this.insertion && key.name.length === 1 && !key.ctrl) this.beginInsert(editor)
      return false
    }
    if (key.name.length > 1) return false
    const name = key.shift ? key.name.toUpperCase() : key.name
    if (this.operator) {
      const operator = this.operator
      this.operator = undefined
      const motion: ((target: TextareaRenderable) => void) | undefined =
        name === operator
          ? (target) => {
              target.deleteLine()
            }
          : name === "w"
            ? (target) => {
                target.deleteWordForward()
              }
            : name === "b"
              ? (target) => {
                  target.deleteWordBackward()
                }
              : name === "$" || (name === "4" && key.shift)
                ? (target) => {
                    target.deleteToLineEnd()
                  }
                : name === "0"
                  ? (target) => {
                      target.deleteToLineStart()
                    }
                  : undefined
      if (motion) {
        motion(editor)
        this.repeat = motion
        if (operator === "c") this.beginInsert(editor, motion)
      }
      return true
    }
    if (key.ctrl && name === "r") editor.redo()
    else if (name === ".") this.repeat?.(editor)
    else if (name === "i") this.beginInsert(editor)
    else if (name === "a") {
      editor.moveCursorRight()
      this.beginInsert(editor, (target) => target.moveCursorRight())
    } else if (name === "I") {
      editor.gotoLineHome()
      this.beginInsert(editor, (target) => target.gotoLineHome())
    } else if (name === "A") {
      editor.gotoLineEnd()
      this.beginInsert(editor, (target) => target.gotoLineEnd())
    } else if (name === "h") editor.moveCursorLeft()
    else if (name === "j") editor.moveCursorDown()
    else if (name === "k") editor.moveCursorUp()
    else if (name === "l") editor.moveCursorRight()
    else if (name === "w") editor.moveWordForward()
    else if (name === "b") editor.moveWordBackward()
    else if (name === "0") editor.gotoLineHome()
    else if (name === "$" || (name === "4" && key.shift)) editor.gotoLineEnd()
    else if (name === "x") {
      this.repeat = (target) => {
        target.deleteChar()
      }
      this.repeat(editor)
    } else if (name === "d" || name === "c") this.operator = name
    else if (name === "u") editor.undo()
    return true
  }
}
