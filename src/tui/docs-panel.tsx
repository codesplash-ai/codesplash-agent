import type { SyntaxStyle } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { useState } from "react"
import releases from "../../CHANGELOG.md" with { type: "text" }
import guide from "../../README.md" with { type: "text" }
import type { BrandPalette } from "./brand.ts"

export function docsSections(text: string) {
  return text.split(/(?=^## )/m).map((body) => ({ title: body.split("\n")[0]!.replace(/^#+\s*/, ""), body }))
}
export function DocsPanel({
  releaseNotes,
  palette,
  syntaxStyle,
  onClose,
}: {
  releaseNotes: boolean
  palette: BrandPalette
  syntaxStyle: SyntaxStyle
  onClose(): void
}) {
  const [release, setRelease] = useState(releaseNotes),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState(0),
    [page, setPage] = useState<string>()
  const rows = docsSections(release ? releases : guide).filter((section) =>
    section.title.toLowerCase().includes(query.toLowerCase()),
  )
  const index = Math.min(selected, Math.max(0, rows.length - 1))
  useKeyboard((key) => {
    if (key.defaultPrevented) return
    if (key.name === "escape") {
      key.preventDefault()
      if (page) setPage(undefined)
      else onClose()
    } else if (key.name === "tab") {
      key.preventDefault()
      setRelease(!release)
      setPage(undefined)
      setQuery("")
      setSelected(0)
    } else if (!page && (key.name === "up" || key.name === "down")) {
      key.preventDefault()
      setSelected(Math.max(0, Math.min(rows.length - 1, index + (key.name === "up" ? -1 : 1))))
    } else if (!page && key.name === "return") {
      key.preventDefault()
      setPage(rows[index]?.body)
    }
  })
  return (
    <box
      style={{
        position: "absolute",
        top: 1,
        left: "4%",
        width: "92%",
        height: "90%",
        zIndex: 40,
        border: true,
        borderColor: palette.accent,
        backgroundColor: palette.popover,
        padding: 1,
        flexDirection: "column",
      }}
    >
      <text style={{ flexShrink: 0 }} fg={palette.accent}>
        {release ? "Release notes" : "Documentation"} · bundled with this version · Tab switches · Esc back
      </text>
      {page ? (
        <scrollbox focused style={{ flexGrow: 1, minHeight: 1 }}>
          <markdown
            content={page}
            syntaxStyle={syntaxStyle}
            streaming={false}
            style={{ width: "100%", flexShrink: 0 }}
          />
        </scrollbox>
      ) : (
        <>
          <input
            style={{ flexShrink: 0 }}
            focused
            value={query}
            onInput={(value) => {
              setQuery(value)
              setSelected(0)
            }}
            placeholder="Search topics"
            textColor={palette.foreground}
            backgroundColor={palette.panel}
          />
          {rows.slice(Math.max(0, index - 4), Math.max(0, index - 4) + 12).map((row) => (
            <text key={row.title} fg={row === rows[index] ? palette.accent : palette.foreground}>
              {row === rows[index] ? "›" : " "} {row.title}
            </text>
          ))}
        </>
      )}
    </box>
  )
}
