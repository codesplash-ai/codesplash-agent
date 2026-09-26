import { useKeyboard } from "@opentui/react"
import type { BrandPalette } from "./brand.ts"

export function ConfirmPanel({
  title,
  text,
  palette,
  onConfirm,
  onClose,
}: {
  title: string
  text: string
  palette: BrandPalette
  onConfirm(): void
  onClose(): void
}) {
  useKeyboard((key) => {
    if (key.defaultPrevented) return
    if (key.name === "a" && !key.ctrl && !key.meta) {
      key.preventDefault()
      onConfirm()
    } else if (key.name === "escape" || key.name === "c") {
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
        zIndex: 45,
        border: true,
        borderColor: palette.action,
        backgroundColor: palette.popover,
        padding: 1,
        flexDirection: "column",
      }}
    >
      <text style={{ flexShrink: 0 }} fg={palette.action}>
        {title}
      </text>
      <scrollbox style={{ flexGrow: 1, minHeight: 1 }}>
        <text fg={palette.foreground}>{text}</text>
      </scrollbox>
      <text style={{ flexShrink: 0 }} fg={palette.accent}>
        A accept this review · C / Esc cancel
      </text>
    </box>
  )
}
