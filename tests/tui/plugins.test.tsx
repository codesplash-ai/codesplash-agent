import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "@opentui/react"
import { type AgentEvent, AsyncQueue, type EngineSession, initialAppViewState } from "../../src/core/index.ts"
import { SessionController } from "../../src/core/session-controller.ts"
import { CODESPLASH_CAPABILITIES } from "../../src/engines/codesplash/index.ts"
import { brandThemes } from "../../src/tui/brand.ts"
import { CodexSessionApp } from "../../src/tui/codex-session.tsx"

test("rendered plugin review exposes source and trust; management never submits a model prompt", async () => {
  const events = new AsyncQueue<AgentEvent>(),
    commands: string[] = []
  let submitted = 0
  const session: EngineSession = {
    localSessionId: "plugins-ui",
    capabilities: CODESPLASH_CAPABILITIES,
    events,
    send: async () => {
      submitted++
    },
    interrupt: async () => {},
    resolveRequest: async () => {},
    close: async () => events.end(),
    pluginsCommand: async (command) => {
      commands.push(command)
      return {
        source: "extension:fixture",
        trusted: false,
        tools: ["fixture/tool"],
        execution: "Trusted in-process code",
        fingerprint: "review-before-trust",
      }
    },
  }
  const controller = new SessionController(session, {
    initialState: { ...initialAppViewState, sessionStatus: "ready" },
  })
  const setup = await createTestRenderer({ width: 120, height: 32, kittyKeyboard: true }),
    root = createRoot(setup.renderer)
  const settle = async () => {
    await setup.flush()
    await Bun.sleep(40)
    await setup.flush()
  }
  try {
    root.render(
      <CodexSessionApp
        controller={controller}
        engine="codesplash"
        palette={brandThemes.dark}
        project={{
          cwd: "/project",
          name: "project",
          git: { available: false, repository: false, changedFiles: 0 },
        }}
        onAction={() => {}}
      />,
    )
    await settle()
    await setup.mockInput.typeText("/plugins status")
    setup.mockInput.pressEnter()
    await settle()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Installed plugins")
    expect(frame).toContain("extension:fixture")
    expect(frame).toContain('"trusted": false')
    expect(frame).toContain('"tools"')
    expect(frame).toContain("Trusted in-process code")
    expect(frame).toContain("review-before-trust")
    expect(commands).toEqual(["status"])
    expect(submitted).toBe(0)
    setup.mockInput.pressEscape()
    await settle()
    await setup.mockInput.typeText("/plugins reload")
    setup.mockInput.pressEnter()
    await settle()
    expect(commands).toEqual(["status", "reload"])
    expect(submitted).toBe(0)
  } finally {
    await controller.close()
    setup.renderer.destroy()
  }
})
