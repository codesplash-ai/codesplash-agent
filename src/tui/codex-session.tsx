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
  EngineId,
  EngineModel,
  PendingRequest,
  PermissionMode,
  ProjectPreflight,
  SessionController,
  SessionPolicy,
  TranscriptItem,
} from "../core/index.ts"
import { defaultSessionPolicy, isPermissionMode, suspendToShell } from "../core/index.ts"
import { extractImageAttachments } from "./attachments.ts"
import type { BrandPalette } from "./brand.ts"

export type CodexSessionAction = "home" | "reconnect" | "new" | "resume-picker" | "quit"

export type SlashCommandName =
  | "help"
  | "new"
  | "resume"
  | "engine"
  | "model"
  | "permissions"
  | "usage"
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
  "usage",
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

/** Human-facing engine name for transcript headers and hints; the status line keeps the raw id. */
export function engineDisplayName(engine: EngineId): string {
  if (engine === "codesplash") return "CodeSplash"
  if (engine === "claude") return "Claude"
  return "Codex"
}

/** Status-line engine label: the engine id plus the active model selector, e.g. "codex/gpt-5". */
export function engineStatusLabel(engine: EngineId, model: string | undefined): string {
  return `${engine}${model ? `/${model}` : ""}`
}

export const slashCommandHelp: ReadonlyArray<{ command: string; description: string }> = [
  { command: "/new", description: "Start a fresh session in this project" },
  { command: "/resume", description: "Open the session picker" },
  { command: "/engine", description: "Back to the engine screen (welcome)" },
  { command: "/model [name]", description: "List models, or switch for the next turn" },
  { command: "/permissions", description: "Show permission mode, rules, sandbox, and trust" },
  { command: "/usage", description: "Show token usage, context left, and estimated cost" },
  { command: "/history", description: "Show where this session is stored" },
  { command: "/help", description: "Toggle this overlay (also F1)" },
  { command: "/quit", description: "Quit the app" },
]

export const keyboardHelpEntries: ReadonlyArray<{ keys: string; action: string }> = [
  { keys: "Enter", action: "Send the prompt" },
  { keys: "Shift+Enter / Ctrl+J", action: "Insert a newline" },
  { keys: "Esc", action: "Interrupt the running turn / close overlay" },
  { keys: "A · S · P · D · C", action: "Answer an approval request (P always allows)" },
  { keys: "A · K", action: "Approve a plan / keep planning" },
  { keys: "Shift+Tab", action: "Cycle permission mode (CodeSplash)" },
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
  // Besides the plan itself, the harness needs 18 rows for its chrome, composer,
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
    return "Install Codex CLI 0.147.0 or newer (tested protocol baseline)"
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

/**
 * Structural mirror of the permission engine's ParsedPermissionRule: the session screen renders
 * rule views without importing the engine module, so the codesplash permission layer stays an
 * optional dependency of this engine-agnostic file.
 */
export type PermissionRuleView = {
  tool: string
  pattern?: string
  action: "allow" | "ask" | "deny"
  source: "cli" | "project" | "user" | "grants" | "builtin"
  raw: string
}

/** Permission-layer surface a codesplash session hands the screen; absent for other engines. */
export type SessionPermissionsUi = {
  /** True only when the session was launched with --bypass-approvals and the user confirmed. */
  bypassAllowed: boolean
  workspaceTrusted: boolean
  /** Switches the live session's mode; the engine emits session.status with the new mode back. */
  setMode(mode: PermissionMode): Promise<void>
  /** Merged rule list built from the same inputs the session was opened with. */
  loadRules(): Promise<PermissionRuleView[]>
  /** Deletes a remembered grant; absent when no grants file is configured for this session. */
  removeGrant?(rule: string): Promise<void>
}

/** Shift+Tab cycle order; "bypass" participates only when the launch flag allowed it. */
export const permissionModeCycle: readonly PermissionMode[] = ["default", "accept-edits", "plan", "bypass"]

export function nextPermissionMode(current: PermissionMode, bypassAllowed: boolean): PermissionMode {
  const order = bypassAllowed ? permissionModeCycle : permissionModeCycle.filter((mode) => mode !== "bypass")
  // An unknown current mode (e.g. "bypass" after the flag was declined) restarts at "default".
  return order[(order.indexOf(current) + 1) % order.length] ?? "default"
}

/** Live mode: the last session.status wins; before any status the opening policy does. */
export function currentPermissionMode(state: AppViewState, policy: SessionPolicy): PermissionMode {
  if (state.permissionMode !== undefined && isPermissionMode(state.permissionMode)) {
    return state.permissionMode
  }
  return policy.permissionMode ?? "default"
}

export function permissionModeCycleHint(bypassAllowed: boolean): string {
  return `Shift+Tab cycles default → accept-edits → plan${bypassAllowed ? " → bypass" : ""}`
}

/** Status-line badge text; "default" renders no badge at all. */
export function permissionModeBadgeLabel(mode: PermissionMode): string | undefined {
  if (mode === "plan") return "PLAN"
  if (mode === "accept-edits") return "ACCEPT EDITS"
  if (mode === "bypass") return "BYPASS"
  return undefined
}

/** BYPASS uses the same inverse alarm styling as FULL ACCESS; the other modes stay accent text. */
export function PermissionModeBadge({ mode, palette }: { mode: PermissionMode; palette: BrandPalette }) {
  const label = permissionModeBadgeLabel(mode)
  if (!label) return null
  if (mode === "bypass") {
    return (
      <text fg={palette.background} bg={palette.destructive}>
        <b> {label} </b>
      </text>
    )
  }
  return (
    <text fg={palette.accent}>
      <b>{label}</b>
    </text>
  )
}

export function permissionTrustLabel(trusted: boolean): string {
  return trusted ? "trusted" : "untrusted — project rule files and .codesplash/permissions.toml are ignored"
}

/** Overlay source tags; "builtin" renders as "built-in". */
export function permissionSourceTag(source: PermissionRuleView["source"]): string {
  return source === "builtin" ? "built-in" : source
}

export type PermissionRuleRow = { text: string; isGrant: boolean; selected: boolean }
export type PermissionRuleSection = { header: string; rows: PermissionRuleRow[] }

/**
 * Sorts the merged rules into allow/ask/deny sections for the /permissions overlay. Only
 * remembered grants are selectable; selectedGrant indexes them in section order.
 */
export function buildPermissionRuleSections(
  rules: PermissionRuleView[],
  selectedGrant: number,
): PermissionRuleSection[] {
  let grantIndex = 0
  return (["allow", "ask", "deny"] as const).map((action) => {
    const matching = rules.filter((rule) => rule.action === action)
    return {
      header: `${action.charAt(0).toUpperCase()}${action.slice(1)} (${matching.length})`,
      rows: matching.map((rule) => {
        const isGrant = rule.source === "grants"
        const selected = isGrant && grantIndex === selectedGrant
        if (isGrant) grantIndex += 1
        return {
          text: `${rule.raw}  [${permissionSourceTag(rule.source)}]`,
          isGrant,
          selected,
        }
      }),
    }
  })
}

/**
 * Deletes the currently selected remembered grant, reloads the merged rules, and clamps the
 * selection. Removal only affects new sessions — the note travels back for the overlay.
 */
export async function deleteSelectedGrant(
  ui: Pick<SessionPermissionsUi, "loadRules" | "removeGrant">,
  rules: PermissionRuleView[],
  selectedGrant: number,
): Promise<{ rules: PermissionRuleView[]; selectedGrant: number; notice?: string }> {
  const grant = rules.filter((rule) => rule.source === "grants")[selectedGrant]
  if (!grant || !ui.removeGrant) return { rules, selectedGrant }
  await ui.removeGrant(grant.raw)
  const refreshed = await ui.loadRules()
  const remaining = refreshed.filter((rule) => rule.source === "grants").length
  return {
    rules: refreshed,
    selectedGrant: Math.max(0, Math.min(selectedGrant, remaining - 1)),
    notice: `Removed ${grant.raw} (applies to new sessions)`,
  }
}

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

/** Rule-list portion of the /permissions overlay; absent for engines without the layer. */
type PermissionsOverlayRules =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; rules: PermissionRuleView[]; selectedGrant: number; notice?: string }

type OverlayState =
  | { kind: "help" }
  | { kind: "permissions"; rules?: PermissionsOverlayRules }
  | { kind: "usage" }
  | { kind: "history" }
  | { kind: "models"; state: ModelOverlayState }

type CodexSessionAppProps = {
  controller: SessionController
  palette: BrandPalette
  project: ProjectPreflight
  policy?: SessionPolicy
  /** Directory of the persisted session, or undefined when history is disabled. */
  historyLocation?: string
  /** Engine shown in the status line and transcript headers; the flow itself is engine-agnostic. */
  engine?: EngineId
  /** First-party permission layer surface; only codesplash sessions provide one. */
  permissions?: SessionPermissionsUi
  onAction(action: CodexSessionAction): void
}

export function CodexSessionApp({
  controller,
  palette,
  project,
  policy = defaultSessionPolicy,
  historyLocation,
  engine = "codex",
  permissions,
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
  // CodeSplash resumes through the transcript persisted next to the session's event log, which
  // only exists when history is on disk. Without it a reopen would silently discard everything
  // the model knows, and the in-process loop already accepts a fresh turn after a failed one —
  // so recoverable errors keep the composer live instead of offering the Ctrl+R reconnect flow.
  const supportsReconnect = engine !== "codesplash" || historyLocation !== undefined
  const reconnectPending = supportsReconnect && state.error?.recoverable === true

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
      // "cancel" resolves every request kind (the engine treats it as a dismissal), including
      // ask_user questions whose choices list only the model's own options.
      if (!request || (choice !== "cancel" && !request.choices.includes(choice))) return
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

  const cyclePermissionMode = useCallback(() => {
    // Engines without a first-party permission layer ignore the key entirely.
    if (!permissions) return
    if (state.turnStatus === "running") {
      setCommandError("Permission mode is locked while a turn runs — interrupt or wait, then Shift+Tab")
      return
    }
    const next = nextPermissionMode(currentPermissionMode(state, policy), permissions.bypassAllowed)
    void runCommand(() => permissions.setMode(next))
  }, [permissions, policy, runCommand, state])

  const openPermissionsOverlay = useCallback(() => {
    if (!permissions) {
      // Engine-agnostic sessions (codex) keep the static sandbox/approvals view.
      setOverlay({ kind: "permissions" })
      return
    }
    setOverlay({ kind: "permissions", rules: { phase: "loading" } })
    permissions.loadRules().then(
      (rules) =>
        setOverlay((current) =>
          current?.kind === "permissions"
            ? { kind: "permissions", rules: { phase: "ready", rules, selectedGrant: 0 } }
            : current,
        ),
      (error) =>
        setOverlay((current) =>
          current?.kind === "permissions"
            ? {
                kind: "permissions",
                rules: { phase: "error", message: error instanceof Error ? error.message : String(error) },
              }
            : current,
        ),
    )
  }, [permissions])

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
          openPermissionsOverlay()
          return
        case "usage":
          setOverlay({ kind: "usage" })
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
    [controller, historyLocation, onAction, openModelOverlay, openPermissionsOverlay, runCommand],
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

    // Shift+Tab cycles the permission mode even with the /permissions overlay open, so the
    // overlay's mode line updates live. Terminals encode it as CSI Z, parsed as shift+"tab".
    if (key.name === "tab" && key.shift) {
      key.preventDefault()
      cyclePermissionMode()
      return
    }

    if (overlay) {
      if (key.name === "escape") {
        key.preventDefault()
        setOverlay(undefined)
        return
      }
      if (overlay.kind === "permissions" && overlay.rules?.phase === "ready" && permissions) {
        const ready = overlay.rules
        const grantCount = ready.rules.filter((rule) => rule.source === "grants").length
        if (grantCount > 0 && (key.name === "up" || key.name === "down")) {
          key.preventDefault()
          const direction = key.name === "up" ? -1 : 1
          setOverlay({
            kind: "permissions",
            rules: {
              ...ready,
              selectedGrant: Math.max(0, Math.min(grantCount - 1, ready.selectedGrant + direction)),
            },
          })
          return
        }
        if (key.name === "d" && grantCount > 0 && permissions.removeGrant) {
          key.preventDefault()
          void deleteSelectedGrant(permissions, ready.rules, ready.selectedGrant).then(
            (next) =>
              setOverlay((current) =>
                current?.kind === "permissions" && current.rules?.phase === "ready"
                  ? { kind: "permissions", rules: { phase: "ready", ...next } }
                  : current,
              ),
            (error) => setCommandError(error instanceof Error ? error.message : String(error)),
          )
          return
        }
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

    if (key.ctrl && key.name === "r" && reconnectPending) {
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
              <text fg={palette.muted}>
                Ask {engineDisplayName(engine)} to inspect, explain, or change this project.
              </text>
            </box>
          ) : (
            state.transcript.map((item) => (
              <TranscriptEntry
                key={item.id}
                item={item}
                palette={palette}
                syntaxStyle={syntaxStyle}
                engineName={engineDisplayName(engine)}
              />
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
          focused={!overlay && !state.pendingRequest && !reconnectPending}
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
            const extracted = extractImageAttachments(text)
            void runCommand(() =>
              controller.send({
                text: extracted.text,
                images: extracted.images.length > 0 ? extracted.images : undefined,
              }),
            ).then((sent) => {
              if (sent) {
                textareaRef.current?.setText("")
                if (extracted.warnings.length > 0) setCommandError(extracted.warnings.join(" · "))
              }
            })
          }}
        />
      </box>

      <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between" }}>
        <text fg={error ? palette.destructive : palette.muted}>
          {error ?? statusHelp(state, supportsReconnect)}
        </text>
        <box style={{ height: 1, flexDirection: "row" }}>
          <text fg={palette.accent}>
            {engineStatusLabel(engine, state.model)}
            {context ? ` · ${context}` : ""} ·{" "}
          </text>
          <PolicyBadge policy={policy} palette={palette} />
          {permissions && permissionModeBadgeLabel(currentPermissionMode(state, policy)) ? (
            <>
              <text fg={palette.accent}> · </text>
              <PermissionModeBadge mode={currentPermissionMode(state, policy)} palette={palette} />
            </>
          ) : null}
          {rateLimit ? (
            <text fg={rateLimit.critical ? palette.destructive : palette.accent}> · {rateLimit.text}</text>
          ) : null}
          <text fg={palette.accent}> · {state.sessionStatus}</text>
        </box>
      </box>

      <SessionOverlay
        overlay={overlay}
        palette={palette}
        policy={policy}
        historyLocation={historyLocation}
        state={state}
        permissions={permissions}
      />
      <Approval request={overlay ? undefined : state.pendingRequest} palette={palette} />
    </box>
  )
}

function SessionOverlay({
  overlay,
  palette,
  policy,
  historyLocation,
  state,
  permissions,
}: {
  overlay: OverlayState | undefined
  palette: BrandPalette
  policy: SessionPolicy
  historyLocation?: string
  state: AppViewState
  permissions?: SessionPermissionsUi
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
        <text fg={palette.muted} style={{ marginTop: 1 }}>
          Tip: drop an image file onto the terminal (or paste its path) to attach it to your prompt.
        </text>
      </box>
    )
  }

  if (overlay.kind === "permissions") {
    const danger = policy.sandbox === "danger-full-access"

    // Engine-agnostic sessions (codex) keep the old static sandbox/approvals view.
    if (!permissions) {
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

    const mode = currentPermissionMode(state, policy)
    const rules = overlay.rules
    const hasGrants = rules?.phase === "ready" && rules.rules.some((rule) => rule.source === "grants")
    return (
      <box title="Permissions · Esc closes" style={frame}>
        <box style={{ height: 1, flexDirection: "row" }}>
          <text fg={palette.foreground}>Mode: {mode} </text>
          <PermissionModeBadge mode={mode} palette={palette} />
        </box>
        <text fg={palette.muted}>{permissionModeCycleHint(permissions.bypassAllowed)}</text>
        <box style={{ height: 1, flexDirection: "row" }}>
          <text fg={palette.foreground}>Sandbox: </text>
          <PolicyBadge policy={policy} palette={palette} />
        </box>
        <text fg={palette.foreground}>Approvals: {policy.approvalPolicy}</text>
        <text fg={permissions.workspaceTrusted ? palette.foreground : palette.destructive}>
          Workspace trust: {permissionTrustLabel(permissions.workspaceTrusted)}
        </text>
        {danger ? (
          <text fg={palette.destructive}>
            No sandbox is active for this session. Every approval is final.
          </text>
        ) : null}
        {rules?.phase === "loading" ? (
          <text fg={palette.muted} style={{ marginTop: 1 }}>
            Loading rules…
          </text>
        ) : null}
        {rules?.phase === "error" ? (
          <text fg={palette.destructive} style={{ marginTop: 1 }}>
            {rules.message}
          </text>
        ) : null}
        {rules?.phase === "ready" ? (
          <>
            {buildPermissionRuleSections(rules.rules, rules.selectedGrant).map((section) => (
              <box key={section.header} style={{ marginTop: 1 }}>
                <text fg={palette.accent}>
                  <b>{section.header}</b>
                </text>
                {section.rows.length === 0 ? (
                  <text fg={palette.muted}> (none)</text>
                ) : (
                  section.rows.map((row, index) => (
                    <text
                      key={`${index}:${row.text}`}
                      fg={row.selected ? palette.action : palette.foreground}
                    >
                      {row.selected ? "› " : "  "}
                      {row.text}
                    </text>
                  ))
                )}
              </box>
            ))}
            {rules.notice ? (
              <text fg={palette.accent} style={{ marginTop: 1 }}>
                {rules.notice}
              </text>
            ) : null}
            {hasGrants && permissions.removeGrant ? (
              <text fg={palette.muted} style={{ marginTop: 1 }}>
                ↑↓ select a remembered grant · d deletes (applies to new sessions)
              </text>
            ) : null}
          </>
        ) : null}
      </box>
    )
  }

  if (overlay.kind === "usage") {
    return (
      <box title="Session usage · Esc closes" style={frame}>
        {buildUsageOverlayLines(state).map((line) => (
          <text key={line.label} fg={palette.foreground}>
            {line.label.padEnd(16)} {line.value}
          </text>
        ))}
        <text fg={palette.muted} style={{ marginTop: 1 }}>
          {usageOverlayNote(state.usage)}
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
  engineName = "Codex",
}: {
  item: TranscriptItem
  palette: BrandPalette
  syntaxStyle: SyntaxStyle
  engineName?: string
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
  const title = item.kind === "reasoning" ? `${engineName} thinking${hasText ? "" : "…"}` : engineName
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
  const tag = approvalTagLine(request)

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
      {tag ? (
        <text fg={palette.destructive}>
          <b>{tag}</b>
        </text>
      ) : null}
      {request.detail ? <text fg={palette.foreground}>{request.detail}</text> : null}
      {request.requestKind === "user-input" ? (
        <>
          {request.choices.map((choice, index) => (
            <text key={`${index}:${choice}`} fg={palette.foreground}>
              {index + 1} {choice}
            </text>
          ))}
          <text fg={palette.action}>1-{request.choices.length} answer · Esc dismiss</text>
        </>
      ) : (
        <text fg={palette.action}>{approvalKeyHint(request)}</text>
      )}
    </box>
  )
}

/** Tag for dangerous-floor approvals: they always ask and can never be remembered. */
export function approvalTagLine(request: PendingRequest): string | undefined {
  return request.alwaysAsk ? "always asks — dangerous command; cannot be remembered" : undefined
}

/** Key + label for each approval choice the engines can offer; rendered in choice order. */
export const approvalChoiceKeyLabels: Readonly<Record<string, string>> = {
  accept: "A Accept",
  acceptForSession: "S Session",
  acceptAlways: "P Always allow (persists)",
  approve: "A Approve",
  keepPlanning: "K Keep planning",
  decline: "D Decline",
  cancel: "C Cancel",
}

/** Rendered key hint for approval-kind requests, built from the request's actual choices. */
export function approvalKeyHint(request: PendingRequest): string {
  const labels = request.choices.map((choice) => approvalChoiceKeyLabels[choice] ?? choice)
  return [...labels, "Esc dismiss"].join(" · ")
}

/** Keys mapped to the choices they may resolve; only choices the request offers are accepted. */
const approvalKeyChoices: Readonly<Record<string, readonly string[]>> = {
  a: ["accept", "approve"],
  s: ["acceptForSession"],
  p: ["acceptAlways"],
  d: ["decline"],
  k: ["keepPlanning"],
  c: ["cancel"],
}

export function approvalChoiceForKey(name: string, request: PendingRequest): string | undefined {
  // Esc always resolves as "cancel": the engine accepts it for every request kind even when the
  // request's own choices (e.g. ask_user options) do not list it.
  if (name === "escape") return "cancel"
  if (request.requestKind === "user-input") {
    if (name === "c") return "cancel"
    if (!/^[1-9]$/.test(name)) return undefined
    return request.choices[Number(name) - 1]
  }
  return approvalKeyChoices[name]?.find((choice) => request.choices.includes(choice))
}

function statusHelp(state: AppViewState, supportsReconnect: boolean): string {
  if (state.error?.recoverable && supportsReconnect) return "Ctrl+R reconnect · Ctrl+Q home"
  if (state.turnStatus === "running") return "Esc interrupt · Ctrl+Q home"
  return "Enter send · /help commands · F1 keys"
}

export function contextRemainingPercent(state: AppViewState): number | undefined {
  const total =
    state.usage.contextTokens ??
    (state.usage.inputTokens === undefined
      ? undefined
      : state.usage.inputTokens + (state.usage.outputTokens ?? 0))
  const window = state.usage.modelContextWindow
  if (total === undefined || window === undefined || window <= 0) return undefined

  const remaining = Math.max(0, window - total)
  return Math.max(0, Math.min(100, Math.round((remaining / window) * 100)))
}

export function formatContextRemaining(state: AppViewState): string | undefined {
  const percent = contextRemainingPercent(state)
  return percent === undefined ? undefined : `${percent}% context left`
}

/**
 * True when the session's estimated cost is missing usage: the loop prices usage from the model
 * catalog and flags every usage.updated payload with hasUnpricedUsage (false included), which is
 * authoritative — a model legitimately priced at $0 (e.g. a local provider) reports false and is
 * NOT partial. Only sessions recorded before the flag existed (no flag on any replayed event)
 * fall back to the outside heuristic: a cost of exactly zero alongside observed tokens.
 */
export function costIsPartial(usage: AppViewState["usage"]): boolean {
  if (usage.hasUnpricedUsage !== undefined) return usage.hasUnpricedUsage
  if (usage.estimatedCostUsd !== 0) return false
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) > 0
}

/** Catalog estimates only — always labelled "estimated", plus "partial" for unpriced usage. */
export function formatEstimatedCost(usage: AppViewState["usage"]): string {
  const cost = usage.estimatedCostUsd
  if (cost === undefined) return "not reported"
  return `$${cost.toFixed(4)} (estimated${costIsPartial(usage) ? ", partial" : ""})`
}

export function usageOverlayNote(usage: AppViewState["usage"]): string {
  const base = "Costs are catalog estimates, not provider billing."
  return costIsPartial(usage)
    ? `${base} Some usage ran on models without pricing, so the cost shown is partial.`
    : base
}

export type UsageOverlayLine = { label: string; value: string }

/** The /usage overlay body: cumulative tokens, context left, estimated cost, rate limit. */
export function buildUsageOverlayLines(state: AppViewState): UsageOverlayLine[] {
  const usage = state.usage
  const total =
    usage.totalTokens ??
    (usage.inputTokens === undefined && usage.outputTokens === undefined
      ? undefined
      : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0))
  const cached = usage.cachedInputTokens
  const lines: UsageOverlayLine[] = [
    { label: "Model", value: state.model ?? "engine default" },
    {
      label: "Input tokens",
      value: `${formatTokenCount(usage.inputTokens)}${cached ? ` (${formatTokenCount(cached)} cached)` : ""}`,
    },
    { label: "Output tokens", value: formatTokenCount(usage.outputTokens) },
    { label: "Total tokens", value: formatTokenCount(total) },
    { label: "Context left", value: contextLeftValue(state) },
    { label: "Estimated cost", value: formatEstimatedCost(usage) },
  ]
  const rateLimit = formatRateLimit(state)
  if (rateLimit) lines.push({ label: "Rate limit", value: rateLimit.text })
  return lines
}

function contextLeftValue(state: AppViewState): string {
  const percent = contextRemainingPercent(state)
  const window = state.usage.modelContextWindow
  if (percent === undefined || window === undefined) return "unknown"
  return `${percent}% of ${formatTokenCount(window)} tokens`
}

function formatTokenCount(count: number | undefined): string {
  return count === undefined ? "—" : count.toLocaleString("en-US")
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
