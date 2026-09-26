import { useKeyboard } from "@opentui/react"
import { useState } from "react"
import type { TranscriptItem } from "../core/index.ts"
import type { BrandPalette } from "./brand.ts"

export function SearchPanel({
  transcript,
  initialQuery,
  palette,
  onSelect,
  onClose,
}: {
  transcript: readonly TranscriptItem[]
  initialQuery: string
  palette: BrandPalette
  onSelect(item: TranscriptItem): void
  onClose(): void
}) {
  const [query, setQuery] = useState(initialQuery),
    [selected, setSelected] = useState(0)
  const rows = query
    ? transcript
        .filter((item) =>
          `${item.label ?? ""} ${item.text}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
        )
        .slice(-200)
    : []
  const index = Math.min(selected, Math.max(0, rows.length - 1))
  useKeyboard((key) => {
    if (key.defaultPrevented) return
    if (key.name === "escape") {
      key.preventDefault()
      onClose()
    } else if (key.name === "up" || key.name === "down") {
      key.preventDefault()
      setSelected(Math.max(0, Math.min(rows.length - 1, index + (key.name === "up" ? -1 : 1))))
    } else if (key.name === "return") {
      key.preventDefault()
      if (rows[index]) onSelect(rows[index])
    }
  })
  return (
    <box
      style={{
        position: "absolute",
        left: "8%",
        top: 1,
        width: "84%",
        zIndex: 40,
        border: true,
        borderColor: palette.accent,
        backgroundColor: palette.popover,
        padding: 1,
        flexDirection: "column",
      }}
    >
      <text style={{ flexShrink: 0 }} fg={palette.accent}>
        Search transcript · {rows.length} matches (latest 200) · Enter navigates · Esc closes
      </text>
      <input
        style={{ flexShrink: 0 }}
        focused
        value={query}
        onInput={(value) => {
          setQuery(value.slice(0, 512))
          setSelected(0)
        }}
        textColor={palette.foreground}
        backgroundColor={palette.panel}
      />
      {rows.slice(Math.max(0, index - 3), Math.max(0, index - 3) + 7).map((row) => (
        <text key={row.id} fg={row === rows[index] ? palette.accent : palette.foreground}>
          {row === rows[index] ? "›" : " "} {row.kind} · {row.text.replace(/\s+/g, " ").slice(0, 160)}
        </text>
      ))}
    </box>
  )
}
