import { RGBA, SyntaxStyle, type TextareaRenderable } from "@opentui/core"
import { useKeyboard, useRenderer } from "@opentui/react"
import { useEffect, useMemo, useReducer, useRef, useState } from "react"
import {
  type AppViewState,
  createAgentEvent,
  initialAppViewState,
  reduceAgentEvent,
  type TranscriptItem,
} from "../core/index.ts"
import { fixtureEvents } from "./fixture-events.ts"

const palette = {
  background: "#17151F",
  panel: "#211D2B",
  border: "#5A4D73",
  text: "#F8F8F2",
  muted: "#A39DAE",
  accent: "#BD93F9",
  cyan: "#8BE9FD",
  green: "#50FA7B",
  yellow: "#F1FA8C",
  red: "#FF5555",
}

function createSyntaxStyle(): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    keyword: { fg: RGBA.fromHex("#FF79C6"), bold: true },
    string: { fg: RGBA.fromHex("#F1FA8C") },
    comment: { fg: RGBA.fromHex("#6272A4"), italic: true },
    number: { fg: RGBA.fromHex("#BD93F9") },
    default: { fg: RGBA.fromHex(palette.text) },
  })
}

function TranscriptEntry({ item, syntaxStyle }: { item: TranscriptItem; syntaxStyle: SyntaxStyle }) {
  if (item.kind === "diff") {
    return (
      <box title={item.label ?? "Diff"} style={{ border: true, borderColor: palette.border, height: 10 }}>
        <diff
          diff={item.text}
          view="unified"
          filetype="typescript"
          syntaxStyle={syntaxStyle}
          showLineNumbers
          wrapMode="word"
          style={{ height: "100%", width: "100%" }}
        />
      </box>
    )
  }

  if (item.kind === "tool") {
    return (
      <box style={{ flexDirection: "row", gap: 1 }}>
        <text fg={item.status === "failed" ? palette.red : palette.green}>●</text>
        <text fg={palette.cyan}>{item.label ?? "Tool"}</text>
        <text fg={palette.muted}>{item.text}</text>
      </box>
    )
  }

  return (
    <box
      title={item.kind === "reasoning" ? "Reasoning" : "Agent"}
      style={{
        border: true,
        borderColor: item.kind === "reasoning" ? palette.border : palette.accent,
        padding: 1,
      }}
    >
      <markdown content={item.text} syntaxStyle={syntaxStyle} streaming={item.status === "running"} />
    </box>
  )
}

function Approval({ state }: { state: AppViewState }) {
  const request = state.pendingRequest
  if (!request) return null

  return (
    <box
      title={request.title}
      style={{
        position: "absolute",
        width: "70%",
        height: 8,
        left: "15%",
        top: "35%",
        zIndex: 20,
        border: true,
        borderStyle: "double",
        borderColor: palette.yellow,
        backgroundColor: palette.panel,
        padding: 1,
      }}
    >
      <text fg={palette.text}>{request.detail}</text>
      <text fg={palette.muted}>A accept · D decline</text>
    </box>
  )
}

export function FixtureApp() {
  const renderer = useRenderer()
  const textareaRef = useRef<TextareaRenderable>(null)
  const [state, dispatch] = useReducer(reduceAgentEvent, initialAppViewState)
  const [submitted, setSubmitted] = useState("")
  const [decision, setDecision] = useState("")
  const fixtureSequence = useRef(fixtureEvents.length)
  const syntaxStyle = useMemo(createSyntaxStyle, [])

  useEffect(() => {
    renderer.setBackgroundColor(palette.background)
    const timers = fixtureEvents.map((event, index) => setTimeout(() => dispatch(event), index * 90))
    return () => {
      for (const timer of timers) clearTimeout(timer)
    }
  }, [renderer])

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      renderer.destroy()
      return
    }

    if (state.pendingRequest && (key.name === "a" || key.name === "d")) {
      key.preventDefault()
      const choice = key.name === "a" ? "accept" : "decline"
      dispatch(
        createFixtureEvent(fixtureSequence.current++, {
          kind: "request.resolved",
          payload: { id: state.pendingRequest.id, decision: choice },
        }),
      )
      setDecision(choice)
      return
    }

    if (!state.pendingRequest && key.ctrl && key.name === "r") {
      key.preventDefault()
      dispatch(
        createFixtureEvent(fixtureSequence.current++, {
          kind: "request.opened",
          payload: {
            id: `approval-${fixtureSequence.current}`,
            requestKind: "approval",
            title: "Run command?",
            detail: "bun test",
            choices: ["accept", "decline"],
          },
        }),
      )
      setDecision("")
      return
    }

    if (key.name === "escape") {
      renderer.destroy()
    }
  })

  const usage = [
    state.usage.inputTokens === undefined ? undefined : `in ${state.usage.inputTokens}`,
    state.usage.outputTokens === undefined ? undefined : `out ${state.usage.outputTokens}`,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <box style={{ height: "100%", backgroundColor: palette.background, padding: 1, gap: 1 }}>
      <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between" }}>
        <text fg={palette.accent}>CodeSplash Agent</text>
        <text fg={palette.muted}>fixture · {state.sessionStatus}</text>
      </box>

      <scrollbox
        style={{
          flexGrow: 1,
          border: true,
          borderColor: palette.border,
          backgroundColor: palette.panel,
          padding: 1,
        }}
      >
        {state.transcript.map((item) => (
          <TranscriptEntry key={item.id} item={item} syntaxStyle={syntaxStyle} />
        ))}
      </scrollbox>

      <box title="Message" style={{ height: 5, border: true, borderColor: palette.accent }}>
        <textarea
          ref={textareaRef}
          focused
          placeholder="Ask the agent…"
          onSubmit={() => {
            setSubmitted(textareaRef.current?.plainText ?? "")
            textareaRef.current?.setText("")
          }}
        />
      </box>

      <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between" }}>
        <text fg={palette.muted}>
          Esc quit · Enter submit · Ctrl+R replay approval
          {decision ? ` · ${decision}` : submitted ? ` · sent: ${submitted}` : ""}
        </text>
        <text fg={palette.cyan}>codex · workspace-write · {usage}</text>
      </box>

      <Approval state={state} />
    </box>
  )
}

function createFixtureEvent(sequence: number, event: Parameters<typeof createAgentEvent>[1]) {
  return createAgentEvent({ engine: "codex", localSessionId: "fixture-session", sequence }, event)
}
