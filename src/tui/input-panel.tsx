import { useKeyboard } from "@opentui/react"
import { useState } from "react"
import type {
  AcceptedPrompt,
  DraftStash,
  InputItem,
  InputQueue,
  InputQueueSnapshot,
} from "../core/session/input-queue.ts"
import { safeSessionText } from "../core/session/repository.ts"
import type { BrandPalette } from "./brand.ts"

export type InputPanelTab = "queue" | "history" | "stash"
export function inputDraftText(input: AcceptedPrompt["input"]): string {
  if (input.sourceText !== undefined) return input.sourceText
  let text = input.text
  for (const image of input.images ?? []) {
    const name = image.split("/").at(-1) ?? image
    const path = JSON.stringify(image)
    text = text.includes(`[image: ${name}]`) ? text.replace(`[image: ${name}]`, path) : `${text}\n${path}`
  }
  for (const file of input.files ?? []) text += `\n@${JSON.stringify(file)}`
  return text
}

export function InputPanel({
  queue,
  snapshot,
  tab,
  palette,
  onRestore,
  onClose,
}: {
  queue: InputQueue
  snapshot: InputQueueSnapshot
  tab: InputPanelTab
  palette: BrandPalette
  onRestore: (prompt: AcceptedPrompt, mode: "edit" | "recall" | "pop", revision: string) => void
  onClose: () => void
}) {
  const [selected, setSelected] = useState(0),
    [query, setQuery] = useState(""),
    [message, setMessage] = useState("")
  const [confirmation, setConfirmation] = useState<{
    id?: string
    revision: string
    text: string
    action: "retry" | "clear"
  }>()
  const rows: AcceptedPrompt[] =
    tab === "queue"
      ? snapshot.items.filter((item) => !["completed", "cancelled"].includes(item.status))
      : tab === "history"
        ? snapshot.history.filter((item) =>
            (item.input.sourceText ?? item.input.text)
              .toLocaleLowerCase()
              .includes(query.toLocaleLowerCase()),
          )
        : snapshot.stashes
  const index = Math.min(selected, Math.max(0, rows.length - 1)),
    item = rows[index]
  const perform = (action: () => void) => {
    try {
      action()
      setMessage("")
    } catch (error) {
      setMessage(safeSessionText(error instanceof Error ? error.message : String(error)))
    }
  }
  useKeyboard((key) => {
    if (key.ctrl && ["c", "q", "s"].includes(key.name)) return
    key.preventDefault()
    if (key.name === "escape") {
      if (confirmation) setConfirmation(undefined)
      else onClose()
      return
    }
    if (confirmation) {
      if (key.name === "return" || key.name === "enter") {
        if (confirmation.text !== confirmation.action) return
        perform(() => {
          if (confirmation.action === "retry" && confirmation.id)
            queue.retry(confirmation.id, confirmation.revision, true)
          else if (tab === "history") queue.clearHistory(confirmation.revision)
          else queue.clearCompleted(confirmation.revision)
          setConfirmation(undefined)
        })
        return
      }
      if (key.name === "backspace")
        setConfirmation((current) => (current ? { ...current, text: current.text.slice(0, -1) } : current))
      else if (!key.ctrl && !key.meta && key.sequence && /^[a-z]+$/i.test(key.sequence))
        setConfirmation((current) =>
          current ? { ...current, text: (current.text + key.sequence).slice(0, 16) } : current,
        )
      return
    }
    if ((key.name === "up" || key.name === "down") && key.ctrl && tab === "queue" && item) {
      const neighbor = rows[index + (key.name === "up" ? -1 : 1)]
      if (neighbor)
        perform(() => {
          queue.move(
            item.id,
            snapshot.items.findIndex((row) => row.id === neighbor.id),
            snapshot.revision,
          )
          setSelected(index + (key.name === "up" ? -1 : 1))
        })
      return
    }
    if (key.name === "up" || key.name === "down") {
      setSelected(Math.max(0, Math.min(rows.length - 1, index + (key.name === "up" ? -1 : 1))))
      return
    }
    if (key.ctrl && key.name === "d" && tab !== "stash") {
      setConfirmation({ action: "clear", revision: snapshot.revision, text: "" })
      return
    }
    if (tab === "history") {
      if ((key.name === "return" || key.name === "enter") && item)
        perform(() => onRestore(item, "recall", snapshot.revision))
      else if (key.name === "backspace") {
        setQuery((value) => Array.from(value).slice(0, -1).join(""))
        setSelected(0)
      }
      // biome-ignore lint/suspicious/noControlCharactersInRegex: accept text, not escape sequences
      else if (!key.ctrl && !key.meta && key.sequence && !/[\x00-\x1f\x7f]/.test(key.sequence)) {
        setQuery((value) => (value + key.sequence).slice(0, 1000))
        setSelected(0)
      }
      return
    }
    if (tab === "queue" && key.name === "p") {
      perform(() => {
        if (snapshot.paused) queue.resume(snapshot.revision)
        else queue.pause(snapshot.revision)
      })
      return
    }
    if (!item) return
    if (tab === "queue" && key.name === "r") {
      if ((item as InputItem).status === "execution-uncertain")
        setConfirmation({ id: item.id, action: "retry", revision: snapshot.revision, text: "" })
      else
        perform(() => {
          queue.retry(item.id, snapshot.revision)
        })
    } else if (key.name === "d")
      perform(() => {
        if (tab === "stash") queue.dropStash(item.id, snapshot.revision)
        else queue.remove(item.id, snapshot.revision)
      })
    else if (key.name === "e" && tab === "queue") perform(() => onRestore(item, "edit", snapshot.revision))
    else if ((key.name === "return" || key.name === "enter") && tab === "stash")
      perform(() => onRestore(item, "recall", snapshot.revision))
    else if (key.name === "p" && tab === "stash") perform(() => onRestore(item, "pop", snapshot.revision))
  })
  const start = Math.max(0, index - 8)
  return (
    <box
      title={`${tab === "queue" ? "Input queue" : tab === "history" ? "Prompt history" : "Draft stashes"} · Esc closes`}
      style={{
        position: "absolute",
        left: "8%",
        top: 2,
        width: "84%",
        zIndex: 40,
        border: true,
        borderColor: palette.action,
        backgroundColor: palette.popover,
        padding: 1,
      }}
    >
      <text fg={palette.muted}>
        {tab === "queue"
          ? `${snapshot.paused ? "Paused" : "Ready"} · p pause/resume · e edit · Ctrl+↑/↓ reorder · d remove · r retry · Ctrl+D clear completed`
          : tab === "history"
            ? `Search: ${query} · Enter recalls · Ctrl+D clears accepted history`
            : "Enter apply · p pop · d drop · Ctrl+S saves the current composer draft"}
      </text>
      {rows.slice(start, start + 16).map((row, i) => (
        <text key={row.id} fg={start + i === index ? palette.action : palette.foreground}>
          {start + i === index ? "› " : "  "}
          {tab === "queue"
            ? `[${(row as InputItem).status}/${(row as InputItem).intent}${(row as InputItem).boundary ? `/${(row as InputItem).boundary}` : ""}] `
            : tab === "stash"
              ? `${(row as DraftStash).name}: `
              : ""}
          {safeSessionText(row.input.sourceText ?? row.input.text).slice(0, 100)}
          {row.references.length ? ` (${row.references.length} attachments)` : ""}
        </text>
      ))}
      {rows.length === 0 ? <text fg={palette.muted}>No entries.</text> : null}
      {tab === "queue" && (item as InputItem | undefined)?.issue ? (
        <text fg={palette.muted}>{safeSessionText((item as InputItem).issue ?? "")}</text>
      ) : null}
      {confirmation ? (
        <text fg={palette.destructive}>
          {confirmation.action === "retry"
            ? "This may repeat external effects. Inspect the previous work first."
            : "Remove the selected history category? Conversation history remains."}{" "}
          Type {confirmation.action}: {confirmation.text}▏
        </text>
      ) : null}
      {message ? <text fg={palette.destructive}>{message}</text> : null}
    </box>
  )
}
