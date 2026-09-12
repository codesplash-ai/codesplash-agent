import { useKeyboard } from "@opentui/react"
import { useEffect, useRef, useState } from "react"
import type { TeamDashboard, TeamRequest } from "../core/orchestration/teams.ts"
import { safeSessionText } from "../core/session/repository.ts"
import type { SessionController } from "../core/session-controller.ts"
import type { BrandPalette } from "./brand.ts"

const unpack = (raw: unknown) => {
  const v = raw as { text: string; isError?: boolean }
  if (v.isError) throw new Error(v.text)
  return JSON.parse(v.text)
}
export function TeamPanel({
  controller,
  palette,
  onClose,
  onAction,
}: {
  controller: SessionController
  palette: BrandPalette
  onClose(): void
  onAction?(request: TeamRequest): Promise<void>
}) {
  const [view, setView] = useState<TeamDashboard>(),
    [selected, setSelected] = useState(0),
    [output, setOutput] = useState(""),
    [error, setError] = useState(""),
    [draft, setDraft] = useState<{ action: "reply" | "dispatch"; text: string }>()
  const draftRef = useRef<typeof draft>(undefined)
  const changeDraft = (value: typeof draft) => {
    draftRef.current = value
    setDraft(value)
  }
  const rows = view?.teams.flatMap((team) => team.members.map((member) => ({ team, member }))) ?? [],
    index = Math.min(selected, Math.max(0, rows.length - 1)),
    row = rows[index]
  useEffect(() => {
    let closed = false,
      busy = false
    const update = async () => {
      if (closed || busy) return
      busy = true
      try {
        const next = unpack(await controller.teams({ action: "list" })) as TeamDashboard
        const members = next.teams.flatMap((team) => team.members.map((member) => ({ team, member }))),
          current = members[Math.min(selected, Math.max(0, members.length - 1))]
        const peek = current
          ? (unpack(
              await controller.teams({ action: "peek", team: current.team.id, member: current.member.name }),
            ) as { output: string })
          : { output: "Create a team with /teams create JSON" }
        if (!closed) {
          setView(next)
          setOutput(peek.output)
        }
      } catch (e) {
        if (!closed) setError(String(e))
      } finally {
        busy = false
      }
    }
    void update()
    const timer = setInterval(() => {
      void update()
    }, 300)
    return () => {
      closed = true
      clearInterval(timer)
    }
  }, [controller, selected])
  const perform = (request: TeamRequest) => {
    setError("")
    void (onAction ? onAction(request) : controller.teams(request).then(unpack)).catch((e) =>
      setError(safeSessionText(String(e))),
    )
  }
  useKeyboard((key) => {
    const draft = draftRef.current
    if (key.ctrl && ["c", "q", "b"].includes(key.name)) return
    key.preventDefault()
    if (key.name === "escape") {
      if (draft) changeDraft(undefined)
      else onClose()
      return
    }
    if (draft) {
      if (["return", "enter"].includes(key.name) && row && draft.text.trim()) {
        perform(
          draft.action === "reply"
            ? { action: "reply", team: row.team.id, member: row.member.name, text: draft.text }
            : { action: "dispatch", team: row.team.id, member: row.member.name, prompt: draft.text },
        )
        changeDraft(undefined)
      } else if (key.name === "backspace")
        changeDraft({ ...draft, text: Array.from(draft.text).slice(0, -1).join("") })
      // biome-ignore lint/suspicious/noControlCharactersInRegex: accept text only
      else if (!key.ctrl && !key.meta && key.sequence && !/[\x00-\x1f\x7f]/.test(key.sequence))
        changeDraft({ ...draft, text: (draft.text + key.sequence).slice(0, 4096) })
      return
    }
    if (key.name === "up") setSelected(Math.max(0, index - 1))
    if (key.name === "down") setSelected(Math.min(rows.length - 1, index + 1))
    if (!row) return
    if (key.name === "r" || key.name === "d")
      changeDraft({ action: key.name === "r" ? "reply" : "dispatch", text: "" })
    if (key.name === "k") perform({ action: "interrupt", team: row.team.id, member: row.member.name })
  })
  return (
    <box
      style={{
        position: "absolute",
        top: 2,
        left: 3,
        right: 3,
        bottom: 2,
        backgroundColor: palette.background,
        border: true,
        padding: 1,
        flexDirection: "column",
      }}
    >
      <text fg={palette.accent}>
        <b>Teams dashboard {view?.coordinator ? "· coordinator mode" : ""}</b>
      </text>
      <text fg={palette.muted}>↑↓ peek · R reply (data only) · D dispatch · K interrupt · Esc close</text>
      <text fg={palette.muted}>
        Member tokens include descendants; root total:{" "}
        {(view?.usage.inputTokens ?? 0) +
          (view?.usage.outputTokens ?? 0) +
          (view?.usage.embeddingInputTokens ?? 0)}
      </text>
      {view?.panes.socket && <text fg={palette.muted}>Attach panes: tmux -S {view.panes.socket} attach</text>}
      <scrollbox style={{ height: "40%" }}>
        {rows.map(({ team, member }, i) => (
          <text key={`${team.id}/${member.name}`} fg={i === index ? palette.accent : palette.foreground}>
            {i === index ? "› " : "  "}
            {team.name}/{member.name} · {member.task?.status ?? "idle"} · {member.role} ·{" "}
            {(member.peer?.usage?.inputTokens ?? 0) +
              (member.peer?.usage?.outputTokens ?? 0) +
              (member.peer?.usage?.embeddingInputTokens ?? 0)}{" "}
            tokens · parent {member.peer?.parent.slice(0, 8) ?? "root"}
          </text>
        ))}
      </scrollbox>
      {draft && (
        <text fg={palette.accent}>
          {draft.action === "reply" ? "Reply data" : "Dispatch prompt"}: {draft.text}▏
        </text>
      )}
      {error && <text fg={palette.destructive}>{error}</text>}
      <scrollbox style={{ flexGrow: 1 }}>
        <text fg={palette.foreground}>{output}</text>
      </scrollbox>
    </box>
  )
}
