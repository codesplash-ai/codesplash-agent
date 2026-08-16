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
  EngineModel,
  PendingRequest,
  ProjectPreflight,
  SessionController,
  SessionPolicy,
  TranscriptItem,
} from "../core/index.ts"
import { defaultSessionPolicy, suspendToShell } from "../core/index.ts"
import type { BrandPalette } from "./brand.ts"

export type CodexSessionAction = "home" | "reconnect" | "new" | "resume-picker" | "quit"

export type SlashCommandName =
  | "help"
  | "new"
  | "resume"
  | "engine"
  | "model"
  | "permissions"
  | "history"
  | "quit"

export type ParsedSlashCommand =
  | { name: SlashCommandName; argument?: string }
  | { name: "unknown"; raw: string }

const slashCommandNames: readonly SlashCommandName[] = [
  "help",
  "new",
  "resume",
  "engine",
  "model",
  "permissions",
  "history",
  "quit",
]

/** Returns undefined for ordinary prompts; commands start with "/" and a known word. */
export function parseSlashCommand(text: string): ParsedSlashCommand | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith("/")) return undefined
  const [word = "", ...rest] = trimmed.slice(1).split(/\s+/)
  const name = word.toLowerCase() as SlashCommandName
  if (!slashCommandNames.includes(name)) return { name: "unknown", raw: trimmed }
  return { name, argument: rest.join(" ") || undefined }
}

export const slashCommandHelp: ReadonlyArray<{ command: string; description: string }> = [
  { command: "/new", description: "Start a fresh Codex session in this project" },
  { command: "/resume", description: "Open the session picker" },
  { command: "/engine", description: "Back to the engine screen (welcome)" },
  { command: "/model [name]", description: "List models, or switch for the next turn" },
  { command: "/permissions", description: "Show the sandbox and approval policy" },
  { command: "/history", description: "Show where this session is stored" },
  { command: "/help", description: "Toggle this overlay (also F1)" },
  { command: "/quit", description: "Quit the app" },
]

export const keyboardHelpEntries: ReadonlyArray<{ keys: string; action: string }> = [
  { keys: "Enter", action: "Send the prompt" },
  { keys: "Shift+Enter / Ctrl+J", action: "Insert a newline" },
  { keys: "Esc", action: "Interrupt the running turn / close overlay" },
  { keys: "A · S · D · C", action: "Answer an approval request" },
  { keys: "Ctrl+L", action: "Jump to the latest output" },
  { keys: "Ctrl+O", action: "Toggle the conversation outline" },
  { keys: "⌥↑ / ⌥↓", action: "Jump between outline sections" },
  { keys: "Ctrl+R", action: "Reconnect after a recoverable error" },
  { keys: "Ctrl+Z", action: "Suspend to the shell (fg resumes)" },
  { keys: "F1", action: "Toggle keyboard help" },
  { keys: "Ctrl+Q / Ctrl+C", action: "Back to the welcome screen" },
]

/** Rows the composer should occupy; small terminals get a compact composer. */
export function composerRows(terminalHeight: number): number {
  return terminalHeight < 20 ? 3 : 5
}

/** The plan panel yields its rows to the transcript on small terminals. */
export function showPlanPanel(terminalHeight: number, planSteps: number): boolean {
  // Besides the plan itself, the cockpit needs 18 rows for its chrome, composer,
  // and at least one transcript row. Hiding the panel is preferable to letting
  // Yoga shrink its text rows onto the same terminal line.
  return planSteps > 0 && terminalHeight >= planSteps + 18
}

export function formatRateLimit(state: AppViewState): { text: string; critical: boolean } | undefined {
  const rateLimit = state.usage.rateLimit
  if (!rateLimit) return undefined
  const percent = Math.max(0, Math.min(100, Math.round(rateLimit.usedPercent)))
  return {
    text: `${rateLimit.label ? `${rateLimit.label} ` : ""}limit ${percent}% used`,
    critical: percent >= 90,
  }
}

/** Actionable next step for provider failures that have a known recovery. */
export function errorRecoveryHint(message: string): string | undefined {
  if (/auth|unauthorized|401|login/i.test(message))
    return "Reauthenticate from the welcome screen (codex login)"
  if (/rate.?limit|quota|429|usage limit/i.test(message))
    return "Provider limit reached — wait for the reset shown above"
  if (/version|protocol|unsupported/i.test(message))
    return "Install Codex CLI 0.147.0 (pinned protocol baseline)"
  return undefined
}

/** The leading cell is reserved for OpenTUI's cursor while the empty composer is focused. */
export const composerPlaceholder = " Ask the agent… Enter sends; Shift+Enter adds a line"

export const composerKeyBindings = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  // Terminals without modified-key reporting commonly encode Shift+Enter as LF
  // while ordinary Enter remains CR ("return"). Treat LF as the newline fallback.
  { name: "linefeed", action: "newline" },
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

type ModelOverlayState = {
  models: EngineModel[]
  selected: number
  loading: boolean
  error?: string
}

type OverlayState =
  | { kind: "help" }
  | { kind: "permissions" }
  | { kind: "history" }
  | { kind: "models"; state: ModelOverlayState }

type CodexSessionAppProps = {
  controller: SessionController
  palette: BrandPalette
  project: ProjectPreflight
  policy?: SessionPolicy
  /** Directory of the persisted session, or undefined when history is disabled. */
  historyLocation?: string
  onAction(action: CodexSessionAction): void
}

export function CodexSessionApp({
  controller,
  palette,
  project,
  policy = defaultSessionPolicy,
  historyLocation,
  onAction,
}: CodexSessionAppProps) {
  const renderer = useRenderer()
  const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions()
  const textareaRef = useRef<TextareaRenderable>(null)
  const resetCursorBlinkRef = useRef<() => void>(() => {})
  const scrollboxRef = useRef<ScrollBoxRenderable>(null)
  const [state, setState] = useState(controller.state)
  const [commandError, setCommandError] = useState<string>()
  const [selectedOutlineId, setSelectedOutlineId] = useState<string>()
  const [outlineVisible, setOutlineVisible] = useState(false)
  const [overlay, setOverlay] = useState<OverlayState>()
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

  const selectModel = useCallback(
    (model: EngineModel) => {
      setOverlay(undefined)
      void runCommand(() => controller.setModel(model.id))
    },
    [controller, runCommand],
  )

  const openModelOverlay = useCallback(() => {
    if (!controller.canSwitchModels) {
      setCommandError("This engine has no model picker")
      return
    }
    setOverlay({ kind: "models", state: { models: [], selected: 0, loading: true } })
    controller.listModels().then(
      (models) =>
        setOverlay((current) =>
          current?.kind === "models"
            ? {
                kind: "models",
                state: {
                  models,
                  selected: Math.max(
                    0,
                    models.findIndex((model) => model.isDefault),
                  ),
                  loading: false,
                },
              }
            : current,
        ),
      (error) =>
        setOverlay((current) =>
          current?.kind === "models"
            ? {
                kind: "models",
                state: {
                  models: [],
                  selected: 0,
                  loading: false,
                  error: error instanceof Error ? error.message : String(error),
                },
              }
            : current,
        ),
    )
  }, [controller])

  const runSlashCommand = useCallback(
    (command: ParsedSlashCommand) => {
      switch (command.name) {
        case "unknown":
          setCommandError(`Unknown command ${command.raw.split(/\s+/)[0]} — try /help`)
          return
        case "help":
          setOverlay((current) => (current?.kind === "help" ? undefined : { kind: "help" }))
          return
        case "new":
          onAction("new")
          return
        case "resume":
          if (!historyLocation) setCommandError("History is disabled for this run — nothing to resume")
          else onAction("resume-picker")
          return
        case "engine":
          onAction("home")
          return
        case "quit":
          onAction("quit")
          return
        case "permissions":
          setOverlay({ kind: "permissions" })
          return
        case "history":
          setOverlay({ kind: "history" })
          return
        case "model":
          if (command.argument) void runCommand(() => controller.setModel(command.argument as string))
          else openModelOverlay()
          return
      }
    },
    [controller, historyLocation, onAction, openModelOverlay, runCommand],
  )

  useKeyboard((key) => {
    if (key.ctrl && (key.name === "c" || key.name === "q")) {
      key.preventDefault()
      onAction("home")
      return
    }

    if (key.ctrl && key.name === "z") {
      key.preventDefault()
      suspendToShell(renderer)
      return
    }

    if (key.name === "f1") {
      key.preventDefault()
      setOverlay((current) => (current?.kind === "help" ? undefined : { kind: "help" }))
      return
    }

    if (overlay) {
      if (key.name === "escape") {
        key.preventDefault()
        setOverlay(undefined)
        return
      }
      if (overlay.kind === "models" && !overlay.state.loading && overlay.state.models.length > 0) {
        if (key.name === "up" || key.name === "down") {
          key.preventDefault()
          const direction = key.name === "up" ? -1 : 1
          setOverlay({
            kind: "models",
            state: {
              ...overlay.state,
              selected: Math.max(
                0,
                Math.min(overlay.state.models.length - 1, overlay.state.selected + direction),
              ),
            },
          })
          return
        }
        if (key.name === "return" || key.name === "enter") {
          key.preventDefault()
          const model = overlay.state.models[overlay.state.selected]
          if (model) selectModel(model)
          return
        }
      }
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
  const rateLimit = formatRateLimit(state)
  const errorHint = state.error ? errorRecoveryHint(state.error.message) : undefined
  const error =
    commandError ??
    (state.error ? `${state.error.message}${errorHint ? ` — ${errorHint}` : ""}` : state.warnings.at(-1))
  const composerHeight = composerRows(terminalHeight)

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

      {showPlanPanel(terminalHeight, state.plan.length) ? (
        <box
          title="Plan"
          style={{
            width: "100%",
            height: state.plan.length + 2,
            flexShrink: 0,
            border: true,
            borderColor: palette.border,
            paddingLeft: 1,
          }}
        >
          {state.plan.map((step, index) => (
            <text
              key={`${index}:${step.text}`}
              fg={step.completed ? palette.muted : palette.foreground}
              wrapMode="none"
              style={{ height: 1, flexShrink: 0 }}
            >
              {step.completed ? "✓" : "·"} {step.text}
            </text>
          ))}
        </box>
      ) : null}

      <box
        style={{
          width: "100%",
          height: composerHeight,
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
          focused={!overlay && !state.pendingRequest && !state.error?.recoverable}
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
            const command = parseSlashCommand(text)
            if (command) {
              setCommandError(undefined)
              textareaRef.current?.setText("")
              runSlashCommand(command)
              return
            }
            void runCommand(() => controller.send({ text })).then((sent) => {
              if (sent) textareaRef.current?.setText("")
            })
          }}
        />
      </box>

      <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between" }}>
        <text fg={error ? palette.destructive : palette.muted}>{error ?? statusHelp(state)}</text>
        <box style={{ height: 1, flexDirection: "row" }}>
          <text fg={palette.accent}>
            codex{state.model ? `/${state.model}` : ""}
            {context ? ` · ${context}` : ""} ·{" "}
          </text>
          <PolicyBadge policy={policy} palette={palette} />
          {rateLimit ? (
            <text fg={rateLimit.critical ? palette.destructive : palette.accent}> · {rateLimit.text}</text>
          ) : null}
          <text fg={palette.accent}> · {state.sessionStatus}</text>
        </box>
      </box>

      <SessionOverlay overlay={overlay} palette={palette} policy={policy} historyLocation={historyLocation} />
      <Approval request={overlay ? undefined : state.pendingRequest} palette={palette} />
    </box>
  )
}

function SessionOverlay({
  overlay,
  palette,
  policy,
  historyLocation,
}: {
  overlay: OverlayState | undefined
  palette: BrandPalette
  policy: SessionPolicy
  historyLocation?: string
}) {
  if (!overlay) return null

  const frame = {
    position: "absolute" as const,
    width: "84%" as const,
    left: "8%" as const,
    top: 2,
    zIndex: 30,
    border: true,
    borderColor: palette.action,
    backgroundColor: palette.popover,
    padding: 1,
  }

  if (overlay.kind === "help") {
    return (
      <box title="Keyboard & commands · Esc closes" style={frame}>
        <text fg={palette.accent}>
          <b>Keys</b>
        </text>
        {keyboardHelpEntries.map((entry) => (
          <text key={entry.keys} fg={palette.foreground}>
            {entry.keys.padEnd(24)} {entry.action}
          </text>
        ))}
        <text fg={palette.accent} style={{ marginTop: 1 }}>
          <b>Commands</b>
        </text>
        {slashCommandHelp.map((entry) => (
          <text key={entry.command} fg={palette.foreground}>
            {entry.command.padEnd(24)} {entry.description}
          </text>
        ))}
      </box>
    )
  }

  if (overlay.kind === "permissions") {
    const danger = policy.sandbox === "danger-full-access"
    return (
      <box title="Permissions · Esc closes" style={frame}>
        <box style={{ height: 1, flexDirection: "row" }}>
          <text fg={palette.foreground}>Sandbox: </text>
          <PolicyBadge policy={policy} palette={palette} />
        </box>
        <text fg={palette.foreground}>Approvals: {policy.approvalPolicy}</text>
        <text fg={danger ? palette.destructive : palette.muted} style={{ marginTop: 1 }}>
          {danger
            ? "No sandbox is active for this session. Every approval is final."
            : "Change with --sandbox/--full-access flags or [codex] config; applies to the next session."}
        </text>
      </box>
    )
  }

  if (overlay.kind === "history") {
    return (
      <box title="Session history · Esc closes" style={frame}>
        {historyLocation ? (
          <>
            <text fg={palette.foreground}>This session is stored at:</text>
            <text fg={palette.accent}>{historyLocation}</text>
            <text fg={palette.muted} style={{ marginTop: 1 }}>
              Coalesced events only — no raw provider payloads. Disable with --no-history or [history] enabled
              = false.
            </text>
          </>
        ) : (
          <text fg={palette.foreground}>History is disabled for this run; nothing is written to disk.</text>
        )}
      </box>
    )
  }

  const { models, selected, loading, error } = overlay.state
  return (
    <box title="Switch model · ↑↓ Enter · Esc closes" style={frame}>
      {loading ? <text fg={palette.muted}>Loading models…</text> : null}
      {error ? <text fg={palette.destructive}>{error}</text> : null}
      {models.map((model, index) => {
        const active = index === selected
        return (
          <box key={model.id} style={{ height: 1, flexDirection: "row" }}>
            <text fg={active ? palette.action : palette.foreground}>
              {active ? "› " : "  "}
              {model.displayName}
              {model.isDefault ? " (default)" : ""}
            </text>
            {model.description ? <text fg={palette.muted}> — {model.description}</text> : null}
          </box>
        )
      })}
      {!loading && !error && models.length === 0 ? (
        <text fg={palette.muted}>No models reported by the provider.</text>
      ) : null}
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

/** Renders in every session state so dangerous modes stay visible, not one-time notices. */
export function PolicyBadge({ policy, palette }: { policy: SessionPolicy; palette: BrandPalette }) {
  if (policy.sandbox === "danger-full-access") {
    return (
      <text fg={palette.background} bg={palette.destructive}>
        <b> FULL ACCESS </b>
      </text>
    )
  }
  return <text fg={palette.accent}>{policy.sandbox}</text>
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
  return "Enter send · /help commands · F1 keys"
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
