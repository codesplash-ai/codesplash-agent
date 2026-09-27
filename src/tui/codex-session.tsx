import { type ParsedSlashCommand, parseSlashCommand, slashCommandHelp } from "./commands.ts"

export {
  type ParsedSlashCommand,
  parseSlashCommand,
  type SlashCommandName,
  slashCommandHelp,
} from "./commands.ts"

import { dirname, join } from "node:path"
import {
  bg,
  type CursorStyleOptions,
  fg,
  LinearScrollAccel,
  MacOSScrollAccel,
  RGBA,
  type ScrollBoxOptions,
  type ScrollBoxRenderable,
  type Selection,
  StyledText,
  SyntaxStyle,
  type TextareaOptions,
  type TextareaRenderable,
} from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { tuiDefaults } from "../core/config/tui.ts"
import { type AgentConfig, configDirectory, defaultConfig } from "../core/config.ts"
import type {
  AppViewState,
  ContextInspection,
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
import { taskCommand } from "../core/orchestration/command.ts"
import { intervalMs } from "../core/orchestration/scheduler.ts"
import type { TeamRequest } from "../core/orchestration/teams.ts"
import type { BranchView } from "../core/session/branches.ts"
import { atomic, bytes } from "../core/session/files.ts"
import type { AcceptedPrompt, InputIntent, InputItem } from "../core/session/input-queue.ts"
import { emptyOutcomes, outcomeSummary } from "../core/session/outcomes.ts"
import { awayRecap, presentationArguments } from "../core/session/presentation.ts"
import { recoveryCommand } from "../core/session/recovery-command.ts"
import { markdownFileCitations } from "../server/hyperlinks.ts"
import { extractImageAttachments } from "./attachments.ts"
import { Attention } from "./attention.tsx"
import { type BrandPalette, brandThemes } from "./brand.ts"
import { CommandPalette } from "./command-palette.tsx"
import { commandSuggestions } from "./commands.ts"
import { ConfirmPanel } from "./confirm-panel.tsx"
import { DocsPanel } from "./docs-panel.tsx"
import { editDraft } from "./editor.ts"
import { completeMentionDraft, trailingMention } from "./file-mentions.ts"
import { readPreviewImage, showItermImage } from "./images.ts"
import { InputPanel, inputDraftText } from "./input-panel.tsx"
import { IntegrationsPanel } from "./integrations-panel.tsx"
import { Keymap, keyToken, readKeybindings, VimComposer } from "./keybindings.ts"
import { McpFormPanel } from "./mcp-form.tsx"
import { RecoveryPanel } from "./recovery-panel.tsx"
import { terminalMarkdown } from "./rich-text.ts"
import { TranscriptScrollback } from "./scrollback.ts"
import { SearchPanel } from "./search-panel.tsx"
import { SettingsPanel } from "./settings-panel.tsx"
import { SidePanel } from "./side-panel.tsx"
import { TaskPanel } from "./task-panel.tsx"
import { TeamPanel } from "./team-panel.tsx"
import { clipboardText, copyText, terminalProfile } from "./terminal.ts"
import {
  reviewTerminalIntegrations,
  type TerminalReview,
  terminalText,
  trustTerminalIntegrations,
} from "./terminal-integrations.ts"
import { loadUserTheme } from "./themes.ts"
import { contextualTip, onboardingText, recordTipVisit } from "./tips.ts"
import { VoiceCapture, voiceDiagnostics } from "./voice.ts"

export type CodexSessionAction = "home" | "reconnect" | "new" | "resume-picker" | "quit"

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

export const keyboardHelpEntries: ReadonlyArray<{ keys: string; action: string }> = [
  { keys: "F4", action: "Hold to dictate (key-release terminals), or toggle recording" },
  { keys: "Ctrl+P / Tab on /command", action: "Find commands and arguments; stage without sending" },
  { keys: "Ctrl+G", action: "Edit the current draft in VISUAL / EDITOR" },
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
  { keys: "Ctrl+B", action: "Let the current command continue in the background" },
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
  conflict?: string
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
  editRule?(command: string): Promise<void>
  sandboxStatus?(): string
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
          text: `${rule.raw}  [${permissionSourceTag(rule.source)}]${rule.conflict ? ` · ${rule.conflict}` : ""}`,
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
  | { kind: "side"; question: string }
  | { kind: "settings" }
  | { kind: "integrations" }
  | { kind: "docs"; releaseNotes: boolean }
  | { kind: "onboarding" }
  | { kind: "terminal-review"; review: TerminalReview }
  | { kind: "search"; query: string }
  | { kind: "image"; name: string; bytes: Uint8Array }
  | { kind: "palette"; query: string; draft: string; revision: number; models: string[] }
  | { kind: "teams" }
  | { kind: "tasks" }
  | { kind: "recovery"; tree: BranchView }
  | { kind: "input"; tab: "queue" | "history" | "stash" }
  | { kind: "help" }
  | { kind: "permissions"; rules?: PermissionsOverlayRules }
  | { kind: "usage" }
  | { kind: "context"; context: ContextInspection }
  | { kind: "resources"; title: string; text: string }
  | { kind: "history" }
  | { kind: "models"; state: ModelOverlayState }

type CodexSessionAppProps = {
  initialInput?: import("../core/engine.ts").UserInput
  config?: AgentConfig
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
  initialInput,
  config,
  controller,
  palette: basePalette,
  project: initialProject,
  policy = defaultSessionPolicy,
  historyLocation,
  engine = "codex",
  permissions,
  onAction,
}: CodexSessionAppProps) {
  const renderer = useRenderer()
  const [palette, setPalette] = useState(basePalette)
  const [builtInPalette, setBuiltInPalette] = useState(basePalette)
  const [tui, setTui] = useState(() => ({ ...tuiDefaults, ...config?.tui }))
  const keymap = useRef(new Keymap())
  const vim = useRef(new VimComposer())
  const [inputMode, setInputMode] = useState("INSERT")
  const preferenceDirectory = config?.resolution
    ? dirname(config.resolution.request.userPath)
    : configDirectory()
  const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions()
  const textareaRef = useRef<TextareaRenderable>(null)
  const activity = useRef({ time: Date.now(), sequence: controller.state.lastSequence })
  const [awayNotice, setAwayNotice] = useState("")
  useEffect(() => {
    if (!awayNotice) return
    const timer = setTimeout(() => setAwayNotice(""), 15000)
    return () => clearTimeout(timer)
  }, [awayNotice])
  const [suggestion, setSuggestion] = useState("")
  const suggestionOwner = useRef<AbortController | undefined>(undefined)
  const suggestionTurn = useRef<string | undefined>(undefined)
  const draftRevision = useRef(0)
  const editorOwner = useRef<AbortController | undefined>(undefined)
  const voiceOwner = useRef<VoiceCapture | undefined>(undefined)
  const [voicePhase, setVoicePhase] = useState("")
  useEffect(() => () => editorOwner.current?.abort(), [])
  useEffect(() => () => voiceOwner.current?.cancel(), [])
  const resetCursorBlinkRef = useRef<() => void>(() => {})
  const scrollboxRef = useRef<ScrollBoxRenderable>(null)
  const [state, setState] = useState(controller.state)
  const [project, setProject] = useState(initialProject)
  const [commandError, setCommandError] = useState<string>()
  const launchSent = useRef(false)
  useEffect(() => {
    if (!initialInput || launchSent.current) return
    launchSent.current = true
    void controller.sendLaunchInput(initialInput).catch((error) => setCommandError(String(error)))
  }, [controller, initialInput])
  const scrollback = useRef(new TranscriptScrollback())
  useEffect(() => {
    try {
      setPalette(tui.theme ? loadUserTheme(preferenceDirectory, tui.theme) : builtInPalette)
    } catch (error) {
      setCommandError(`Theme unchanged: ${String(error)}`)
    }
  }, [builtInPalette, preferenceDirectory, tui.theme])
  useEffect(() => {
    if (tui.screen === "inline") {
      renderer.footerHeight = Math.min(18, Math.max(6, renderer.terminalHeight - 3))
      renderer.screenMode = "split-footer"
      renderer.externalOutputMode = "capture-stdout"
      try {
        scrollback.current.append(renderer, state.transcript, tui.thinking)
      } catch (error) {
        setCommandError(`Scrollback: ${String(error)}`)
      }
    } else {
      renderer.externalOutputMode = "passthrough"
      renderer.screenMode = "alternate-screen"
    }
  }, [renderer, tui.screen, tui.thinking, state.transcript])
  useEffect(() => {
    if (!config) return
    let previous = ""
    const reload = () => {
      try {
        const bindings = readKeybindings(join(preferenceDirectory, "keybindings.json"))
        const signature = JSON.stringify(bindings)
        if (signature !== previous) {
          keymap.current = new Keymap(bindings)
          previous = signature
        }
      } catch (error) {
        const message = String(error)
        if (previous !== message) {
          setCommandError(`Keybindings unchanged: ${message}`)
          previous = message
        }
      }
    }
    reload()
    const timer = setInterval(reload, 1500)
    return () => clearInterval(timer)
  }, [config, preferenceDirectory])
  useEffect(() => {
    renderer.useMouse = tui.mouse === "on" || (tui.mouse === "auto" && !terminalProfile().dumb)
  }, [renderer, tui.mouse])
  const scrollAcceleration = useMemo(
    () => (tui.mouseScroll === "linear" ? new LinearScrollAccel() : new MacOSScrollAccel()),
    [tui.mouseScroll],
  )
  useEffect(() => {
    if (!tui.copyOnSelect) return
    const selected = (selection: Selection) => {
      if (selection.isDragging) return
      queueMicrotask(() => {
        const text = selection.getSelectedText()
        if (text)
          void copyText(text, { mode: tui.clipboard }).then(setCommandError, (error) =>
            setCommandError(String(error)),
          )
      })
    }
    renderer.on("selection", selected)
    return () => {
      renderer.off("selection", selected)
    }
  }, [renderer, tui.copyOnSelect, tui.clipboard])
  const tipVisitRecorded = useRef(false)
  const [showStartupTip, setShowStartupTip] = useState(true)
  useEffect(() => {
    if (config && historyLocation && tui.tips && !tipVisitRecorded.current) {
      tipVisitRecorded.current = true
      setShowStartupTip(recordTipVisit(preferenceDirectory))
    }
  }, [config, historyLocation, preferenceDirectory, tui.tips])
  const [selectedOutlineId, setSelectedOutlineId] = useState<string>()
  const [outlineVisible, setOutlineVisible] = useState(false)
  const [overlay, setOverlay] = useState<OverlayState>()
  useEffect(() => {
    suggestionOwner.current?.abort()
    setSuggestion("")
    if (
      !tui.suggestions ||
      !controller.canSideQuery ||
      state.turnStatus !== "completed" ||
      state.pendingRequest ||
      overlay ||
      textareaRef.current?.plainText.trim()
    )
      return
    const identity = state.transcript.filter((item) => item.kind === "message").at(-1)?.id
    if (!identity || identity === suggestionTurn.current) return
    suggestionTurn.current = identity
    const owner = new AbortController(),
      revision = draftRevision.current
    suggestionOwner.current = owner
    const timer = setTimeout(() => {
      void controller
        .sideQuery({ kind: "suggestion" }, owner.signal)
        .then((text) => {
          if (
            !owner.signal.aborted &&
            draftRevision.current === revision &&
            !textareaRef.current?.plainText.trim()
          )
            setSuggestion(terminalText(text, 240))
        })
        .catch(() => {})
    }, 750)
    return () => {
      clearTimeout(timer)
      owner.abort()
    }
  }, [controller, tui.suggestions, state.turnStatus, state.pendingRequest, state.transcript, overlay])
  useEffect(() => {
    if (!config || !tui.onboarding) return
    try {
      bytes(join(preferenceDirectory, "onboarding.json"), 4096)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") setOverlay({ kind: "onboarding" })
    }
  }, [config, preferenceDirectory, tui.onboarding])
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
  const [approvalFocus, setApprovalFocus] = useState(true)
  const [editingInput, setEditingInput] = useState<{ id: string; revision: string; intent: InputIntent }>()
  useEffect(() => {
    if (state.pendingRequest?.id) setApprovalFocus(true)
  }, [state.pendingRequest?.id])

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
      if (tui.reducedMotion) setCursorVisible(true)
      else showCursor()
    }

    resetCursorBlinkRef.current = resetCursorBlink
    resetCursorBlink()
    return () => {
      if (timeout) clearTimeout(timeout)
      setCursorVisible(true)
      resetCursorBlinkRef.current = () => {}
    }
  }, [tui.reducedMotion])

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

  useEffect(() => {
    controller.setExtensionComposer((text) => {
      if (
        overlay ||
        controller.state.pendingRequest ||
        controller.state.turnStatus === "running" ||
        !textareaRef.current ||
        textareaRef.current.plainText.trim()
      )
        return false
      textareaRef.current.setText(text)
      return true
    })
    return () => controller.setExtensionComposer(undefined)
  }, [controller, overlay])

  const lastEscape = useRef(0)
  const restoreInput = useCallback(
    (prompt: AcceptedPrompt, mode: "edit" | "recall" | "pop", revision: string) => {
      const queue = controller.inputQueue
      if (!queue) throw new Error("This engine has no input history")
      if ((textareaRef.current?.plainText ?? "").trim())
        throw new Error("A draft is already in the composer; Ctrl+S stashes it before restoring another")
      if (queue.snapshot().revision !== revision)
        throw new Error("Input state changed; select the entry again")
      if (mode === "edit" && !["queued", "blocked"].includes((prompt as InputItem).status))
        throw new Error("Only queued or blocked input can be edited")
      const input = queue.recall(prompt)
      let text = inputDraftText(input)
      if (mode === "edit") {
        const command = parseSlashCommand(text)
        if (command?.name === "steer" || command?.name === "interject") text = command.argument ?? ""
        setEditingInput({ id: prompt.id, revision, intent: (prompt as InputItem).intent })
      }
      textareaRef.current?.setText(text)
      if (mode === "pop") queue.dropStash(prompt.id, revision)
      setOverlay(undefined)
    },
    [controller],
  )
  const saveCurrentDraft = useCallback(() => {
    const queue = controller.inputQueue
    if (!queue) throw new Error("This engine has no draft stashes")
    const sourceText = textareaRef.current?.plainText ?? "",
      captured = draftRevision.current
    const extracted = extractImageAttachments(sourceText)
    const stash = queue.saveStash(
      `draft-${Date.now()}`,
      { text: extracted.text, sourceText, images: extracted.images },
      queue.snapshot().revision,
    )
    if (draftRevision.current === captured && textareaRef.current?.plainText === sourceText)
      textareaRef.current?.setText("")
    setCommandError(`Saved draft ${stash.name}`)
  }, [controller])

  const resolveRequest = useCallback(
    (choice: string, data?: unknown) => {
      const request = state.pendingRequest
      // "cancel" resolves every request kind (the engine treats it as a dismissal), including
      // ask_user questions whose choices list only the model's own options.
      if (!request || (choice !== "cancel" && !request.choices.includes(choice))) return
      void runCommand(() =>
        controller.resolveRequest(request.id, { choice, ...(data === undefined ? {} : { data }) }),
      )
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

  const startVoice = useCallback(() => {
    if (voiceOwner.current || editorOwner.current) return
    const capture = new VoiceCapture(),
      before = textareaRef.current?.plainText ?? ""
    voiceOwner.current = capture
    void runCommand(async () => {
      try {
        const transcript = await capture.run(preferenceDirectory, project.cwd, setVoicePhase)
        if (capture.phase === "cancelled") return
        if (textareaRef.current?.plainText !== before) {
          setOverlay({
            kind: "resources",
            title: "Dictation · draft changed and was preserved",
            text: transcript,
          })
        } else textareaRef.current?.setText(`${before}${before.trim() ? " " : ""}${transcript}`)
      } finally {
        voiceOwner.current = undefined
        setVoicePhase("")
      }
    })
  }, [preferenceDirectory, project.cwd, runCommand])

  const runSlashCommand = useCallback(
    (command: ParsedSlashCommand) => {
      switch (command.name) {
        case "voice":
          if (command.argument === "start") startVoice()
          else if (command.argument === "stop") voiceOwner.current?.stop()
          else if (command.argument === "cancel") voiceOwner.current?.cancel()
          else if (command.argument === "doctor")
            void runCommand(async () => {
              setOverlay({
                kind: "resources",
                title: "Voice diagnostics",
                text: await voiceDiagnostics(preferenceDirectory, project.cwd),
              })
            })
          else
            setCommandError(
              "Usage: /voice start|stop|cancel|doctor. Recording requires reviewed commands in /terminal.",
            )
          return
        case "btw":
          if (!command.argument) setCommandError("Usage: /btw QUESTION")
          else {
            suggestionOwner.current?.abort()
            setOverlay({ kind: "side", question: command.argument })
          }
          return
        case "suggest":
          if (!suggestion) setCommandError("No suggestion available; enable opt-in suggestions in /config")
          else if (textareaRef.current?.plainText.trim()) setCommandError("Stash the draft first")
          else {
            textareaRef.current?.setText(suggestion)
            setSuggestion("")
          }
          return
        case "config":
          setOverlay({ kind: "settings" })
          return
        case "integrations":
          setOverlay({ kind: "integrations" })
          return
        case "docs":
        case "release-notes":
          setOverlay({ kind: "docs", releaseNotes: command.name === "release-notes" })
          return
        case "onboarding":
          setOverlay({ kind: "onboarding" })
          return
        case "terminal":
          void runCommand(async () => {
            setOverlay({ kind: "terminal-review", review: reviewTerminalIntegrations(preferenceDirectory) })
          })
          return
        case "search":
          setOverlay({ kind: "search", query: command.argument ?? "" })
          return
        case "thinking":
          if (!["show", "collapse", "hide"].includes(command.argument ?? ""))
            setCommandError("Usage: /thinking show|collapse|hide")
          else setTui((current) => ({ ...current, thinking: command.argument as typeof current.thinking }))
          return
        case "screen":
          if (!["alternate", "inline"].includes(command.argument ?? ""))
            setCommandError("Usage: /screen alternate|inline")
          else setTui((current) => ({ ...current, screen: command.argument as typeof current.screen }))
          return
        case "theme":
          void runCommand(async () => {
            const name = command.argument ?? "default"
            if (name === "dark" || name === "light") {
              setBuiltInPalette(brandThemes[name])
              setTui((current) => ({ ...current, theme: "" }))
              setPalette(brandThemes[name])
            } else setPalette(name === "default" ? basePalette : loadUserTheme(preferenceDirectory, name))
          })
          return
        case "image":
          void runCommand(async () => {
            if (!command.argument) throw new Error("Usage: /image PATH")
            const preview = readPreviewImage(command.argument, project.cwd)
            if (process.env.TERM_PROGRAM === "iTerm.app" && !process.env.TMUX) {
              renderer.footerHeight = Math.min(18, Math.max(6, renderer.terminalHeight - 3))
              renderer.screenMode = "split-footer"
              setTui((current) => ({ ...current, screen: "inline" }))
              showItermImage(renderer, preview.name, preview.bytes)
            } else setOverlay({ kind: "image", ...preview })
          })
          return
        case "copy":
          void runCommand(async () => {
            setCommandError(
              await copyText(
                clipboardText(
                  controller.state.transcript,
                  command.argument === undefined ? 1 : Number(command.argument),
                ),
                { mode: tui.clipboard },
              ),
            )
          })
          return
        case "keys":
          setOverlay({
            kind: "resources",
            title: "Keybindings",
            text: `${join(preferenceDirectory, "keybindings.json")}\nVersion 1 · hot reload every 1.5s · Escape/Ctrl+C reserved\n${keymap.current.bindings.map((row) => `${row.context}: ${row.keys} → ${row.action}`).join("\n")}`,
          })
          return
        case "unknown":
          if (engine === "codesplash") void runCommand(() => controller.send({ text: command.raw }))
          else setCommandError(`Unknown command ${command.raw.split(/\s+/)[0]} — try /help`)
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
        case "teams":
        case "dashboard":
          if (!command.argument || command.argument === "list") setOverlay({ kind: "teams" })
          else
            void runCommand(async () => {
              const argument = command.argument!.trim(),
                split = argument.indexOf(" "),
                action = split < 0 ? argument : argument.slice(0, split),
                value = split < 0 ? "" : argument.slice(split + 1)
              let request: TeamRequest
              if (action === "create") request = { action, spec: JSON.parse(value) }
              else if (action === "coordinator")
                request = { action, team: value === "off" ? undefined : value }
              else if (action === "panes" || action === "delete") request = { action, team: value }
              else if (action === "close-panes") request = { action }
              else
                throw new Error(
                  "Usage: /teams [list|create JSON|coordinator TEAM/off|panes TEAM|close-panes|delete TEAM]",
                )
              const result = (await controller.teams(request)) as { text: string; isError?: boolean }
              if (result.isError) throw new Error(result.text)
              setOverlay({ kind: "teams" })
            })
          return
        case "loop":
          void runCommand(async () => {
            const argument = command.argument?.trim() ?? "list"
            const unpack = (raw: unknown) => {
              const result = raw as { text: string; isError?: boolean }
              if (result.isError) throw new Error(result.text)
              return JSON.parse(result.text)
            }
            let result: unknown
            if (argument === "list" || argument === "stop")
              result = unpack(await controller.schedules({ action: argument }))
            else {
              const match = /^(\S+)\s+([\s\S]+)$/.exec(argument)
              if (!match) throw new Error("Usage: /loop list|stop|<interval e.g. 5m> <prompt>")
              intervalMs(match[1])
              result = unpack(
                await controller.schedules({
                  action: "create",
                  enabled: true,
                  spec: {
                    name: `loop-${crypto.randomUUID().slice(0, 8)}`,
                    interval: match[1]!,
                    prompt: match[2]!,
                    limits: { tokens: 65536, timeoutMs: 120000, rounds: 1 },
                    maxOccurrences: 4,
                    totalTokens: 262144,
                    expiresAfterMs: 86400000,
                  },
                }),
              )
              const status = unpack(await controller.schedules({ action: "list" })) as { worker: boolean }
              if (!status.worker) unpack(await controller.schedules({ action: "start", durationMs: 3600000 }))
            }
            setOverlay({
              kind: "resources",
              title: "Recurring prompts",
              text: JSON.stringify(result, null, 2),
            })
          })
          return
        case "tasks":
          if (!command.argument || command.argument === "list") setOverlay({ kind: "tasks" })
          else
            void runCommand(async () => {
              const result = await controller.tasks(taskCommand(command.argument ?? ""))
              setOverlay({ kind: "resources", title: "Task control", text: JSON.stringify(result, null, 2) })
            })
          return
        case "mcp":
          void runCommand(async () => {
            const result = await controller.mcpCommand(command.argument ?? "status")
            setOverlay({ kind: "resources", title: "MCP servers", text: JSON.stringify(result, null, 2) })
          })
          return
        case "plugins":
          void runCommand(async () => {
            const result = await controller.pluginsCommand(command.argument ?? "status")
            setOverlay({
              kind: "resources",
              title: "Installed plugins",
              text: JSON.stringify(result, null, 2),
            })
          })
          return
        case "extensions":
          void runCommand(async () => {
            const result = await controller.extensionsCommand(command.argument ?? "status")
            setOverlay({
              kind: "resources",
              title: "Trusted extensions",
              text: JSON.stringify(result, null, 2),
            })
          })
          return
        case "hooks":
          void runCommand(async () => {
            const result = await controller.hooksCommand(command.argument ?? "status")
            setOverlay({
              kind: "resources",
              title: "Lifecycle hooks",
              text: JSON.stringify({ review: result, recentActivity: state.hookActivities ?? [] }, null, 2),
            })
          })
          return
        case "permissions":
          if (command.argument) {
            const argument = command.argument
            void runCommand(async () => {
              if (!permissions?.editRule) throw new Error("This engine cannot edit permission rules")
              await permissions.editRule(argument)
              openPermissionsOverlay()
            })
            return
          }
          openPermissionsOverlay()
          return
        case "usage":
          setOverlay({ kind: "usage" })
          return
        case "context":
          void runCommand(async () => {
            const context = await controller.inspectContext()
            setOverlay({ kind: "context", context })
          })
          return
        case "remember":
        case "memory":
          void runCommand(async () => {
            const source =
              command.name === "remember"
                ? `remember ${JSON.stringify(command.argument ?? "")}`
                : (command.argument ?? "list")
            setOverlay({
              kind: "resources",
              title: "Repository memory",
              text: await controller.memoryCommand(source),
            })
          })
          return
        case "commands":
        case "skills":
          void runCommand(async () => {
            const resources = await controller.contextResources(
              command.name === "skills" ? "skill" : "command",
            )
            setOverlay({
              kind: "resources",
              title: command.name,
              text: resources.length
                ? resources.map((r) => `${r.name}: ${r.description}\n  ${r.source}: ${r.path}`).join("\n\n")
                : "No enabled resources found.",
            })
          })
          return
        case "personality":
          void runCommand(() => controller.setPersonality(command.argument ?? "neutral"))
          return
        case "create-skill":
          void runCommand(async () => {
            const [name, flag, ...extra] = (command.argument ?? "").split(/\s+/)
            if (!name || (flag && flag !== "--write") || extra.length)
              throw new Error("Usage: /create-skill name [--write]")
            setOverlay({
              kind: "resources",
              title: "Skill scaffold",
              text: await controller.createSkill(name, flag === "--write"),
            })
          })
          return
        case "compact":
          void runCommand(() => controller.compact(command.argument))
          return
        case "session-info":
        case "recap":
        case "rename":
        case "outcomes":
          void runCommand(async () => {
            const args = (command.argument ?? "").split(/\s+/).filter(Boolean)
            const copy = args.includes("--copy")
            if (copy && command.name !== "session-info")
              throw new Error("--copy is available on /session-info")
            const request = presentationArguments(
              command.name === "session-info" ? "info" : (command.name as "recap" | "rename" | "outcomes"),
              args.filter((arg) => arg !== "--copy"),
            )
            const result = await controller.sessionPresentation(request)
            const text = typeof result === "string" ? result : JSON.stringify(result, null, 2)
            if (Buffer.byteLength(text) > 65536)
              throw new Error(
                "Presentation exceeds the 64 KiB display/copy limit; select a smaller outcome range",
              )
            if (copy && !renderer.copyToClipboardOSC52(text))
              throw new Error("This terminal does not support clipboard copying")
            setAwayNotice("")
            setOverlay({ kind: "resources", title: `${command.name}${copy ? " · copied" : ""}`, text })
          })
          break
        case "pwd":
          setOverlay({
            kind: "resources",
            title: "Working directory",
            text: controller.directoryStatus()?.cwd ?? project.cwd,
          })
          return
        case "cd":
          void runCommand(async () => {
            const { directoryCommand } = await import("../core/session/directory-command.ts")
            const result = await controller.changeDirectory(directoryCommand(command.argument ?? ""))
            if (result.applied) {
              const { inspectProject } = await import("../core/preflight.ts")
              setProject(await inspectProject(result.cwd))
            }
            setOverlay({
              kind: "resources",
              title: result.applied ? "Working directory changed" : "Working-directory preview",
              text: JSON.stringify(result, null, 2),
            })
          })
          return
        case "feedback":
          void runCommand(async () => {
            const { exportDiagnostics, replayDiagnostics } = await import("../core/diagnostics.ts")
            setOverlay({
              kind: "resources",
              title: "Diagnostic feedback",
              text:
                JSON.stringify(replayDiagnostics(exportDiagnostics()), null, 2) +
                "\nExport: codesplash feedback export FILE\nReview the file, then send explicitly with: codesplash feedback send FILE --url HTTPS_URL --yes",
            })
          })
          return
        case "share":
        case "unshare":
          void runCommand(async () => {
            const result = await controller.runCommand(
              `/${command.name}${command.argument ? ` ${command.argument}` : ""}`,
            )
            setOverlay({ kind: "resources", title: "Session sharing", text: JSON.stringify(result, null, 2) })
          })
          return
        case "export":
          void runCommand(async () => {
            const { parse } = await import("shell-quote")
            const args = parse(command.argument ?? "", (key) => `$${key}`)
            if (args.some((arg) => typeof arg !== "string"))
              throw new Error("Export accepts literal arguments only")
            const { exportArguments } = await import("../commands/session-portable.ts")
            const { renderPortable, writePortable } = await import("../core/session/portable.ts")
            const { options, format, path } = exportArguments(
              args as string[],
              controller.directoryStatus()?.cwd ?? project.cwd,
            )
            const bundle = await controller.exportHistory(options)
            if (path) writePortable(path, renderPortable(bundle, format))
            setOverlay({
              kind: "resources",
              title: "Session export",
              text: path
                ? `Saved ${path}\n${bundle.payload.omissions.join("\n")}`
                : renderPortable(bundle, format),
            })
          })
          return
        case "tree":
          void runCommand(async () => {
            const result = await controller.sessionRecovery({ action: "tree" })
            setOverlay({ kind: "recovery", tree: result.data as BranchView })
          })
          return
        case "acknowledge-fork":
        case "gc-recovery":
        case "fork":
        case "rewind":
        case "checkpoints":
        case "hunks":
        case "accept-hunk":
        case "reject-hunk":
        case "checkpoint-diff":
        case "restore":
        case "recover-restore":
        case "pin-branch":
        case "pin-checkpoint":
        case "prune-branches":
        case "prune-checkpoints":
          void runCommand(async () => {
            const result = await controller.sessionRecovery(
              recoveryCommand(command.name, command.argument ?? ""),
            )
            setOverlay({ kind: "resources", title: result.title, text: JSON.stringify(result.data, null, 2) })
          })
          return
        case "queue":
        case "prompt-history":
          if (!controller.inputQueue) {
            setCommandError("This engine does not expose an input queue")
            return
          }
          setOverlay({ kind: "input", tab: command.name === "queue" ? "queue" : "history" })
          return
        case "stash":
          void runCommand(async () => {
            const queue = controller.inputQueue
            if (!queue) throw new Error("This engine has no draft stashes")
            const [action = "list", id, ...rest] = (command.argument ?? "").split(/\s+/)
            if (action === "list" || action === "") {
              setOverlay({ kind: "input", tab: "stash" })
              return
            }
            if (action === "save" && id && rest.length) {
              queue.saveStash(id, { text: rest.join(" ") }, queue.snapshot().revision)
              setOverlay({ kind: "input", tab: "stash" })
              return
            }
            if (id && (action === "apply" || action === "pop")) {
              restoreInput(queue.stash(id), action === "pop" ? "pop" : "recall", queue.snapshot().revision)
              return
            }
            if (action === "drop" && id) {
              queue.dropStash(id, queue.snapshot().revision)
              return
            }
            throw new Error("Usage: /stash list|save NAME TEXT|apply ID|pop ID|drop ID")
          })
          return
        case "steer":
        case "interject":
          void runCommand(async () => {
            if (!command.argument) throw new Error(`/${command.name} requires a prompt`)
            await controller.submit(
              { text: command.argument },
              command.name === "steer" ? "steering" : "interject",
            )
          })
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
    [
      controller,
      engine,
      historyLocation,
      onAction,
      openModelOverlay,
      openPermissionsOverlay,
      runCommand,
      restoreInput,
      permissions,
      project.cwd,
      renderer,
      state.hookActivities,
      tui.clipboard,
      preferenceDirectory,
      basePalette,
      suggestion,
      startVoice,
    ],
  )

  const openPalette = () => {
    const draft = textareaRef.current?.plainText ?? ""
    setOverlay({
      kind: "palette",
      query: draft.startsWith("/") ? draft : "",
      draft,
      revision: draftRevision.current,
      models: [],
    })
    if (controller.canSwitchModels)
      void controller
        .listModels()
        .then((models) => {
          setOverlay((current) =>
            current?.kind === "palette" ? { ...current, models: models.map((model) => model.id) } : current,
          )
        })
        .catch(() => {})
  }
  const openEditor = () => {
    if (editorOwner.current || voiceOwner.current || overlay) return
    const text = textareaRef.current?.plainText ?? "",
      revision = draftRevision.current
    const owner = new AbortController()
    editorOwner.current = owner
    void runCommand(async () => {
      try {
        const result = await editDraft({ text, cwd: project.cwd, renderer, signal: owner.signal })
        if (owner.signal.aborted) return
        if (draftRevision.current !== revision || textareaRef.current?.plainText !== text)
          throw new Error("Draft changed while editor was open; current draft preserved")
        textareaRef.current?.setText(result)
      } finally {
        editorOwner.current = undefined
      }
    })
  }

  useKeyboard(
    (key) => {
      if (key.eventType === "release") {
        if (key.name === "f4") {
          key.preventDefault()
          voiceOwner.current?.stop()
        }
        return
      }
      if (key.name === "f4" && !overlay && (!state.pendingRequest || !approvalFocus)) {
        key.preventDefault()
        if (key.repeated) return
        if (voiceOwner.current) voiceOwner.current.stop()
        else startVoice()
        return
      }
      if (key.name === "escape" && voiceOwner.current && !overlay) {
        key.preventDefault()
        voiceOwner.current.cancel()
        return
      }
      const now = Date.now(),
        previous = activity.current
      if (awayRecap(previous.time, now, !!state.pendingRequest, previous.sequence, state.lastSequence))
        setAwayNotice(
          state.outcomes?.rows
            .filter((row) => row.status !== "running" && row.lastSequence > previous.sequence)
            .slice(-3)
            .map(outcomeSummary)
            .join(" · ") || "Session activity was recorded",
        )
      activity.current = { time: now, sequence: state.lastSequence }
      if (key.ctrl && key.name === "c") {
        key.preventDefault()
        onAction("home")
        return
      }

      const ownedOverlay = !!(
        overlay &&
        [
          "palette",
          "search",
          "settings",
          "integrations",
          "docs",
          "onboarding",
          "terminal-review",
          "side",
        ].includes(overlay.kind)
      )
      const context = overlay ? "overlay" : state.pendingRequest && approvalFocus ? "approval" : "composer"
      if (
        tui.vim &&
        context === "composer" &&
        textareaRef.current &&
        vim.current.handle(key, textareaRef.current)
      ) {
        key.preventDefault()
        setInputMode(vim.current.mode)
        return
      }
      const action = keymap.current.resolve(keyToken(key), context, Date.now(), !ownedOverlay)
      if (action === "pending" || action === "none") {
        key.preventDefault()
        return
      }
      if (action === "submit" || action === "newline") {
        key.preventDefault()
        if (context === "composer") {
          if (action === "submit") textareaRef.current?.submit()
          else textareaRef.current?.insertText("\n")
        }
        return
      }
      if (action === "home") {
        key.preventDefault()
        onAction("home")
        return
      }
      if (action === "palette") {
        key.preventDefault()
        openPalette()
        return
      }
      if (action === "editor") {
        key.preventDefault()
        openEditor()
        return
      }
      if (key.name === "tab" && !key.shift && !overlay && (!state.pendingRequest || !approvalFocus)) {
        const draft = textareaRef.current?.plainText ?? ""
        if (draft.startsWith("/") && !draft.startsWith("/extensions run ")) {
          const matches = commandSuggestions(draft)
          if (matches.length === 1) {
            key.preventDefault()
            textareaRef.current?.setText(`${matches[0]!.value} `)
            return
          }
          if (matches.length || draft.startsWith("/model ")) {
            key.preventDefault()
            openPalette()
            return
          }
        }
      }

      if (action === "background") {
        key.preventDefault()
        void controller.tasks({ action: "background" }).catch((error) => setCommandError(String(error)))
        return
      }
      if (action === "stash" && controller.inputQueue) {
        key.preventDefault()
        void runCommand(async () => saveCurrentDraft())
        return
      }
      if (action === "history" && !reconnectPending && controller.inputQueue) {
        key.preventDefault()
        setOverlay({ kind: "input", tab: "history" })
        return
      }
      if (key.name === "tab" && !key.shift && state.pendingRequest && controller.inputQueue && !overlay) {
        key.preventDefault()
        setApprovalFocus((value) => !value)
        return
      }
      if (key.name === "escape" && editingInput && !overlay) {
        key.preventDefault()
        setEditingInput(undefined)
        setCommandError("Queue edit cancelled; draft retained")
        return
      }
      if (action === "suspend") {
        key.preventDefault()
        suspendToShell(renderer)
        return
      }

      if (action === "help") {
        key.preventDefault()
        setOverlay((current) => (current?.kind === "help" ? undefined : { kind: "help" }))
        return
      }

      // Shift+Tab cycles the permission mode even with the /permissions overlay open, so the
      // overlay's mode line updates live. Terminals encode it as CSI Z, parsed as shift+"tab".
      if (action === "permission") {
        key.preventDefault()
        cyclePermissionMode()
        return
      }

      if (
        key.name === "tab" &&
        !key.shift &&
        !overlay &&
        !state.pendingRequest &&
        state.turnStatus !== "running" &&
        engine === "codesplash"
      ) {
        const readDraft = () => ({
          text: textareaRef.current?.plainText ?? "",
          cursor: textareaRef.current?.cursorOffset ?? 0,
          revision: draftRevision.current,
        })
        const extensionDraft = /^\/extensions run (\S+)(?: (.*))?$/.exec(readDraft().text)
        if (extensionDraft) {
          key.preventDefault()
          const before = readDraft()
          void runCommand(async () => {
            const result = (await controller.extensionsCommand(
              `complete ${extensionDraft[1]} ${extensionDraft[2] ?? ""}`,
            )) as { completions: string[] }
            const current = readDraft()
            if (
              current.text !== before.text ||
              current.revision !== before.revision ||
              controller.state.pendingRequest
            )
              return
            if (result.completions.length === 1)
              textareaRef.current?.setText(`/extensions run ${extensionDraft[1]} ${result.completions[0]}`)
            else
              setOverlay({
                kind: "resources",
                title: "Extension completions",
                text: result.completions.join("\n") || "No completions",
              })
          })
          return
        }
        if (trailingMention(readDraft())) {
          key.preventDefault()
          void runCommand(() =>
            completeMentionDraft(
              readDraft,
              (query) => controller.completeFileMention(query),
              (text) => textareaRef.current?.setText(text),
              () => controller.state.turnStatus !== "running" && !controller.state.pendingRequest,
            ),
          )
          return
        }
      }

      if (ownedOverlay) return
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

      if (action === "latest") {
        key.preventDefault()
        jumpToLatest()
        return
      }

      if (action === "outline") {
        key.preventDefault()
        toggleOutline()
        return
      }

      if ((key.option || key.meta) && (key.name === "up" || key.name === "down")) {
        key.preventDefault()
        moveBetweenSections(key.name === "up" ? -1 : 1)
        return
      }

      if (state.pendingRequest && approvalFocus) {
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

      if (key.name === "escape" && !state.pendingRequest && state.turnStatus !== "running") {
        key.preventDefault()
        const now = Date.now()
        if (now - lastEscape.current < 600) {
          lastEscape.current = 0
          void runCommand(async () => {
            const result = await controller.sessionRecovery({ action: "tree" })
            setOverlay({ kind: "recovery", tree: result.data as BranchView })
          })
        } else lastEscape.current = now
        return
      }

      if (key.ctrl && key.name === "r" && reconnectPending) {
        key.preventDefault()
        onAction("reconnect")
      }
    },
    { release: true },
  )

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
          scrollAcceleration={scrollAcceleration}
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
            state.transcript
              .filter(
                (item) =>
                  (tui.screen !== "inline" || item.status === "running") &&
                  (item.kind !== "reasoning" || tui.thinking !== "hide"),
              )
              .map((item) => (
                <TranscriptEntry
                  key={item.id}
                  item={item}
                  palette={palette}
                  syntaxStyle={syntaxStyle}
                  engineName={engineDisplayName(engine)}
                  thinking={tui.thinking}
                  cwd={project.cwd}
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

      {tui.screen !== "inline" && showPlanPanel(terminalHeight, state.plan.length) ? (
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

      {(state.extensionUi ?? [])
        .filter((item) => item.operation === "status" || item.operation === "widget")
        .slice(-8)
        .map((item) => (
          <text
            key={`${item.owner}:${item.generation}:${item.operation}:${item.key}`}
            fg={palette.muted}
            style={{ flexShrink: 0 }}
          >
            {`[${item.owner}] ${item.text
              .split("\n")
              .slice(0, item.operation === "status" ? 1 : 4)
              .join("\n")}`}
          </text>
        ))}
      {awayNotice && <text fg={palette.muted}>While away: {awayNotice}. /recap shows more.</text>}
      {suggestion && <text fg={palette.muted}>Suggested next prompt: {suggestion} · /suggest stages it</text>}
      {voicePhase && (
        <text fg={palette.action}>
          Microphone · {voicePhase} · F4 or /voice stop finishes · Esc cancels · never auto-sends
        </text>
      )}
      {(state.outcomes ?? emptyOutcomes()).rows.at(-1)?.status !== "running" &&
        state.outcomes?.rows.at(-1) && (
          <text fg={palette.muted}>
            {outcomeSummary(state.outcomes.rows.at(-1) as import("../core/session/outcomes.ts").TurnOutcome)}
          </text>
        )}
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
          focused={!overlay && (!state.pendingRequest || !approvalFocus) && !reconnectPending}
          placeholder={styledComposerPlaceholder}
          textColor={palette.foreground}
          placeholderColor={palette.muted}
          cursorColor={palette.accent}
          cursorStyle={composerCursorStyle}
          backgroundColor={palette.secondary}
          focusedBackgroundColor={palette.secondary}
          keyBindings={composerKeyBindings}
          style={{ flexGrow: 1, height: "100%" }}
          onContentChange={() => {
            suggestionOwner.current?.abort()
            draftRevision.current++
            resetCursorBlinkRef.current()
          }}
          onCursorChange={() => {
            draftRevision.current++
            resetCursorBlinkRef.current()
          }}
          onSubmit={() => {
            const sourceText = textareaRef.current?.plainText ?? "",
              captured = draftRevision.current
            if (!sourceText.trim()) return
            if (sourceText.startsWith("!")) {
              const excluded = sourceText.startsWith("!!")
              void runCommand(async () => {
                const result = await controller.runCommand(
                  sourceText.slice(excluded ? 2 : 1).trim(),
                  !excluded,
                )
                setOverlay({
                  kind: "resources",
                  title: excluded ? "Command · excluded from model context" : "Command",
                  text: JSON.stringify(result, null, 2),
                })
                if (draftRevision.current === captured) textareaRef.current?.clear()
              })
              return
            }
            const command = parseSlashCommand(sourceText)
            const intent: InputIntent =
              command?.name === "steer"
                ? "steering"
                : command?.name === "interject"
                  ? "interject"
                  : "follow-up"
            if (
              !editingInput &&
              command &&
              intent === "follow-up" &&
              !(command.name === "unknown" && engine === "codesplash")
            ) {
              setCommandError(undefined)
              textareaRef.current?.setText("")
              runSlashCommand(command)
              return
            }
            const extracted = extractImageAttachments(
              intent !== "follow-up" && command && command.name !== "unknown"
                ? (command.argument ?? "")
                : sourceText,
            )
            void runCommand(async () => {
              const input = {
                text: extracted.text,
                sourceText,
                images: extracted.images.length ? extracted.images : undefined,
              }
              if (editingInput) {
                const queue = controller.inputQueue
                if (!queue) throw new Error("Input queue unavailable")
                queue.edit(editingInput.id, input, editingInput.revision, editingInput.intent)
              } else await controller.submit(input, intent)
            }).then((sent) => {
              if (
                sent &&
                draftRevision.current === captured &&
                textareaRef.current?.plainText === sourceText
              ) {
                textareaRef.current.setText("")
                setEditingInput(undefined)
                if (controller.state.pendingRequest) setApprovalFocus(true)
                if (extracted.warnings.length) setCommandError(extracted.warnings.join(" · "))
              }
            })
          }}
        />
      </box>

      <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between" }}>
        <text fg={error ? palette.destructive : palette.muted}>
          {error ?? statusHelp(state, supportsReconnect)}
          {tui.vim ? ` · ${inputMode}` : ""}
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

      <Attention
        settings={tui}
        state={state}
        project={project.name}
        cwd={project.cwd}
        directory={preferenceDirectory}
        palette={palette}
        enabled={!!config}
      />
      {tui.tips &&
        (showStartupTip || state.pendingRequest || state.turnStatus === "running") &&
        tui.screen !== "inline" &&
        terminalHeight >= 28 && (
          <text fg={palette.muted} style={{ height: 1 }}>
            {contextualTip(state)}
          </text>
        )}

      <SessionOverlay
        overlay={overlay}
        palette={palette}
        policy={policy}
        historyLocation={historyLocation}
        state={state}
        permissions={permissions}
      />
      {overlay?.kind === "palette" && (
        <CommandPalette
          initialQuery={overlay.query}
          models={overlay.models}
          palette={palette}
          onClose={() => setOverlay(undefined)}
          onSelect={(value) => {
            if (
              draftRevision.current !== overlay.revision ||
              textareaRef.current?.plainText !== overlay.draft
            ) {
              setCommandError("Draft changed; command was not inserted")
            } else if (overlay.draft.trim() && !overlay.draft.startsWith("/")) {
              setCommandError("Stash the current draft with Ctrl+S before inserting a command")
            } else textareaRef.current?.setText(value)
            setOverlay(undefined)
          }}
        />
      )}
      {overlay?.kind === "terminal-review" && (
        <ConfirmPanel
          title="Trust terminal integrations"
          palette={palette}
          text={`These commands run as your user on this machine. Status receives redacted state on stdin. Voice runs only when explicitly started.\n\n${terminalText(JSON.stringify(overlay.review.config), 65536)}\n\nResolved executables: ${overlay.review.executables.join(", ")}\nFingerprint: ${overlay.review.fingerprint}\nCurrently trusted: ${overlay.review.trusted}`}
          onClose={() => setOverlay(undefined)}
          onConfirm={() => {
            void runCommand(async () => {
              trustTerminalIntegrations(preferenceDirectory, overlay.review.fingerprint)
              setOverlay(undefined)
            })
          }}
        />
      )}
      {overlay?.kind === "onboarding" && (
        <ConfirmPanel
          title="Getting started"
          palette={palette}
          text={onboardingText}
          onClose={() => setOverlay(undefined)}
          onConfirm={() => {
            void runCommand(async () => {
              atomic(
                join(preferenceDirectory, "onboarding.json"),
                JSON.stringify({ version: 1, completed: true }),
              )
              setOverlay(undefined)
            })
          }}
        />
      )}
      {overlay?.kind === "settings" && (
        <SettingsPanel
          base={config ?? defaultConfig}
          cwd={project.cwd}
          palette={palette}
          onClose={() => setOverlay(undefined)}
          onChange={(next) => {
            setTui({ ...tuiDefaults, ...next.tui })
            setBuiltInPalette(next.theme === "system" ? basePalette : brandThemes[next.theme])
          }}
        />
      )}
      {overlay?.kind === "integrations" && (
        <IntegrationsPanel
          controller={controller}
          palette={palette}
          onClose={() => setOverlay(undefined)}
          onStage={(text) => {
            if (textareaRef.current?.plainText.trim())
              setCommandError("Stash the draft with Ctrl+S before selecting a skill")
            else textareaRef.current?.setText(text)
            setOverlay(undefined)
          }}
        />
      )}
      {overlay?.kind === "docs" && (
        <DocsPanel
          releaseNotes={overlay.releaseNotes}
          palette={palette}
          syntaxStyle={syntaxStyle}
          onClose={() => setOverlay(undefined)}
        />
      )}
      {overlay?.kind === "side" && (
        <SidePanel
          controller={controller}
          question={overlay.question}
          palette={palette}
          syntaxStyle={syntaxStyle}
          onClose={() => setOverlay(undefined)}
        />
      )}
      {overlay?.kind === "search" && (
        <SearchPanel
          transcript={state.transcript}
          initialQuery={overlay.query}
          palette={palette}
          onClose={() => setOverlay(undefined)}
          onSelect={(item) => {
            setOverlay(undefined)
            if (tui.screen === "inline") setTui((current) => ({ ...current, screen: "alternate" }))
            if (item.kind === "reasoning") setTui((current) => ({ ...current, thinking: "show" }))
            setTimeout(() => {
              if (scrollboxRef.current)
                scrollToTranscriptSection(scrollboxRef.current, transcriptAnchorId(item.id))
              setSelectedOutlineId(item.id)
            }, 0)
          }}
        />
      )}
      {overlay?.kind === "image" && (
        <box
          style={{
            position: "absolute",
            top: 1,
            left: "10%",
            width: "80%",
            height: "80%",
            zIndex: 40,
            backgroundColor: palette.popover,
            border: true,
          }}
        >
          <text fg={palette.accent}>{overlay.name} · Esc closes · graphics or block fallback</text>
          <image
            source={overlay.bytes}
            protocol="auto"
            fit="fit"
            style={{ flexGrow: 1 }}
            onError={(error) => setCommandError(`Image: ${String(error)}`)}
          />
        </box>
      )}
      {overlay?.kind === "recovery" ? (
        <RecoveryPanel
          controller={controller}
          initial={overlay.tree}
          palette={palette}
          onClose={() => setOverlay(undefined)}
          onDraft={(prompt, revision) => restoreInput(prompt, "recall", revision)}
        />
      ) : null}
      {editingInput ? (
        <text fg={palette.accent}>Editing queued input · Enter saves · Esc keeps this draft</text>
      ) : null}
      {overlay?.kind === "teams" && (
        <TeamPanel
          controller={controller}
          palette={palette}
          onClose={() => setOverlay(undefined)}
          onAction={async (request) => {
            if (request.action === "dispatch") setOverlay(undefined)
            try {
              const result = (await controller.teams(request)) as { text: string; isError?: boolean }
              if (result.isError) throw new Error(result.text)
            } catch (error) {
              setOverlay({
                kind: "resources",
                title: "Team action failed",
                text: error instanceof Error ? error.message : String(error),
              })
              return
            }
            setOverlay({ kind: "teams" })
          }}
        />
      )}
      {overlay?.kind === "tasks" && (
        <TaskPanel controller={controller} palette={palette} onClose={() => setOverlay(undefined)} />
      )}
      {overlay?.kind === "input" && controller.inputQueue && state.inputQueue ? (
        <InputPanel
          queue={controller.inputQueue}
          snapshot={state.inputQueue}
          tab={overlay.tab}
          palette={palette}
          onRestore={restoreInput}
          onClose={() => setOverlay(undefined)}
        />
      ) : null}
      {!overlay && state.pendingRequest?.requestKind === "elicitation" && state.pendingRequest.form ? (
        <McpFormPanel
          key={state.pendingRequest.id}
          form={state.pendingRequest.form}
          palette={palette}
          active={approvalFocus}
          onDecision={resolveRequest}
        />
      ) : (
        <Approval
          request={overlay ? undefined : state.pendingRequest}
          palette={palette}
          active={approvalFocus}
          queueing={Boolean(controller.inputQueue)}
        />
      )}
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
  if (
    !overlay ||
    overlay.kind === "palette" ||
    overlay.kind === "terminal-review" ||
    overlay.kind === "settings" ||
    overlay.kind === "integrations" ||
    overlay.kind === "docs" ||
    overlay.kind === "onboarding" ||
    overlay.kind === "side" ||
    overlay.kind === "search" ||
    overlay.kind === "image" ||
    overlay.kind === "teams" ||
    overlay.kind === "tasks" ||
    overlay.kind === "input" ||
    overlay.kind === "recovery"
  )
    return null

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
        {permissions.sandboxStatus ? <text fg={palette.muted}>{permissions.sandboxStatus()}</text> : null}
        {permissions.editRule ? (
          <text fg={palette.muted}>
            Edit: /permissions add|delete|replace user|project|grants allow|ask|deny rule (replace: old =&gt;
            new)
          </text>
        ) : null}
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

  if (overlay.kind === "resources") {
    return (
      <box title={`${overlay.title} · Esc closes`} style={frame}>
        <scrollbox style={{ flexGrow: 1 }}>
          <text fg={palette.foreground}>{overlay.text}</text>
        </scrollbox>
      </box>
    )
  }

  if (overlay.kind === "context") {
    return (
      <box title="Model context · Esc closes" style={frame}>
        {buildContextOverlayLines(overlay.context).map((line) => (
          <text key={line.label} fg={palette.foreground}>
            {line.label.padEnd(20)} {line.value}
          </text>
        ))}
        <text fg={palette.muted}>
          Local token estimates; images are approximate. /compact reduces older context.
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
  cwd,
  item,
  palette,
  syntaxStyle,
  engineName = "Codex",
  thinking = "show",
}: {
  cwd: string
  item: TranscriptItem
  palette: BrandPalette
  syntaxStyle: SyntaxStyle
  engineName?: string
  thinking?: string
}) {
  const anchorId = transcriptAnchorId(item.id)
  const rendered = useMemo(
    () => (item.status === "running" ? item.text : markdownFileCitations(terminalMarkdown(item.text), cwd)),
    [item.text, item.status, cwd],
  )
  if (item.kind === "reasoning" && thinking === "collapse")
    return (
      <text id={anchorId} fg={palette.muted}>
        {engineName} thinking · {item.status} · /thinking show
      </text>
    )

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
            content={rendered}
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

function Approval({
  request,
  palette,
  active = true,
  queueing = false,
}: {
  request?: PendingRequest
  palette: BrandPalette
  active?: boolean
  queueing?: boolean
}) {
  if (!request) return null
  const tag = approvalTagLine(request)

  return (
    <box
      title={request.title}
      style={{
        position: "absolute",
        width: "76%",
        minHeight: active ? 9 : 3,
        left: "12%",
        top: active ? "32%" : 2,
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
      {!active ? (
        <text fg={palette.action}>
          Approval waiting · Tab returns to choices. Composer input queues a follow-up.
        </text>
      ) : request.requestKind === "user-input" ? (
        <>
          {request.choices.map((choice, index) => (
            <text key={`${index}:${choice}`} fg={palette.foreground}>
              {index + 1} {choice}
            </text>
          ))}
          <text fg={palette.action}>1-{request.choices.length} answer · Esc dismiss</text>
        </>
      ) : (
        <text fg={palette.action}>
          {approvalKeyHint(request)}
          {queueing ? " · Tab writes a follow-up" : ""}
        </text>
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
  if (request.requestKind === "elicitation") return undefined
  if (request.requestKind === "user-input") {
    if (name === "c") return "cancel"
    if (!/^[1-9]$/.test(name)) return undefined
    return request.choices[Number(name) - 1]
  }
  return approvalKeyChoices[name]?.find((choice) => request.choices.includes(choice))
}

function statusHelp(state: AppViewState, supportsReconnect: boolean): string {
  if (state.error?.recoverable && supportsReconnect) return "Ctrl+R reconnect · Ctrl+Q home"
  if (state.inputQueue?.paused) return "Input queue paused · /queue to review and resume · Ctrl+Q home"
  if (state.turnStatus === "running")
    return state.inputQueue
      ? "Enter queues follow-up · /queue · /steer · /interject · Esc interrupts"
      : "Esc interrupt · Ctrl+Q home"
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

export function buildContextOverlayLines(
  context: ContextInspection,
): Array<{ label: string; value: string }> {
  return [
    { label: "Model", value: context.model },
    { label: "Context window", value: String(context.contextWindow) },
    { label: "System (estimated)", value: String(context.systemTokens) },
    ...(context.memoryTokens === undefined
      ? []
      : [
          {
            label: "Memory (in system)",
            value: `${context.memoryTokens} estimated tokens · ${context.memoryMode ?? "lexical"}`,
          },
        ]),
    { label: "Tools (estimated)", value: String(context.toolTokens) },
    { label: "Messages (estimated)", value: `${context.messageTokens} (${context.messageCount} messages)` },
    { label: "Input (calibrated)", value: String(context.totalTokens) },
    { label: "Input budget", value: String(context.inputBudget) },
    { label: "Output reserve", value: String(context.outputReserve) },
    {
      label: "Last measured input",
      value: context.observedInputTokens === undefined ? "Unavailable" : String(context.observedInputTokens),
    },
    { label: "Context epoch", value: String(context.epoch) },
    { label: "Prefix changes", value: context.prefixChanges.join(", ") || "None" },
  ]
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
    ...(state.usage.embeddingInputTokens === undefined
      ? []
      : [{ label: "Embedding input", value: String(state.usage.embeddingInputTokens) }]),
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
