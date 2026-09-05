import { createCliRenderer, type TextareaRenderable, type ThemeMode } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer } from "@opentui/react"
import { useEffect, useRef } from "react"
import type { ThemePreference } from "../core/index.ts"
import { registerCleanup } from "../core/index.ts"
import { type BrandPalette, brandThemes } from "./brand.ts"

/** Only a deliberate, exact "yes" confirms a dangerous session policy. */
export function confirmationAccepted(input: string): boolean {
  return input.trim().toLowerCase() === "yes"
}

/** One typed-confirmation screen per dangerous launch flag; the shell below renders any of them. */
export type TypedConfirmationContent = {
  /** Box title, e.g. "FULL ACCESS REQUESTED". */
  title: string
  /** Bold destructive lead line naming the flag and what it disables. */
  heading: string
  warnings: readonly string[]
}

export const fullAccessWarnings = [
  "Codex will run WITHOUT a sandbox in this session.",
  "It can modify or delete any file your user can reach, on and off this project.",
  "It can run commands with network access and lasting side effects.",
  "Approval prompts still appear, but a wrong approval has no safety net.",
] as const

export const fullAccessConfirmationContent: TypedConfirmationContent = {
  title: "FULL ACCESS REQUESTED",
  heading: "--full-access disables the Codex sandbox.",
  warnings: fullAccessWarnings,
}

export const bypassApprovalsWarnings = [
  "CodeSplash will auto-approve tool calls in this session — no approval prompts.",
  "File edits and shell commands run immediately under the current sandbox policy.",
  "Dangerous commands (sudo, rm -rf, force-push, …) still stop and ask, and protected paths (.git, harness config, ~/.ssh) stay blocked.",
  "Bypass lasts only for this session and is never persisted.",
] as const

export const bypassApprovalsConfirmationContent: TypedConfirmationContent = {
  title: "BYPASS APPROVALS REQUESTED",
  heading: "--bypass-approvals auto-approves tool calls for this session.",
  warnings: bypassApprovalsWarnings,
}

type TypedConfirmationProps = {
  content: TypedConfirmationContent
  palette: BrandPalette
  onDecision(confirmed: boolean): void
}

export function TypedConfirmationApp({ content, palette, onDecision }: TypedConfirmationProps) {
  const renderer = useRenderer()
  const textareaRef = useRef<TextareaRenderable>(null)

  useEffect(() => {
    renderer.setBackgroundColor(palette.background)
  }, [palette.background, renderer])

  useKeyboard((key) => {
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      key.preventDefault()
      onDecision(false)
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
        title={content.title}
        style={{
          width: "86%",
          maxWidth: 100,
          border: true,
          borderStyle: "double",
          borderColor: palette.destructive,
          backgroundColor: palette.popover,
          padding: 1,
        }}
      >
        <text fg={palette.destructive}>
          <b>{content.heading}</b>
        </text>
        {content.warnings.map((line) => (
          <text key={line} fg={palette.foreground}>
            · {line}
          </text>
        ))}
        <text fg={palette.muted} style={{ marginTop: 1 }}>
          Type yes and press Enter to continue. Esc cancels and returns home.
        </text>
        <box style={{ height: 1, flexDirection: "row", marginTop: 1 }}>
          <text fg={palette.destructive} style={{ width: 2 }}>
            <b>{">"}</b>
          </text>
          <textarea
            ref={textareaRef}
            focused
            textColor={palette.foreground}
            cursorColor={palette.destructive}
            backgroundColor={palette.popover}
            focusedBackgroundColor={palette.popover}
            keyBindings={[
              { name: "return", action: "submit" },
              { name: "kpenter", action: "submit" },
              { name: "linefeed", action: "submit" },
            ]}
            style={{ flexGrow: 1, height: 1 }}
            onSubmit={() => {
              const text = textareaRef.current?.plainText ?? ""
              if (confirmationAccepted(text)) onDecision(true)
              else textareaRef.current?.setText("")
            }}
          />
        </box>
      </box>
    </box>
  )
}

export function FullAccessConfirmationApp({ palette, onDecision }: Omit<TypedConfirmationProps, "content">) {
  return (
    <TypedConfirmationApp content={fullAccessConfirmationContent} palette={palette} onDecision={onDecision} />
  )
}

/** Renders a typed confirmation on its own renderer; resolves false when the user backs out. */
export async function renderTypedConfirmation(
  content: TypedConfirmationContent,
  themePreference: ThemePreference,
): Promise<boolean> {
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
    const finish = (confirmed: boolean) => {
      if (settled) return
      settled = true
      unregisterRenderer()
      renderer.destroy()
      resolve(confirmed)
    }

    createRoot(renderer).render(
      <TypedConfirmationApp content={content} palette={brandThemes[theme]} onDecision={finish} />,
    )
  })
}

export async function renderFullAccessConfirmation(themePreference: ThemePreference): Promise<boolean> {
  return renderTypedConfirmation(fullAccessConfirmationContent, themePreference)
}

/** --bypass-approvals is confirmed on every session open, resume included; never persisted. */
export async function renderBypassConfirmation(themePreference: ThemePreference): Promise<boolean> {
  return renderTypedConfirmation(bypassApprovalsConfirmationContent, themePreference)
}
