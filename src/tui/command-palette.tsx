import { useKeyboard } from "@opentui/react"
import { useState } from "react"
import type { BrandPalette } from "./brand.ts"
import { commandSuggestions } from "./commands.ts"

export function CommandPalette({
  initialQuery,
  models,
  palette,
  onSelect,
  onClose,
}: {
  initialQuery: string
  models: readonly string[]
  palette: BrandPalette
  onSelect(value: string): void
  onClose(): void
}) {
  const [query, setQuery] = useState(initialQuery)
  const [selected, setSelected] = useState(0)
  const rows = commandSuggestions(query, models)
  const index = Math.min(selected, Math.max(0, rows.length - 1))
  useKeyboard((key) => {
    if (key.defaultPrevented) return
    if (key.name === "escape") {
      key.preventDefault()
      onClose()
    } else if (key.name === "up" || key.name === "down") {
      key.preventDefault()
      setSelected(Math.max(0, Math.min(rows.length - 1, index + (key.name === "up" ? -1 : 1))))
    } else if (key.name === "return" || key.name === "kpenter" || key.name === "tab") {
      key.preventDefault()
      if (rows[index]) onSelect(`${rows[index].value} `)
    }
  })
  return (
    <box
      style={{
        position: "absolute",
        left: "8%",
        top: 2,
        width: "84%",
        zIndex: 40,
        border: true,
        borderColor: palette.accent,
        backgroundColor: palette.popover,
        padding: 1,
        flexDirection: "column",
        gap: 1,
      }}
    >
      <text style={{ flexShrink: 0 }} fg={palette.accent}>
        Command palette · Enter stages command · Esc keeps draft
      </text>
      <input
        style={{ flexShrink: 0 }}
        focused
        value={query}
        onInput={(value) => {
          setQuery(value)
          setSelected(0)
        }}
        placeholder="Search commands or arguments"
        textColor={palette.foreground}
        backgroundColor={palette.panel}
      />
      {rows.slice(Math.max(0, index - 4), Math.max(0, index - 4) + 8).map((row) => (
        <text key={row.value} fg={row === rows[index] ? palette.accent : palette.foreground}>
          {row === rows[index] ? "› " : "  "}
          {row.value} · {row.description}
        </text>
      ))}
      {!rows.length && (
        <text style={{ flexShrink: 0 }} fg={palette.muted}>
          No matching commands
        </text>
      )}
    </box>
  )
}
