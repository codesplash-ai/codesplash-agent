import { createCliRenderer, type TextareaRenderable, type ThemeMode } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer } from "@opentui/react"
import { useEffect, useRef } from "react"
import type { ThemePreference } from "../core/index.ts"
import { registerCleanup } from "../core/index.ts"
import { type BrandPalette, brandThemes } from "./brand.ts"

/** Only a deliberate, exact "yes" confirms running without a sandbox. */
export function confirmationAccepted(input: string): boolean {
  return input.trim().toLowerCase() === "yes"
}

export const fullAccessWarnings = [
  "Codex will run WITHOUT a sandbox in this session.",
  "It can modify or delete any file your user can reach, on and off this project.",
  "It can run commands with network access and lasting side effects.",
  "Approval prompts still appear, but a wrong approval has no safety net.",
] as const

type FullAccessConfirmationProps = {
  palette: BrandPalette
  onDecision(confirmed: boolean): void
}

export function FullAccessConfirmationApp({ palette, onDecision }: FullAccessConfirmationProps) {
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
        title="FULL ACCESS REQUESTED"
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
          <b>--full-access disables the Codex sandbox.</b>
        </text>
        {fullAccessWarnings.map((line) => (
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

/** Renders the confirmation on its own renderer; resolves false when the user backs out. */
export async function renderFullAccessConfirmation(themePreference: ThemePreference): Promise<boolean> {
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
      <FullAccessConfirmationApp palette={brandThemes[theme]} onDecision={finish} />,
    )
  })
}
