import { createCliRenderer, type ThemeMode } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer } from "@opentui/react"
import { useEffect } from "react"
import type { ThemePreference } from "../core/index.ts"
import { readTrustDecision, registerCleanup, writeTrustDecision } from "../core/index.ts"
import { type BrandPalette, brandThemes } from "./brand.ts"

/**
 * Workspace trust gate: shown once per folder, before the first codesplash session opens in a
 * workspace with no stored trust decision. Trusting persists `trusted: true`; "not now" opens
 * the session untrusted and persists nothing, so the gate asks again next time.
 */

export type TrustGateChoice = "trust" | "not-now" | "back"

/** What trusting a folder actually gates; shown verbatim on the screen. */
export const trustGateExplanation = [
  "Trusting lets the harness inject this folder's agent rule files (AGENTS.md / CLAUDE.md) into the system prompt.",
  "It also enables the project permission tier (.codesplash/permissions.toml).",
  "Untrusted sessions still work — those files are simply ignored.",
  'Trust is persisted for this folder; "not now" persists nothing and asks again next time.',
] as const

export function trustGateChoiceForKey(name: string): TrustGateChoice | undefined {
  if (name === "t") return "trust"
  if (name === "n") return "not-now"
  if (name === "escape") return "back"
  return undefined
}

/**
 * Applies a gate choice. Only "trust" writes to the trust store; "not now" deliberately
 * persists nothing (only `true` is ever persisted this tranche). Returns the workspaceTrusted
 * flag for openSession, or undefined when the user backed out.
 */
export async function applyTrustGateChoice(
  choice: TrustGateChoice,
  workspacePath: string,
  dataDir?: string,
): Promise<boolean | undefined> {
  if (choice === "back") return undefined
  if (choice === "trust") {
    await writeTrustDecision(workspacePath, true, dataDir)
    return true
  }
  return false
}

/**
 * Resolves the workspace trust flag for a session open: a stored decision (either way) skips
 * the gate entirely; otherwise `showGate` runs and its choice is applied. Returns undefined
 * when the user backed out of the gate.
 */
export async function resolveWorkspaceTrust(
  workspacePath: string,
  showGate: () => Promise<TrustGateChoice>,
  dataDir?: string,
): Promise<boolean | undefined> {
  const stored = await readTrustDecision(workspacePath, dataDir)
  if (stored) return stored.trusted
  return applyTrustGateChoice(await showGate(), workspacePath, dataDir)
}

type TrustGateProps = {
  palette: BrandPalette
  /** Resolved workspace path the decision applies to; named on screen so nothing is implicit. */
  workspacePath: string
  onDecision(choice: TrustGateChoice): void
}

export function TrustGateApp({ palette, workspacePath, onDecision }: TrustGateProps) {
  const renderer = useRenderer()

  useEffect(() => {
    renderer.setBackgroundColor(palette.background)
  }, [palette.background, renderer])

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      onDecision("back")
      return
    }
    if (key.ctrl || key.meta || key.option) return
    const choice = trustGateChoiceForKey(key.name)
    if (choice) {
      key.preventDefault()
      onDecision(choice)
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
      <box
        title="Do you trust this folder?"
        style={{
          width: "86%",
          maxWidth: 100,
          border: true,
          borderStyle: "double",
          borderColor: palette.action,
          backgroundColor: palette.popover,
          padding: 1,
        }}
      >
        <text fg={palette.accent}>
          <b>{workspacePath}</b>
        </text>
        <box style={{ marginTop: 1 }}>
          {trustGateExplanation.map((line) => (
            <text key={line} fg={palette.foreground}>
              · {line}
            </text>
          ))}
        </box>
        <text fg={palette.action} style={{ marginTop: 1 }}>
          T trust this folder (persisted) · N not now (untrusted session) · Esc back
        </text>
      </box>
    </box>
  )
}

/** Renders the trust gate on its own renderer; resolves with the user's choice. */
export async function renderTrustGate(
  workspacePath: string,
  themePreference: ThemePreference,
): Promise<TrustGateChoice> {
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
    const finish = (choice: TrustGateChoice) => {
      if (settled) return
      settled = true
      unregisterRenderer()
      renderer.destroy()
      resolve(choice)
    }

    createRoot(renderer).render(
      <TrustGateApp palette={brandThemes[theme]} workspacePath={workspacePath} onDecision={finish} />,
    )
  })
}
