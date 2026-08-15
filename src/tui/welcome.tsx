import type { ThemeMode } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useState } from "react"
import type { EngineProbe, ThemePreference } from "../core/index.ts"
import { ClaudeDriver } from "../engines/claude/index.ts"
import { CodexDriver } from "../engines/codex/index.ts"
import {
  type BrandPalette,
  brandLockupMode,
  brandThemes,
  waveLogo,
  wordmarkAgent,
  wordmarkCodeSplash,
} from "./brand.ts"

export type WelcomeAction = "login-codex" | "open-codex" | "launch-claude" | "quit"

type AgentChoice = "codex" | "claude"
type FooterChoice = "theme" | "recheck" | "quit"
type FocusZone = "agents" | "footer"

type ProviderState = {
  codex: EngineProbe | undefined
  claude: EngineProbe | undefined
  error?: string
  checking: boolean
}

type WelcomeAppProps = {
  detectedTheme: ThemeMode
  initialThemePreference: ThemePreference
  onAction(action: WelcomeAction): void
  onThemePreferenceChange(theme: ThemePreference): Promise<void>
}

const agentChoices: readonly AgentChoice[] = ["codex", "claude"]
const footerChoices: readonly FooterChoice[] = ["theme", "recheck", "quit"]

export function WelcomeApp({
  detectedTheme: initialDetectedTheme,
  initialThemePreference,
  onAction,
  onThemePreferenceChange,
}: WelcomeAppProps) {
  const renderer = useRenderer()
  const { width: terminalWidth } = useTerminalDimensions()
  const [providers, setProviders] = useState<ProviderState>({
    codex: undefined,
    claude: undefined,
    checking: true,
  })
  const [detectedTheme, setDetectedTheme] = useState(initialDetectedTheme)
  const [themePreference, setThemePreference] = useState(initialThemePreference)
  const [focusZone, setFocusZone] = useState<FocusZone>("agents")
  const [selectedAgent, setSelectedAgent] = useState(0)
  const [selectedFooter, setSelectedFooter] = useState(0)
  const themeMode = themePreference === "system" ? detectedTheme : themePreference
  const palette = brandThemes[themeMode]
  const lockupMode = brandLockupMode(terminalWidth)

  const probe = useCallback(async () => {
    setProviders((current) => ({ ...current, checking: true, error: undefined }))
    const [codex, claude] = await Promise.all([new CodexDriver().probe(), new ClaudeDriver().probe()])
    setProviders({ codex, claude, checking: false })
  }, [])

  const toggleTheme = useCallback(async () => {
    const nextTheme: ThemePreference = themeMode === "dark" ? "light" : "dark"
    const previousTheme = themePreference
    setThemePreference(nextTheme)
    try {
      await onThemePreferenceChange(nextTheme)
    } catch (error) {
      setThemePreference(previousTheme)
      setProviders((current) => ({
        ...current,
        error: `Could not save theme: ${error instanceof Error ? error.message : String(error)}`,
      }))
    }
  }, [onThemePreferenceChange, themeMode, themePreference])

  useEffect(() => {
    renderer.setBackgroundColor(palette.background)
  }, [palette.background, renderer])

  useEffect(() => {
    const onThemeMode = (mode: ThemeMode) => setDetectedTheme(mode)
    renderer.on("theme_mode", onThemeMode)
    return () => {
      renderer.off("theme_mode", onThemeMode)
    }
  }, [renderer])

  useEffect(() => {
    void probe().catch((error) => {
      setProviders((current) => ({
        ...current,
        checking: false,
        error: error instanceof Error ? error.message : String(error),
      }))
    })
  }, [probe])

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      onAction("quit")
      return
    }
    if (key.name === "q" || key.name === "escape") {
      key.preventDefault()
      onAction("quit")
      return
    }
    if (key.name === "t") {
      key.preventDefault()
      void toggleTheme()
      return
    }
    if (key.name === "r") {
      key.preventDefault()
      void probe()
      return
    }
    if (key.name === "l" && !providers.codex?.authenticated) {
      key.preventDefault()
      onAction("login-codex")
      return
    }

    if (focusZone === "agents") {
      if (key.name === "up") {
        key.preventDefault()
        setSelectedAgent((current) => Math.max(0, current - 1))
        return
      }
      if (key.name === "down") {
        key.preventDefault()
        if (selectedAgent === agentChoices.length - 1) {
          setSelectedFooter(0)
          setFocusZone("footer")
        } else {
          setSelectedAgent((current) => current + 1)
        }
        return
      }
      if (key.name === "return" || key.name === "enter") {
        key.preventDefault()
        const choice = agentChoices[selectedAgent]
        if (choice === "codex" && !providers.codex?.authenticated) {
          onAction("login-codex")
        }
        if (choice === "codex" && providers.codex?.authenticated && providers.codex.compatible !== false) {
          onAction("open-codex")
        }
        if (choice === "codex" && providers.codex?.authenticated && providers.codex.compatible === false) {
          setProviders((current) => ({
            ...current,
            error: current.codex?.detail ?? "The installed Codex CLI version is not supported.",
          }))
        }
        if (choice === "claude") onAction("launch-claude")
        return
      }
      return
    }

    if (key.name === "up") {
      key.preventDefault()
      setSelectedAgent(agentChoices.length - 1)
      setFocusZone("agents")
      return
    }
    if (key.name === "left" || key.name === "right" || key.name === "tab") {
      key.preventDefault()
      const direction = key.name === "left" || (key.name === "tab" && key.shift) ? -1 : 1
      setSelectedFooter((current) => (current + direction + footerChoices.length) % footerChoices.length)
      return
    }
    if (key.name === "return" || key.name === "enter") {
      key.preventDefault()
      const choice = footerChoices[selectedFooter]
      if (choice === "theme") void toggleTheme()
      if (choice === "recheck") void probe()
      if (choice === "quit") onAction("quit")
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
      <box style={{ width: "94%", maxWidth: 112, alignItems: "center" }}>
        <box
          style={{ height: 6, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 3 }}
        >
          <text fg={palette.accent} style={{ width: 13, height: 6 }}>
            <b>{waveLogo}</b>
          </text>
          {lockupMode !== "logo" ? (
            <text fg={palette.foreground} style={{ height: 5 }}>
              <b>{wordmarkCodeSplash}</b>
            </text>
          ) : null}
          {lockupMode === "full" ? (
            <text fg={palette.accent} style={{ height: 5 }}>
              <b>{wordmarkAgent}</b>
            </text>
          ) : null}
        </box>
        <text fg={palette.action}>YOUR ENTIRE DEV WORKDAY. ONE TERMINAL.</text>
        <text fg={palette.muted}>
          {lockupMode === "logo"
            ? "BRING YOUR OWN AI"
            : "BRING YOUR OWN AI · CREDENTIALS STAY ON YOUR MACHINE"}
        </text>

        <text fg={palette.accent} style={{ width: "100%", marginTop: 1 }}>
          AI ACCOUNTS
        </text>
        <box
          style={{
            width: "100%",
            height: 4,
            justifyContent: "center",
            backgroundColor: palette.panel,
            paddingLeft: 1,
            paddingRight: 1,
          }}
        >
          <ProviderRow
            name="CODEX"
            probe={providers.codex}
            checking={providers.checking}
            palette={palette}
            selected={focusZone === "agents" && selectedAgent === 0}
            versionOnly
          />
          <ProviderRow
            name="CLAUDE CODE"
            probe={providers.claude}
            checking={providers.checking}
            palette={palette}
            selected={focusZone === "agents" && selectedAgent === 1}
            versionOnly
          />
        </box>

        {providers.error ? <text fg={palette.destructive}>{providers.error}</text> : null}
        <box style={{ height: 1, marginTop: 1, flexDirection: "row", gap: 2 }}>
          {footerChoices.map((choice, index) => {
            const selected = focusZone === "footer" && selectedFooter === index
            return (
              <text key={choice} fg={selected ? palette.action : palette.foreground}>
                {selected ? "› " : "  "}
                {footerLabel(choice)}
              </text>
            )
          })}
        </box>
        <text fg={palette.accent}>CODESPLASH.AI · BUILT IN MIAMI, FLORIDA</text>
      </box>
    </box>
  )
}

function ProviderRow({
  name,
  probe,
  checking,
  palette,
  selected,
  versionOnly = false,
}: {
  name: string
  probe?: EngineProbe
  checking: boolean
  palette: BrandPalette
  selected: boolean
  versionOnly?: boolean
}) {
  const state = checking && !probe ? "Checking…" : providerLabel(probe, versionOnly)
  const connected = Boolean(probe?.available && probe.authenticated !== false && probe.compatible !== false)
  const statusColor = connected ? palette.accent : palette.muted
  const marker = !probe || checking ? "◌" : connected ? "●" : "○"

  return (
    <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between" }}>
      <text fg={selected ? palette.action : palette.foreground}>
        {selected ? "› " : "  "}
        {name}
      </text>
      <text fg={statusColor}>
        {marker} {state}
      </text>
    </box>
  )
}

function footerLabel(choice: FooterChoice): string {
  if (choice === "theme") return "T Theme"
  if (choice === "recheck") return "R Recheck"
  return "Q Quit"
}

function providerLabel(probe: EngineProbe | undefined, versionOnly = false): string {
  if (!probe) return "Not checked"
  if (!probe.available) return probe.detail ?? "Not installed"
  if (versionOnly) {
    const version = probe.version ? `v${probe.version.replace(/^v/, "")}` : "Available"
    return probe.compatible === false ? `${version} · unsupported` : version
  }
  const detail = (probe.authenticated === false ? "Login required" : probe.detail)?.replace(
    /^ChatGPT pro$/i,
    "ChatGPT Pro",
  )
  const version = probe.version ? `v${probe.version.replace(/^v/, "")}` : undefined
  return [detail, version].filter(Boolean).join(" · ")
}
