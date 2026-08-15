import { createCliRenderer, type ThemeMode } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { loadConfig, saveConfig, type ThemePreference } from "../core/index.ts"
import { ClaudeDriver } from "../engines/claude/index.ts"
import { type WelcomeAction, WelcomeApp } from "./welcome.tsx"

export async function runWelcome(): Promise<void> {
  let config = await loadConfig()

  while (true) {
    const action = await renderWelcome(config.theme, async (theme) => {
      config = { ...config, theme }
      await saveConfig(config)
    })
    if (action === "quit") return

    if (action === "launch-claude") {
      try {
        await new ClaudeDriver().handoff(process.cwd())
      } catch (error) {
        process.stderr.write(`agent: ${error instanceof Error ? error.message : String(error)}\n`)
      }
      continue
    }

    const binary = Bun.which("codex")
    if (!binary) {
      process.stderr.write("agent: Codex CLI is not installed.\n")
      continue
    }

    const login = Bun.spawn([binary, "login"], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    await login.exited
  }
}

async function renderWelcome(
  themePreference: ThemePreference,
  onThemePreferenceChange: (theme: ThemePreference) => Promise<void>,
): Promise<WelcomeAction> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 60 })
  const detectedTheme: ThemeMode = (await renderer.waitForThemeMode(300)) ?? "dark"

  return new Promise((resolve) => {
    let settled = false
    const finish = (action: WelcomeAction) => {
      if (settled) return
      settled = true
      renderer.destroy()
      resolve(action)
    }

    createRoot(renderer).render(
      <WelcomeApp
        detectedTheme={detectedTheme}
        initialThemePreference={themePreference}
        onAction={finish}
        onThemePreferenceChange={onThemePreferenceChange}
      />,
    )
  })
}
