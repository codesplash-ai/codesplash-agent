import { createCliRenderer, type ThemeMode } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer } from "@opentui/react"
import { useEffect, useState } from "react"
import type { SessionMeta, SessionStatus, ThemePreference } from "../core/index.ts"
import { registerCleanup } from "../core/index.ts"
import { type BrandPalette, brandThemes } from "./brand.ts"

export type SessionPickerAction = { type: "new" } | { type: "resume"; meta: SessionMeta } | { type: "back" }

/** A session that never reached "closed" was cut short (crash, kill, power loss). */
export function displaySessionStatus(meta: SessionMeta): string {
  const interrupted: SessionStatus[] = ["starting", "ready", "running", "waiting"]
  if (interrupted.includes(meta.lastStatus)) return "interrupted"
  return meta.lastStatus
}

export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return "unknown"
  const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(then).toISOString().slice(0, 10)
}

export function sandboxBadge(meta: SessionMeta): string {
  if (meta.sandbox === "danger-full-access") return "FULL ACCESS"
  return meta.sandbox
}

export function isResumableSession(meta: SessionMeta): boolean {
  return meta.engine === "codex" && Boolean(meta.nativeSessionId)
}

type SessionPickerAppProps = {
  sessions: SessionMeta[]
  palette: BrandPalette
  onAction(action: SessionPickerAction): void
}

export function SessionPickerApp({ sessions, palette, onAction }: SessionPickerAppProps) {
  const renderer = useRenderer()
  const [selected, setSelected] = useState(0)
  const rowCount = sessions.length + 1

  useEffect(() => {
    renderer.setBackgroundColor(palette.background)
  }, [palette.background, renderer])

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      onAction({ type: "back" })
      return
    }
    if (key.name === "escape" || key.name === "q") {
      key.preventDefault()
      onAction({ type: "back" })
      return
    }
    if (key.name === "up") {
      key.preventDefault()
      setSelected((current) => Math.max(0, current - 1))
      return
    }
    if (key.name === "down") {
      key.preventDefault()
      setSelected((current) => Math.min(rowCount - 1, current + 1))
      return
    }
    if (key.name === "return" || key.name === "enter") {
      key.preventDefault()
      if (selected === 0) {
        onAction({ type: "new" })
        return
      }
      const meta = sessions[selected - 1]
      if (meta && isResumableSession(meta)) onAction({ type: "resume", meta })
    }
  })

  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: palette.background,
        padding: 1,
      }}
    >
      <box style={{ width: "94%", maxWidth: 112 }}>
        <text fg={palette.accent}>
          <b>SESSIONS IN THIS PROJECT</b>
        </text>
        <box
          style={{
            width: "100%",
            marginTop: 1,
            backgroundColor: palette.panel,
            paddingLeft: 1,
            paddingRight: 1,
          }}
        >
          <PickerRow
            label="Start new session"
            detail=""
            palette={palette}
            selected={selected === 0}
            enabled
          />
          {sessions.map((meta, index) => (
            <PickerRow
              key={meta.localSessionId}
              label={meta.title ?? "Untitled session"}
              detail={[
                formatRelativeTime(meta.updatedAt),
                displaySessionStatus(meta),
                sandboxBadge(meta),
              ].join(" · ")}
              danger={meta.sandbox === "danger-full-access"}
              palette={palette}
              selected={selected === index + 1}
              enabled={isResumableSession(meta)}
            />
          ))}
        </box>
        <text fg={palette.muted} style={{ marginTop: 1 }}>
          Enter resume · Esc back
        </text>
      </box>
    </box>
  )
}

function PickerRow({
  label,
  detail,
  palette,
  selected,
  enabled,
  danger = false,
}: {
  label: string
  detail: string
  palette: BrandPalette
  selected: boolean
  enabled: boolean
  danger?: boolean
}) {
  const labelColor = enabled ? (selected ? palette.action : palette.foreground) : palette.muted
  return (
    <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between" }}>
      <text fg={labelColor}>
        {selected ? "› " : "  "}
        {label}
      </text>
      {detail ? <text fg={danger ? palette.destructive : palette.muted}>{detail}</text> : null}
    </box>
  )
}

export async function renderSessionPicker(
  sessions: SessionMeta[],
  themePreference: ThemePreference,
): Promise<SessionPickerAction> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 60,
    useKittyKeyboard: { disambiguate: true, alternateKeys: true },
  })
  const detectedTheme: ThemeMode = (await renderer.waitForThemeMode(300)) ?? "dark"
  const theme = themePreference === "system" ? detectedTheme : themePreference
  const unregisterRenderer = registerCleanup(() => renderer.destroy())

  return new Promise((resolve) => {
    let settled = false
    const finish = (action: SessionPickerAction) => {
      if (settled) return
      settled = true
      unregisterRenderer()
      renderer.destroy()
      resolve(action)
    }

    createRoot(renderer).render(
      <SessionPickerApp sessions={sessions} palette={brandThemes[theme]} onAction={finish} />,
    )
  })
}
