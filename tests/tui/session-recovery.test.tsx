import { expect, test } from "bun:test"
import { type Renderable, TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "@opentui/react"
import { type AgentEvent, AsyncQueue, type EngineSession, initialAppViewState } from "../../src/core/index.ts"
import { BranchStore } from "../../src/core/session/branches.ts"
import { MemorySessionState } from "../../src/core/session/control.ts"
import { InputQueue } from "../../src/core/session/input-queue.ts"
import { SessionController } from "../../src/core/session-controller.ts"
import { CODESPLASH_CAPABILITIES } from "../../src/engines/codesplash/index.ts"
import { brandThemes } from "../../src/tui/brand.ts"
import { CodexSessionApp } from "../../src/tui/codex-session.tsx"

test("Esc-Esc previews retained branches; explicit rewind preserves descendants and draft recall never submits", async () => {
  const state = new MemorySessionState(),
    branches = new BranchStore(state),
    queue = new InputQueue({ cwd: "/project", state })
  const first = branches.capture({ kind: "base", label: "base", messages: [], eventSequence: -1, usage: {} })
  const prompt = queue.submit({ text: "expanded text", sourceText: "my typed prompt" })
  const last = branches.capture({
    kind: "turn",
    label: "my typed prompt",
    messages: [{ role: "user", content: [{ type: "text", text: "expanded text" }] }],
    eventSequence: 1,
    usage: {},
    promptId: prompt.id,
  })
  const events = new AsyncQueue<AgentEvent>()
  let submissions = 0
  const session: EngineSession = {
    localSessionId: "test",
    capabilities: CODESPLASH_CAPABILITIES,
    events,
    inputQueue: queue,
    send: async () => {
      submissions++
    },
    interrupt: async () => {},
    resolveRequest: async () => {},
    close: async () => events.end(),
    sessionRecovery: async (request) => {
      if (request.action === "tree") return { title: "tree", data: branches.view() }
      if (request.action !== "rewind") throw new Error("Fixture only supports rewind")
      if (!request.apply) return { title: "preview", data: { revision: branches.view().revision } }
      branches.prepareSwitch(request.node, request.revision ?? "")
      branches.finishSwitch()
      return { title: "rewound", data: branches.view() }
    },
  }
  const controller = new SessionController(session, {
    initialState: { ...initialAppViewState, sessionStatus: "ready", transcript: [] },
  })
  const setup = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true })
  const root = createRoot(setup.renderer),
    settle = async () => {
      await setup.flush()
      await Bun.sleep(15)
      await setup.flush()
    }
  const composer = (node: Renderable): TextareaRenderable | undefined =>
    node instanceof TextareaRenderable ? node : node.getChildren().map(composer).find(Boolean)
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
    setup.mockInput.pressEscape()
    await settle()
    setup.mockInput.pressEscape()
    await settle()
    expect(setup.captureCharFrame()).toContain("Session tree / backtrack")
    expect(branches.view().head).toBe(last.id)
    setup.mockInput.pressKey("d")
    await settle()
    expect(composer(setup.renderer.root)?.plainText).toBe("my typed prompt")
    expect(submissions).toBe(0)
    setup.mockInput.pressEscape()
    await settle()
    setup.mockInput.pressEscape()
    await settle()
    setup.mockInput.pressKey("d")
    await settle()
    expect(setup.captureCharFrame()).toContain("draft is already")
    setup.mockInput.pressArrow("up")
    await settle()
    setup.mockInput.pressEnter()
    await settle()
    expect(branches.view().head).toBe(last.id)
    setup.mockInput.pressKey("r")
    await settle()
    expect(branches.view().head).toBe(first.id)
    expect(branches.view().nodes).toHaveLength(2)
    expect(composer(setup.renderer.root)?.plainText).toBe("my typed prompt")
    expect(submissions).toBe(0)
  } finally {
    await controller.close()
    setup.renderer.destroy()
  }
})
