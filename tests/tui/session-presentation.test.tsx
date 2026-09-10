import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "@opentui/react"
import {
  type AgentEvent,
  AsyncQueue,
  createAgentEvent,
  type EngineSession,
  initialAppViewState,
} from "../../src/core/index.ts"
import { SessionController } from "../../src/core/session-controller.ts"
import { CODESPLASH_CAPABILITIES } from "../../src/engines/codesplash/index.ts"
import { brandThemes } from "../../src/tui/brand.ts"
import { CodexSessionApp } from "../../src/tui/codex-session.tsx"

test("rendered presentation commands show local outcomes, explicitly copy info and never submit prompts", async () => {
  const events = new AsyncQueue<AgentEvent>()
  let submissions = 0,
    copied = ""
  const titles: string[] = []
  const session: EngineSession = {
    localSessionId: "presentation",
    capabilities: CODESPLASH_CAPABILITIES,
    events,
    send: async () => {
      submissions++
    },
    resolveRequest: async () => {},
    interrupt: async () => {},
    close: async () => events.end(),
    sessionPresentation: async (request) => {
      if (request.action === "rename") {
        titles.push(request.title ?? "auto")
        return "Title updated"
      }
      return {
        id: "presentation",
        policy: { source: "live", permission: "plan" },
        persistence: "memory only",
      }
    },
  }
  const controller = new SessionController(session, {
    initialState: { ...initialAppViewState, sessionStatus: "ready", transcript: [] },
  })
  const setup = await createTestRenderer({ width: 140, height: 40, kittyKeyboard: true }),
    root = createRoot(setup.renderer)
  setup.renderer.copyToClipboardOSC52 = (text) => {
    copied = text
    return true
  }
  const settle = async () => {
    await setup.flush()
    await Bun.sleep(50)
    await setup.flush()
  }
  const command = async (text: string) => {
    await setup.mockInput.typeText(text)
    setup.mockInput.pressEnter()
    await settle()
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
    await command("/session-info")
    expect(setup.captureCharFrame()).toContain("memory only")
    expect(copied).toBe("")
    setup.mockInput.pressEscape()
    await settle()
    await command("/session-info --copy")
    expect(copied).toContain('"source": "live"')
    setup.mockInput.pressEscape()
    await settle()
    await command("/recap")
    expect(setup.captureCharFrame()).toContain("No recorded turn outcomes")
    setup.mockInput.pressEscape()
    await settle()
    await command("/rename My session")
    expect(titles).toEqual(["My session"])
    expect(submissions).toBe(0)
    setup.mockInput.pressEscape()
    await settle()
    controller.start()
    events.push(
      createAgentEvent(
        { engine: "codesplash", localSessionId: "presentation", sequence: 0 },
        { kind: "turn.started", payload: {} },
      ),
    )
    events.push(
      createAgentEvent(
        { engine: "codesplash", localSessionId: "presentation", sequence: 1 },
        { kind: "turn.completed", payload: { status: "completed" } },
      ),
    )
    await settle()
    expect(setup.captureCharFrame()).toContain("tools completed")
    const now = Date.now
    try {
      Date.now = () => now() + 300001
      await setup.mockInput.typeText("draft")
    } finally {
      Date.now = now
    }
    await settle()
    expect(setup.captureCharFrame()).toContain("While away")
    expect(setup.captureCharFrame()).toContain("draft")
    expect(submissions).toBe(0)
  } finally {
    await controller.close()
    setup.renderer.destroy()
  }
})
