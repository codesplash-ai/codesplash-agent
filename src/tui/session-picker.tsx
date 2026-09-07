import { createCliRenderer, type ThemeMode } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer } from "@opentui/react"
import { useEffect, useState } from "react"
import type { SessionMeta, SessionStatus, ThemePreference } from "../core/index.ts"
import { registerCleanup } from "../core/index.ts"
import { control } from "../core/session/control.ts"
import { SessionRepository, safeSessionText } from "../core/session/repository.ts"
import { CODESPLASH_CAPABILITIES } from "../engines/codesplash/index.ts"
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
  if (meta.sandbox) return meta.sandbox
  return meta.engine === "claude" ? "official CLI" : ""
}

/**
 * Pickers are engine-scoped, so a native session ID is the main resume requirement for engines
 * with a provider thread. CodeSplash resumes from the transcript persisted in the session store
 * (nativeSessionId is just the local id and proves nothing), so its rows follow the engine
 * capability alone.
 */
export function isResumableSession(meta: SessionMeta): boolean {
  if (meta.engine === "codesplash") return CODESPLASH_CAPABILITIES.resume
  return Boolean(meta.nativeSessionId)
}

type SessionPickerAppProps = {
  sessions: SessionMeta[]
  palette: BrandPalette
  repository?: SessionRepository
  onAction(action: SessionPickerAction): void
}

export function SessionPickerApp({
  sessions,
  palette,
  onAction,
  repository: suppliedRepository,
}: SessionPickerAppProps) {
  const renderer = useRenderer()
  const [selected, setSelected] = useState(0)
  const [repository] = useState(() => suppliedRepository ?? new SessionRepository())
  const [rows, setRows] = useState(sessions.filter((meta) => !meta.archived))
  const [archived, setArchived] = useState(false)
  const [query, setQuery] = useState("")
  const [offset, setOffset] = useState(0)
  const [input, setInput] = useState("")
  const [mode, setMode] = useState<"search" | "rename" | "delete" | undefined>()
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [target, setTarget] = useState<{ meta: SessionMeta; revision: string }>()
  const rowCount = rows.length + 1
  useEffect(() => {
    if (!query && !archived && refresh === 0 && offset === 0) return
    let current = true
    repository
      .list({
        project: sessions[0]?.projectId,
        engine: sessions[0]?.engine,
        archived,
        query,
        limit: 30,
        offset,
      })
      .then((page) => {
        if (current) {
          setRows(page.sessions)
          setSelected(0)
          setMessage(
            [`${page.total} sessions · page ${Math.floor(offset / 30) + 1}`, ...page.warnings].join(" · "),
          )
        }
      })
      .catch((error) => {
        if (current) setMessage(safeSessionText(String(error)))
      })
    return () => {
      current = false
    }
  }, [repository, sessions, archived, query, refresh, offset])
  const perform = (operation: () => Promise<unknown>) => {
    setBusy(true)
    void operation()
      .then(() => {
        setRefresh((n) => n + 1)
        setMode(undefined)
        setInput("")
      })
      .catch((error) => setMessage(safeSessionText(String(error))))
      .finally(() => setBusy(false))
  }

  useEffect(() => {
    renderer.setBackgroundColor(palette.background)
  }, [palette.background, renderer])

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      onAction({ type: "back" })
      return
    }
    if (busy) {
      key.preventDefault()
      return
    }
    if (mode) {
      key.preventDefault()
      if (key.name === "escape") {
        setMode(undefined)
        setInput("")
        return
      }
      if (key.name === "return" || key.name === "enter") {
        if (mode === "search") {
          setOffset(0)
          setQuery(input)
          setMode(undefined)
          setRefresh((n) => n + 1)
        } else if (target && mode === "rename")
          perform(() => repository.rename(target.meta, input, target.revision))
        else if (target && mode === "delete" && input === "delete")
          perform(() => repository.maintenance(target.meta, "delete", target.revision))
        return
      }
      if (key.name === "backspace") setInput((value) => Array.from(value).slice(0, -1).join(""))
      // biome-ignore lint/suspicious/noControlCharactersInRegex: reject terminal control sequences
      else if (!key.ctrl && !key.meta && key.sequence && !/[\x00-\x1f\x7f]/.test(key.sequence))
        setInput((value) => (value + key.sequence).slice(0, 1000))
      return
    }
    if (key.name === "pagedown" || key.name === "pageup") {
      key.preventDefault()
      setOffset((value) => Math.max(0, value + (key.name === "pagedown" ? 30 : -30)))
      setRefresh((n) => n + 1)
      return
    }
    if (key.name === "/") {
      key.preventDefault()
      setMode("search")
      setInput(query)
      return
    }
    if (key.name === "a") {
      key.preventDefault()
      setOffset(0)
      setArchived((value) => !value)
      setRefresh((n) => n + 1)
      return
    }
    if (["r", "d", "h"].includes(key.name)) {
      const meta = rows[selected - 1]
      if (!meta) return
      key.preventDefault()
      try {
        const revision = control(repository.path(meta)).revision
        setTarget({ meta, revision })
        setInput("")
        if (key.name === "h") perform(() => repository.archive(meta, !meta.archived, revision))
        else {
          setMode(key.name === "r" ? "rename" : "delete")
          setMessage(
            key.name === "d"
              ? "Delete local history? Provider threads and repository memories remain. Type delete and press Enter."
              : "Enter a new title.",
          )
        }
      } catch (error) {
        setMessage(safeSessionText(String(error)))
      }
      return
    }
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
      const meta = rows[selected - 1]
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
          {rows.map((meta, index) => (
            <PickerRow
              key={meta.localSessionId}
              label={safeSessionText(meta.title ?? "Untitled session")}
              detail={[formatRelativeTime(meta.updatedAt), displaySessionStatus(meta), sandboxBadge(meta)]
                .filter(Boolean)
                .join(" · ")}
              danger={meta.sandbox === "danger-full-access"}
              palette={palette}
              selected={selected === index + 1}
              enabled={isResumableSession(meta)}
            />
          ))}
        </box>
        {mode ? (
          <text fg={palette.accent}>
            {mode}: {input}▏
          </text>
        ) : null}
        {query || archived ? (
          <text fg={palette.muted}>
            {archived ? "Archived" : "Active"} · {query || "All titles"}
          </text>
        ) : null}
        {message ? <text fg={palette.muted}>{message}</text> : null}
        <text fg={palette.muted} style={{ marginTop: 1 }}>
          Enter resume · PgUp/PgDn pages · / search · a archived · r rename · h archive/unarchive · d delete ·
          Esc back
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
