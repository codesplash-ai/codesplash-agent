import { useKeyboard } from "@opentui/react"
import { useState } from "react"
import type { BranchView } from "../core/session/branches.ts"
import type { AcceptedPrompt } from "../core/session/input-queue.ts"
import type { SessionController } from "../core/session-controller.ts"
import type { BrandPalette } from "./brand.ts"

export function RecoveryPanel({
  controller,
  initial,
  palette,
  onClose,
  onDraft,
}: {
  controller: SessionController
  initial: BranchView
  palette: BrandPalette
  onClose(): void
  onDraft(prompt: AcceptedPrompt, revision: string): void
}) {
  const [tree, setTree] = useState(initial),
    [selected, setSelected] = useState(Math.max(0, initial.nodes.length - 1)),
    [preview, setPreview] = useState<{ node: string; revision: string }>(),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false)
  const node = tree.nodes[selected]
  const perform = async (work: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setMessage("")
    try {
      await work()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  useKeyboard((key) => {
    key.preventDefault()
    if (key.name === "escape") {
      onClose()
      return
    }
    if (busy) return
    if (key.name === "up" || key.name === "down") {
      setSelected(Math.max(0, Math.min(tree.nodes.length - 1, selected + (key.name === "up" ? -1 : 1))))
      setPreview(undefined)
      return
    }
    if (!node) return
    if (key.name === "return" || key.name === "enter")
      void perform(async () => {
        const result = await controller.sessionRecovery({ action: "rewind", node: node.id })
        const data = result.data as { revision: string }
        setPreview({ node: node.id, revision: data.revision })
        setMessage(
          `Select ${node.id}. Conversation changes; files stay as they are. R applies; D recalls the typed prompt only.`,
        )
      })
    else if (key.name === "r" && preview)
      void perform(async () => {
        await controller.sessionRecovery({
          action: "rewind",
          node: preview.node,
          revision: preview.revision,
          apply: true,
        })
        setTree((await controller.sessionRecovery({ action: "tree" })).data as BranchView)
        setPreview(undefined)
        setMessage("Boundary selected. Queued prompts are paused for review.")
      })
    else if (key.name === "f")
      void perform(async () => {
        const result = await controller.sessionRecovery({ action: "fork", node: node.id })
        setMessage(`Fork created: ${result.fork?.localSessionId}. Use /resume to select it.`)
      })
    else if (key.name === "d")
      void perform(async () => {
        const queue = controller.inputQueue,
          prompt = queue?.history().find((item) => item.id === node.promptId)
        if (!queue || !prompt)
          throw new Error("The exact typed prompt is no longer retained in input history")
        onDraft(prompt, queue.snapshot().revision)
      })
  })
  const start = Math.max(0, selected - 7)
  return (
    <box
      title="Session tree / backtrack · Esc closes"
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
        flexDirection: "column",
      }}
    >
      <text fg={palette.muted}>Revision: {tree.revision}</text>
      {tree.providerFork ? (
        <text fg={palette.destructive}>
          Fork {tree.providerFork.id} requires review · provider thread:{" "}
          {tree.providerFork.threadId ?? "unknown"}
        </text>
      ) : null}
      <text fg={palette.muted}>
        ↑↓ select · Enter previews · R applies preview · F forks · D recalls draft
      </text>
      {tree.nodes.slice(start, start + 15).map((item, index) => (
        <text key={item.id} fg={start + index === selected ? palette.accent : palette.foreground}>
          {start + index === selected ? "> " : "  "}
          {item.id === tree.head ? "● " : "○ "}
          {item.id.slice(0, 8)} ← {item.parent?.slice(0, 8) ?? "root"} · {item.kind} · {item.label}
          {!item.context && !item.threadId ? " [context unavailable]" : ""}
        </text>
      ))}
      {!tree.nodes.length ? <text>No retained historical boundaries.</text> : null}
      <text fg={palette.muted}>
        {busy ? "Working…" : message || "Earlier branches and their evidence remain available."}
      </text>
    </box>
  )
}
