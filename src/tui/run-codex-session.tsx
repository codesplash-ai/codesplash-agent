import { createCliRenderer, type ThemeMode } from "@opentui/core"
import { createRoot } from "@opentui/react"
import type { ProjectPreflight, ThemePreference } from "../core/index.ts"
import { SessionController } from "../core/index.ts"
import { CodexDriver } from "../engines/codex/index.ts"
import { brandThemes } from "./brand.ts"
import { type CodexSessionAction, CodexSessionApp } from "./codex-session.tsx"

export async function runCodexSession(
  project: ProjectPreflight,
  themePreference: ThemePreference,
): Promise<void> {
  let nativeSessionId: string | undefined
  const localSessionId = crypto.randomUUID()

  while (true) {
    const session = await new CodexDriver().openSession({
      cwd: project.cwd,
      localSessionId,
      nativeSessionId,
    })
    nativeSessionId = session.nativeSessionId
    const controller = new SessionController(session)

    try {
      const action = await renderCodexSession(controller, project, themePreference)
      if (action !== "reconnect") return
    } finally {
      await controller.close()
    }
  }
}

async function renderCodexSession(
  controller: SessionController,
  project: ProjectPreflight,
  themePreference: ThemePreference,
): Promise<CodexSessionAction> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 60,
    useKittyKeyboard: { disambiguate: true, alternateKeys: true },
  })
  const detectedTheme: ThemeMode = (await renderer.waitForThemeMode(300)) ?? "dark"
  const theme = themePreference === "system" ? detectedTheme : themePreference

  return new Promise((resolve) => {
    let settled = false
    const finish = (action: CodexSessionAction) => {
      if (settled) return
      settled = true
      renderer.destroy()
      resolve(action)
    }

    createRoot(renderer).render(
      <CodexSessionApp
        controller={controller}
        palette={brandThemes[theme]}
        project={project}
        onAction={finish}
      />,
    )
  })
}
