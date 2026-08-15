import {
  bg,
  type CursorStyleOptions,
  fg,
  RGBA,
  type ScrollBoxOptions,
  type ScrollBoxRenderable,
  StyledText,
  SyntaxStyle,
  type TextareaOptions,
  type TextareaRenderable,
} from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type {
  AppViewState,
  PendingRequest,
  ProjectPreflight,
  SessionController,
  TranscriptItem,
} from "../core/index.ts"
import type { BrandPalette } from "./brand.ts"

export type CodexSessionAction = "home" | "reconnect"

/** The leading cell is reserved for OpenTUI's cursor while the empty composer is focused. */
export const composerPlaceholder = " Ask the agent… Enter sends; Shift+Enter adds a line"

export const composerKeyBindings = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "linefeed", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "kpenter", shift: true, action: "newline" },
  { name: "linefeed", shift: true, action: "newline" },
  { name: "j", ctrl: true, action: "newline" },
] satisfies NonNullable<TextareaOptions["keyBindings"]>

export const composerCursorStyle = {
  style: "block",
  blinking: false,
} satisfies CursorStyleOptions

const composerCursorBlinkMs = 530

type LatestScrollable = Pick<ScrollBoxRenderable, "scrollTo" | "stickyScroll" | "stickyStart">
type SectionScrollable = Pick<ScrollBoxRenderable, "scrollChildIntoView" | "stickyScroll">

export type TranscriptOutlineItem = {
  id: string
  anchorId: string
  label: string
  kind: TranscriptItem["kind"]
  status: TranscriptItem["status"]
}

export function scrollToLatest(scrollbox: LatestScrollable): void {
  scrollbox.stickyScroll = true
  scrollbox.stickyStart = "bottom"
  scrollbox.scrollTo({ x: 0, y: Number.MAX_SAFE_INTEGER })
}

export function transcriptAnchorId(itemId: string): string {
  return `transcript:${itemId}`
}

export function buildTranscriptOutline(transcript: TranscriptItem[]): TranscriptOutlineItem[] {
  const outline: TranscriptOutlineItem[] = []
  const groupedSections = new Map<"reasoning" | "tool", TranscriptOutlineItem>()

  for (const item of transcript) {
    if (item.kind === "user" || item.kind === "message") groupedSections.clear()

    if (item.kind === "reasoning" || item.kind === "tool") {
      const existing = groupedSections.get(item.kind)
      if (existing) {
        existing.status = groupedStatus(existing.status, item.status)
        continue
      }
    }

    const section: TranscriptOutlineItem = {
      id: item.id,
      anchorId: transcriptAnchorId(item.id),
      label: outlineLabel(item),
      kind: item.kind,
      status: item.status,
    }
    outline.push(section)

    if (item.kind === "reasoning" || item.kind === "tool") {
      groupedSections.set(item.kind, section)
    }
  }

  return outline
}

export function createScrollbarOptions(
  palette: BrandPalette,
): NonNullable<ScrollBoxOptions["verticalScrollbarOptions"]> {
  return {
    showArrows: false,
    trackOptions: {
      backgroundColor: palette.background,
      foregroundColor: palette.accent,
    },
  }
}

export function scrollToTranscriptSection(scrollbox: SectionScrollable, anchorId: string): void {
  scrollbox.stickyScroll = false
  scrollbox.scrollChildIntoView(anchorId)
}

export function createComposerPlaceholder(palette: BrandPalette): StyledText {
  return new StyledText([fg(palette.muted)(bg(palette.secondary)(composerPlaceholder))])
}

type CodexSessionAppProps = {
  controller: SessionController
  palette: BrandPalette
  project: ProjectPreflight
  onAction(action: CodexSessionAction): void
}

export function CodexSessionApp({ controller, palette, project, onAction }: CodexSessionAppProps) {
  const renderer = useRenderer()
  const { width: terminalWidth } = useTerminalDimensions()
  const textareaRef = useRef<TextareaRenderable>(null)
  const resetCursorBlinkRef = useRef<() => void>(() => {})
  const scrollboxRef = useRef<ScrollBoxRenderable>(null)
  const [state, setState] = useState(controller.state)
  const [commandError, setCommandError] = useState<string>()
  const [selectedOutlineId, setSelectedOutlineId] = useState<string>()
  const [outlineVisible, setOutlineVisible] = useState(true)
  const syntaxStyle = useMemo(() => createSyntaxStyle(palette), [palette])
  const styledComposerPlaceholder = useMemo(() => createComposerPlaceholder(palette), [palette])
  const scrollbarOptions = useMemo(() => createScrollbarOptions(palette), [palette])
  const outline = useMemo(() => buildTranscriptOutline(state.transcript), [state.transcript])
  const activeOutlineId = selectedOutlineId ?? outline.at(-1)?.id
  const showOutline = outlineVisible && terminalWidth >= 96 && outline.length > 0

  useEffect(() => {
    renderer.setBackgroundColor(palette.background)
  }, [palette.background, renderer])

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined

    const setCursorVisible = (visible: boolean) => {
      if (textareaRef.current) textareaRef.current.showCursor = visible
    }
    const showCursor = () => {
      setCursorVisible(true)
      timeout = setTimeout(hideCursor, composerCursorBlinkMs)
    }
    const hideCursor = () => {
      setCursorVisible(false)
      timeout = setTimeout(showCursor, composerCursorBlinkMs)
    }
    const resetCursorBlink = () => {
      if (timeout) clearTimeout(timeout)
      showCursor()
    }

    resetCursorBlinkRef.current = resetCursorBlink
    resetCursorBlink()
    return () => {
      if (timeout) clearTimeout(timeout)
      setCursorVisible(true)
      resetCursorBlinkRef.current = () => {}
    }
  }, [])

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState)
    controller.start()
    return unsubscribe
  }, [controller])

  const runCommand = useCallback(async (command: () => Promise<void>): Promise<boolean> => {
    setCommandError(undefined)
    try {
      await command()
      return true
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
      return false
    }
  }, [])

  const resolveRequest = useCallback(
    (choice: string) => {
      const request = state.pendingRequest
      if (!request || !request.choices.includes(choice)) return
      void runCommand(() => controller.resolveRequest(request.id, { choice }))
    },
    [controller, runCommand, state.pendingRequest],
  )

  const jumpToLatest = useCallback(() => {
    if (scrollboxRef.current) scrollToLatest(scrollboxRef.current)
    setSelectedOutlineId(undefined)
    textareaRef.current?.focus()
  }, [])

  const jumpToSection = useCallback((section: TranscriptOutlineItem) => {
    if (scrollboxRef.current) scrollToTranscriptSection(scrollboxRef.current, section.anchorId)
    setSelectedOutlineId(section.id)
  }, [])

  const moveBetweenSections = useCallback(
    (direction: -1 | 1) => {
      if (outline.length === 0) return
      const currentIndex = outline.findIndex((section) => section.id === activeOutlineId)
      const nextIndex = Math.max(0, Math.min(outline.length - 1, currentIndex + direction))
      const section = outline[nextIndex]
      if (section) jumpToSection(section)
    },
    [activeOutlineId, jumpToSection, outline],
  )

  const toggleOutline = useCallback(() => {
    setOutlineVisible((visible) => !visible)
  }, [])

  useKeyboard((key) => {
    if (key.ctrl && (key.name === "c" || key.name === "q")) {
      key.preventDefault()
      onAction("home")
      return
    }

    if (key.ctrl && key.name === "l") {
      key.preventDefault()
      jumpToLatest()
      return
    }

    if (key.ctrl && key.name === "o") {
      key.preventDefault()
      toggleOutline()
      return
    }

    if ((key.option || key.meta) && (key.name === "up" || key.name === "down")) {
      key.preventDefault()
      moveBetweenSections(key.name === "up" ? -1 : 1)
      return
    }

    if (state.pendingRequest) {
      const choice = approvalChoiceForKey(key.name, state.pendingRequest)
      if (choice) {
        key.preventDefault()
        resolveRequest(choice)
      }
      return
    }

    if (key.name === "escape" && state.turnStatus === "running") {
      key.preventDefault()
      void runCommand(() => controller.interrupt())
      return
    }

    if (key.ctrl && key.name === "r" && state.error?.recoverable) {
      key.preventDefault()
      onAction("reconnect")
    }
  })

  const context = formatContextRemaining(state)
  const git = formatGit(project)
  const error = commandError ?? state.error?.message ?? state.warnings.at(-1)

  return (
    <box style={{ height: "100%", backgroundColor: palette.background, padding: 1, gap: 1 }}>
      <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between" }}>
        <text fg={palette.accent}>
          <b>CodeSplash Agent</b>
        </text>
        <box style={{ height: 1, flexDirection: "row", gap: 2 }}>
          <text fg={palette.muted}>
            {project.name} · {git}
          </text>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI has no button primitive; keyboard access is Ctrl+O. */}
          <text fg={outlineVisible ? palette.accent : palette.muted} onMouseDown={toggleOutline}>
            Outline {outlineVisible ? "on" : "off"} · Ctrl+O
          </text>
        </box>
      </box>

      <box style={{ flexGrow: 1, minHeight: 0, width: "100%", flexDirection: "row" }}>
        <scrollbox
          ref={scrollboxRef}
          stickyScroll
          stickyStart="bottom"
          verticalScrollbarOptions={scrollbarOptions}
          style={{
            flexGrow: 1,
            backgroundColor: palette.background,
            paddingLeft: 1,
            paddingRight: 1,
          }}
        >
          {state.transcript.length === 0 ? (
            <box style={{ height: "100%", alignItems: "center", justifyContent: "center" }}>
              <text fg={palette.muted}>Ask Codex to inspect, explain, or change this project.</text>
            </box>
          ) : (
            state.transcript.map((item) => (
              <TranscriptEntry key={item.id} item={item} palette={palette} syntaxStyle={syntaxStyle} />
            ))
          )}
        </scrollbox>

        {showOutline ? (
          <ConversationOutline
            outline={outline}
            activeId={activeOutlineId}
            palette={palette}
            scrollbarOptions={scrollbarOptions}
            onSelect={jumpToSection}
          />
        ) : null}
      </box>

      <box style={{ height: 1, width: "100%", flexDirection: "row", justifyContent: "flex-end" }}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI has no button primitive; keyboard access is Ctrl+L. */}
        <text fg={palette.accent} onMouseDown={jumpToLatest}>
          <b>↓ Latest</b> · Ctrl+L
        </text>
      </box>

      {state.plan.length > 0 ? (
        <box
          title="Plan"
          style={{ width: "100%", border: true, borderColor: palette.border, paddingLeft: 1 }}
        >
          {state.plan.map((step, index) => (
            <text key={`${index}:${step.text}`} fg={step.completed ? palette.muted : palette.foreground}>
              {step.completed ? "✓" : "·"} {step.text}
            </text>
          ))}
        </box>
      ) : null}

      <box
        style={{
          width: "100%",
          height: 5,
          flexDirection: "row",
          backgroundColor: palette.secondary,
          paddingTop: 1,
          paddingLeft: 1,
          paddingRight: 1,
        }}
      >
        <text fg={palette.accent} style={{ width: 2 }}>
          <b>{">"}</b>
        </text>
        <textarea
          ref={textareaRef}
          focused={!state.pendingRequest && !state.error?.recoverable}
          placeholder={styledComposerPlaceholder}
          textColor={palette.foreground}
          placeholderColor={palette.muted}
          cursorColor={palette.accent}
          cursorStyle={composerCursorStyle}
          backgroundColor={palette.secondary}
          focusedBackgroundColor={palette.secondary}
          keyBindings={composerKeyBindings}
          style={{ flexGrow: 1, height: "100%" }}
          onContentChange={() => resetCursorBlinkRef.current()}
          onCursorChange={() => resetCursorBlinkRef.current()}
          onSubmit={() => {
            const text = textareaRef.current?.plainText.trim() ?? ""
            if (!text) return
            void runCommand(() => controller.send({ text })).then((sent) => {
              if (sent) textareaRef.current?.setText("")
            })
          }}
        />
      </box>

      <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between" }}>
        <text fg={error ? palette.destructive : palette.muted}>{error ?? statusHelp(state)}</text>
        <text fg={palette.accent}>
          codex{state.model ? `/${state.model}` : ""}
          {context ? ` · ${context}` : ""} · workspace-write · {state.sessionStatus}
        </text>
      </box>

      <Approval request={state.pendingRequest} palette={palette} />
    </box>
  )
}

function TranscriptEntry({
  item,
  palette,
  syntaxStyle,
}: {
  item: TranscriptItem
  palette: BrandPalette
  syntaxStyle: SyntaxStyle
}) {
  const anchorId = transcriptAnchorId(item.id)

  if (item.kind === "diff") {
    return (
      <box
        id={anchorId}
        title={item.label ?? "Working diff"}
        style={{ width: "100%", border: true, borderColor: palette.border, height: 10 }}
      >
        <diff
          diff={item.text}
          view="unified"
          filetype={fileTypeForPath(item.label)}
          syntaxStyle={syntaxStyle}
          showLineNumbers
          wrapMode="word"
          style={{ height: "100%", width: "100%" }}
        />
      </box>
    )
  }

  if (item.kind === "tool") {
    return <ToolEntry item={item} palette={palette} id={anchorId} />
  }

  if (item.kind === "user") {
    return (
      <box
        id={anchorId}
        style={{
          width: "100%",
          marginBottom: 1,
          backgroundColor: palette.secondary,
          paddingLeft: 1,
          paddingRight: 1,
        }}
      >
        <text style={{ width: "100%" }}>
          <span fg={palette.accent}>
            <b>{"> "}</b>
          </span>
          <span fg={palette.foreground}>{item.text}</span>
        </text>
      </box>
    )
  }

  const hasText = item.text.trim().length > 0
  const title = item.kind === "reasoning" ? `Codex thinking${hasText ? "" : "…"}` : "Codex"
  return (
    <box id={anchorId} style={{ width: "100%", marginBottom: 1 }}>
      <text fg={item.kind === "reasoning" ? palette.muted : palette.foreground}>
        <b>{title}</b>
      </text>
      {hasText ? (
        item.status === "running" ? (
          <text fg={item.kind === "reasoning" ? palette.muted : palette.foreground} style={{ width: "100%" }}>
            {item.text}
          </text>
        ) : (
          <markdown
            content={item.text}
            syntaxStyle={syntaxStyle}
            streaming={false}
            style={{ width: "100%" }}
          />
        )
      ) : null}
    </box>
  )
}

export function ToolEntry({
  item,
  palette,
  id,
}: {
  item: TranscriptItem
  palette: BrandPalette
  id?: string
}) {
  const indicator = item.status === "running" ? "◌" : item.status === "failed" ? "×" : "✓"
  return (
    <box
      id={id}
      style={{
        width: "100%",
        marginBottom: 1,
      }}
    >
      <text fg={item.status === "failed" ? palette.destructive : palette.foreground}>
        <b>
          {indicator} {item.label ?? "Tool"}
        </b>
      </text>
      {item.text ? (
        <text fg={item.status === "failed" ? palette.destructive : palette.muted} style={{ width: "100%" }}>
          {item.text}
        </text>
      ) : (
        <text fg={palette.muted}>{item.status === "running" ? "Running…" : "Completed"}</text>
      )}
    </box>
  )
}

function ConversationOutline({
  outline,
  activeId,
  palette,
  scrollbarOptions,
  onSelect,
}: {
  outline: TranscriptOutlineItem[]
  activeId?: string
  palette: BrandPalette
  scrollbarOptions: NonNullable<ScrollBoxOptions["verticalScrollbarOptions"]>
  onSelect(section: TranscriptOutlineItem): void
}) {
  const outlineScrollRef = useRef<ScrollBoxRenderable>(null)

  useEffect(() => {
    if (activeId) outlineScrollRef.current?.scrollChildIntoView(`outline:${activeId}`)
  }, [activeId])

  return (
    <box
      style={{
        width: 16,
        minWidth: 16,
        height: "100%",
        backgroundColor: palette.background,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <text fg={palette.foreground}>
        <b>Outline</b>
      </text>
      <text fg={palette.muted}>⌥↑/↓ jump</text>
      <scrollbox
        ref={outlineScrollRef}
        verticalScrollbarOptions={scrollbarOptions}
        style={{
          flexGrow: 1,
          width: "100%",
          marginTop: 1,
          backgroundColor: palette.background,
        }}
      >
        {outline.map((section) => {
          const active = section.id === activeId
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI has no button primitive; keyboard access is Option+Up/Down.
            <text
              id={`outline:${section.id}`}
              key={section.id}
              fg={active ? "#FFFFFF" : palette.muted}
              bg={active ? palette.accent : palette.background}
              style={{ width: "100%" }}
              onMouseDown={() => onSelect(section)}
            >
              {outlineMarker(section)} {section.label}
            </text>
          )
        })}
      </scrollbox>
    </box>
  )
}

function Approval({ request, palette }: { request?: PendingRequest; palette: BrandPalette }) {
  if (!request) return null

  return (
    <box
      title={request.title}
      style={{
        position: "absolute",
        width: "76%",
        minHeight: 9,
        left: "12%",
        top: "32%",
        zIndex: 20,
        border: true,
        borderStyle: "double",
        borderColor: palette.action,
        backgroundColor: palette.popover,
        padding: 1,
      }}
    >
      <text fg={palette.foreground}>{request.detail}</text>
      <text fg={palette.action}>A Accept · S Session · D Decline · C Cancel</text>
    </box>
  )
}

function approvalChoiceForKey(name: string, request: PendingRequest): string | undefined {
  const requested =
    name === "a"
      ? "accept"
      : name === "s"
        ? "acceptForSession"
        : name === "d"
          ? "decline"
          : name === "c" || name === "escape"
            ? "cancel"
            : undefined
  return requested && request.choices.includes(requested) ? requested : undefined
}

function statusHelp(state: AppViewState): string {
  if (state.error?.recoverable) return "Ctrl+R reconnect · Ctrl+Q home"
  if (state.turnStatus === "running") return "Esc interrupt · Ctrl+Q home"
  return "Enter send · Shift+Enter newline · Ctrl+Q home"
}

export function formatContextRemaining(state: AppViewState): string | undefined {
  const total =
    state.usage.contextTokens ??
    (state.usage.inputTokens === undefined
      ? undefined
      : state.usage.inputTokens + (state.usage.outputTokens ?? 0))
  const window = state.usage.modelContextWindow
  if (total === undefined || window === undefined || window <= 0) return undefined

  const remaining = Math.max(0, window - total)
  const percent = Math.max(0, Math.min(100, Math.round((remaining / window) * 100)))
  return `${percent}% context left`
}

function outlineLabel(item: TranscriptItem): string {
  if (item.kind === "user") return "Prompt"
  if (item.kind === "message") return "Response"
  if (item.kind === "reasoning") return "Thinking"
  if (item.kind === "diff") return "Changes"
  return "Tools"
}

function groupedStatus(
  current: TranscriptItem["status"],
  next: TranscriptItem["status"],
): TranscriptItem["status"] {
  if (current === "running" || next === "running") return "running"
  if (current === "failed" || next === "failed") return "failed"
  return "completed"
}

function outlineMarker(section: TranscriptOutlineItem): string {
  if (section.status === "running") return "◌"
  if (section.status === "failed") return "×"
  if (section.kind === "user") return ">"
  if (section.kind === "message") return "◆"
  if (section.kind === "reasoning") return "·"
  if (section.kind === "diff") return "Δ"
  return "✓"
}

function formatGit(project: ProjectPreflight): string {
  if (!project.git.available) return "git unavailable"
  if (!project.git.repository) return "not a git repo"
  const changes = project.git.changedFiles === 0 ? "clean" : `${project.git.changedFiles} changed`
  return [project.git.branch, changes].filter(Boolean).join(" · ")
}

function fileTypeForPath(path: string | undefined): string {
  const extension = path?.split(".").at(-1)?.toLowerCase()
  if (extension === "ts" || extension === "tsx") return "typescript"
  if (extension === "js" || extension === "jsx") return "javascript"
  if (extension === "json") return "json"
  if (extension === "md") return "markdown"
  return "text"
}

function createSyntaxStyle(palette: BrandPalette): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    keyword: { fg: RGBA.fromHex(palette.action), bold: true },
    string: { fg: RGBA.fromHex(palette.accent) },
    comment: { fg: RGBA.fromHex(palette.muted), italic: true },
    number: { fg: RGBA.fromHex(palette.action) },
    default: { fg: RGBA.fromHex(palette.foreground) },
  })
}
