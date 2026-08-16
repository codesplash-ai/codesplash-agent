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
  saveConfig,
  type ThemePreference,
} from "../core/index.ts"
import { ClaudeDriver } from "../engines/claude/index.ts"
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
      const release = deferSignalExit()
      try {
        await new ClaudeDriver().handoff(project.cwd)
      } catch (error) {
        process.stderr.write(`agent: ${error instanceof Error ? error.message : String(error)}\n`)
      } finally {
        release()
      }
      continue
    }

    if (action === "open-codex") {
      try {
        await openCodex(project, config, options)
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

async function openCodex(project: ProjectPreflight, config: AgentConfig, options: AppOptions): Promise<void> {
  const policy = effectiveSessionPolicy(config, options)
  const historyEnabled = effectiveHistoryEnabled(config, options)

  if (!historyEnabled) {
    await runCodexSession(project, config.theme, { policy, historyEnabled })
    return
  }

  const sessions = await listProjectSessions(projectIdFor(project.cwd))
  if (sessions.length === 0) {
    await runCodexSession(project, config.theme, { policy, historyEnabled })
    return
  }

  const choice = await renderSessionPicker(sessions, config.theme)
  if (choice.type === "back") return
  await runCodexSession(project, config.theme, {
    policy,
    historyEnabled,
    resume: choice.type === "resume" ? choice.meta : undefined,
  })
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
