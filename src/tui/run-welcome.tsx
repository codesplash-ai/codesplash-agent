import { createCliRenderer, type ThemeMode } from "@opentui/core"
import { createRoot } from "@opentui/react"
import {
  type AgentConfig,
  type AppOptions,
  defaultAppOptions,
  deferSignalExit,
  effectiveHistoryEnabled,
  effectiveSessionPolicy,
  listProjectSessions,
  loadConfig,
  type ProjectPreflight,
  projectIdFor,
  registerCleanup,
  type SessionMeta,
  saveConfig,
  type ThemePreference,
} from "../core/index.ts"
import { launchClaude } from "./run-claude.ts"
import { runCodexSession } from "./run-codex-session.tsx"
import { renderSessionPicker } from "./session-picker.tsx"
import { type WelcomeAction, WelcomeApp } from "./welcome.tsx"

export async function runWelcome(
  project: ProjectPreflight,
  options: AppOptions = defaultAppOptions,
): Promise<void> {
  let config = await loadConfig()

  while (true) {
    const action = await renderWelcome(config.theme, async (theme) => {
      config = { ...config, theme }
      await saveConfig(config)
    })
    if (action === "quit") return

    if (action === "launch-claude") {
      try {
        await launchClaude(project, config, options)
      } catch (error) {
        process.stderr.write(`agent: ${error instanceof Error ? error.message : String(error)}\n`)
      }
      continue
    }

    if (action === "open-codex") {
      try {
        if ((await openCodex(project, config, options)) === "quit") return
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

    const release = deferSignalExit()
    try {
      const login = Bun.spawn([binary, "login"], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      })
      await login.exited
    } finally {
      release()
    }
  }
}

async function openCodex(
  project: ProjectPreflight,
  config: AgentConfig,
  options: AppOptions,
): Promise<"done" | "quit"> {
  const policy = effectiveSessionPolicy(config, options)
  const historyEnabled = effectiveHistoryEnabled(config, options)

  let resume: SessionMeta | undefined
  let skipPicker = !historyEnabled

  while (true) {
    if (!skipPicker) {
      const sessions = (await listProjectSessions(projectIdFor(project.cwd))).filter(
        (meta) => meta.engine === "codex",
      )
      resume = undefined
      if (sessions.length > 0) {
        const choice = await renderSessionPicker(sessions, config.theme)
        if (choice.type === "back") return "done"
        if (choice.type === "resume") resume = choice.meta
      }
    }
    skipPicker = false

    const outcome = await runCodexSession(project, config.theme, { policy, historyEnabled, resume })
    if (outcome === "quit") return "quit"
    if (outcome === "new") {
      // Skip the picker and open a fresh session directly.
      resume = undefined
      skipPicker = true
      continue
    }
    if (outcome === "resume-picker") continue
    return "done"
  }
}

async function renderWelcome(
  themePreference: ThemePreference,
  onThemePreferenceChange: (theme: ThemePreference) => Promise<void>,
): Promise<WelcomeAction> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 60,
    useKittyKeyboard: { disambiguate: true, alternateKeys: true },
  })
  const detectedTheme: ThemeMode = (await renderer.waitForThemeMode(300)) ?? "dark"
  const unregisterRenderer = registerCleanup(() => renderer.destroy())

  return new Promise((resolve) => {
    let settled = false
    const finish = (action: WelcomeAction) => {
      if (settled) return
      settled = true
      unregisterRenderer()
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
