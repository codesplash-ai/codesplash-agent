import type { SyntaxStyle } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { useEffect, useState } from "react"
import type { SessionController } from "../core/index.ts"
import type { BrandPalette } from "./brand.ts"

export function SidePanel({
  controller,
  question,
  palette,
  syntaxStyle,
  onClose,
}: {
  controller: SessionController
  question: string
  palette: BrandPalette
  syntaxStyle: SyntaxStyle
  onClose(): void
}) {
  const [text, setText] = useState("Reading a bounded conversation snapshot…"),
    [busy, setBusy] = useState(true)
  useEffect(() => {
    const owner = new AbortController()
    void controller.sideQuery({ kind: "question", question }, owner.signal).then(
      (result) => {
        if (!owner.signal.aborted) {
          setText(result)
          setBusy(false)
        }
      },
      (error) => {
        if (!owner.signal.aborted) {
          setText(String(error))
          setBusy(false)
        }
      },
    )
    return () => owner.abort(new Error("Side panel closed"))
  }, [controller, question])
  useKeyboard((key) => {
    if (!key.defaultPrevented && key.name === "escape") {
      key.preventDefault()
      onClose()
    }
  })
  return (
    <box
      style={{
        position: "absolute",
        left: "8%",
        top: 1,
        width: "84%",
        height: "80%",
        zIndex: 40,
        border: true,
        borderColor: palette.accent,
        backgroundColor: palette.popover,
        padding: 1,
        flexDirection: "column",
      }}
    >
      <text style={{ flexShrink: 0 }} fg={palette.accent}>
        Side question · ephemeral · no tools · usage counted
      </text>
      <text style={{ flexShrink: 0 }} fg={palette.muted}>
        {question}
      </text>
      <scrollbox focused style={{ flexGrow: 1, minHeight: 1 }}>
        <markdown
          content={text}
          syntaxStyle={syntaxStyle}
          streaming={false}
          style={{ width: "100%", flexShrink: 0 }}
        />
      </scrollbox>
      <text style={{ flexShrink: 0 }} fg={palette.muted}>
        {busy
          ? "Esc cancels this request; the main turn continues"
          : "Esc closes; this answer is not added to the main conversation"}
      </text>
    </box>
  )
}
