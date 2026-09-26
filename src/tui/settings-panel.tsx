import { useKeyboard } from "@opentui/react"
import { useCallback, useEffect, useState } from "react"
import type { AgentConfig } from "../core/config.ts"
import type { BrandPalette } from "./brand.ts"
import { changeSetting, settingsRows, settingsSnapshot } from "./settings.ts"

const tabs = ["Appearance", "Input", "Attention", "Agent"]
export function SettingsPanel({
  base,
  cwd,
  palette,
  onChange,
  onClose,
}: {
  base: AgentConfig
  cwd: string
  palette: BrandPalette
  onChange(config: AgentConfig): void
  onClose(): void
}) {
  const [snapshot, setSnapshot] = useState<{ config: AgentConfig; fingerprint: string }>(),
    [tab, setTab] = useState(0),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState(0),
    [message, setMessage] = useState("Loading…"),
    [editing, setEditing] = useState<{ key: string; text: string }>(),
    [busy, setBusy] = useState(false)
  const reload = useCallback(async () => {
    try {
      setSnapshot(await settingsSnapshot(base, cwd))
      setMessage("")
    } catch (error) {
      setMessage(String(error))
    }
  }, [base, cwd])
  useEffect(() => {
    void reload()
  }, [reload])
  const rows = snapshot
    ? settingsRows(snapshot.config).filter((row) =>
        !query
          ? row.tab === tabs[tab]
          : `${row.key} ${row.source}`.toLowerCase().includes(query.toLowerCase()),
      )
    : []
  const index = Math.min(selected, Math.max(0, rows.length - 1))
  const save = async (key: string, value: unknown) => {
    if (!snapshot || busy) return
    setBusy(true)
    try {
      const config = await changeSetting(base, cwd, key, value, snapshot.fingerprint)
      onChange(config)
      setEditing(undefined)
      setSnapshot(await settingsSnapshot(config, cwd))
      setMessage("Saved user preference; higher-precedence and managed settings still apply")
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }
  useKeyboard((key) => {
    if (key.defaultPrevented || busy) return
    if (key.name === "escape") {
      key.preventDefault()
      if (editing) setEditing(undefined)
      else onClose()
    } else if (key.name === "tab") {
      key.preventDefault()
      setTab((tab + (key.shift ? tabs.length - 1 : 1)) % tabs.length)
      setSelected(0)
      setQuery("")
    } else if (key.name === "up" || key.name === "down") {
      key.preventDefault()
      setSelected(Math.max(0, Math.min(rows.length - 1, index + (key.name === "up" ? -1 : 1))))
    } else if (key.ctrl && key.name === "r") {
      key.preventDefault()
      void reload()
    } else if (key.name === "return") {
      key.preventDefault()
      if (editing) {
        try {
          void save(editing.key, JSON.parse(editing.text))
        } catch {
          setMessage("Enter a JSON string, boolean or array")
        }
      } else {
        const row = rows[index]
        if (!row?.editable) {
          setMessage("Read-only here; use /permissions, /model or the existing integration controls")
          return
        }
        if (row.choices)
          void save(row.key, row.choices[(row.choices.indexOf(row.value) + 1) % row.choices.length])
        else setEditing({ key: row.key, text: JSON.stringify(row.value) })
      }
    }
  })
  return (
    <box
      style={{
        position: "absolute",
        left: "4%",
        top: 1,
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
        Settings · {tabs.map((name, i) => (i === tab ? `[${name}]` : name)).join("  ")} · Tab changes section
      </text>
      <input
        style={{ flexShrink: 0 }}
        focused
        value={editing?.text ?? query}
        onInput={(value) => {
          if (editing) setEditing({ ...editing, text: value })
          else {
            setQuery(value)
            setSelected(0)
          }
        }}
        placeholder={editing ? `JSON value for ${editing.key}` : "Search all settings"}
        textColor={palette.foreground}
        backgroundColor={palette.panel}
      />
      <scrollbox style={{ flexGrow: 1, minHeight: 1 }}>
        {rows.slice(Math.max(0, index - 4), Math.max(0, index - 4) + 10).map((row) => (
          <box key={row.key}>
            <text fg={row === rows[index] ? palette.accent : palette.foreground}>
              {row === rows[index] ? "›" : " "} {row.key} = {JSON.stringify(row.value).slice(0, 180)}
              {row.locked ? " [managed]" : row.editable ? "" : " [inspect]"}
            </text>
            <text style={{ flexShrink: 0 }} fg={palette.muted}>
              {" "}
              {row.source}
            </text>
          </box>
        ))}
      </scrollbox>
      <text style={{ flexShrink: 0 }} fg={palette.muted}>
        {message || "Enter changes selection · Ctrl+R reload · Esc closes · writes user source only"}
      </text>
    </box>
  )
}
