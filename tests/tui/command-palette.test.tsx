import { expect, test } from "bun:test"
import { type Renderable, TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "@opentui/react"
import { type AgentEvent, AsyncQueue, type EngineSession, initialAppViewState } from "../../src/core/index.ts"
import { SessionController } from "../../src/core/session-controller.ts"
import { CODESPLASH_CAPABILITIES } from "../../src/engines/codesplash/index.ts"
import { brandThemes } from "../../src/tui/brand.ts"
import { CodexSessionApp } from "../../src/tui/codex-session.tsx"
import { commandSuggestions } from "../../src/tui/commands.ts"

test("palette ranks prefixes and completes command-specific and model arguments", () => {
  expect(commandSuggestions("/perm")[0]?.value).toBe("/permissions")
  expect(commandSuggestions("prmh").some((row) => row.value === "/prompt-history")).toBe(true)
  expect(commandSuggestions("/personality conc").map((row) => row.value)).toEqual(["/personality concise"])
  expect(commandSuggestions("/model test", ["test-model", "another"])[0]?.value).toBe("/model test-model")
  expect(commandSuggestions("/quit ignored")).toEqual([])
})

test("palette during an approval stages a command without answering or sending; cancel preserves draft", async () => {
  const events = new AsyncQueue<AgentEvent>(),
    sent: string[] = [],
    decisions: string[] = []
  const session: EngineSession = {
    localSessionId: "palette",
    capabilities: CODESPLASH_CAPABILITIES,
    events,
    send: async (input) => {
      sent.push(input.text)
    },
    resolveRequest: async (_id, decision) => {
      decisions.push(decision.choice)
    },
    interrupt: async () => {},
    close: async () => {
      events.end()
    },
  }
  const controller = new SessionController(session, {
    initialState: {
      ...initialAppViewState,
      transcript: [],
      sessionStatus: "ready",
      turnStatus: "running",
      pendingRequest: {
        id: "approval",
        requestKind: "approval",
        title: "Write?",
        detail: "File",
        choices: ["accept", "decline"],
      },
    },
  })
  const setup = await createTestRenderer({ width: 120, height: 35, kittyKeyboard: true })
  const settle = async () => {
    await setup.flush()
    await Bun.sleep(20)
    await setup.flush()
  }
  createRoot(setup.renderer).render(
    <CodexSessionApp
      controller={controller}
      palette={brandThemes.dark}
      engine="codesplash"
      project={{ cwd: "/tmp", name: "tmp", git: { available: false, repository: false, changedFiles: 0 } }}
      onAction={() => {}}
    />,
  )
  const find = (node: Renderable): TextareaRenderable | undefined =>
    node instanceof TextareaRenderable ? node : node.getChildren().map(find).find(Boolean)
  try {
    await settle()
    setup.mockInput.pressKey("p", { ctrl: true })
    await settle()
    await setup.mockInput.typeText("permissions")
    await settle()
    setup.mockInput.pressEnter()
    await settle()
    expect(find(setup.renderer.root)?.plainText).toBe("/permissions ")
    expect(sent).toEqual([])
    expect(decisions).toEqual([])
    setup.mockInput.pressKey("p", { ctrl: true })
    await settle()
    setup.mockInput.pressEscape()
    await settle()
    expect(find(setup.renderer.root)?.plainText).toBe("/permissions ")
    expect(decisions).toEqual([])
    find(setup.renderer.root)?.setText("draft with unicode 日本語")
    await settle()
    setup.mockInput.pressKey("p", { ctrl: true })
    await settle()
    await setup.mockInput.typeText("help")
    await settle()
    setup.mockInput.pressEnter()
    await settle()
    expect(find(setup.renderer.root)?.plainText).toBe("draft with unicode 日本語")
    expect(setup.captureCharFrame()).toContain("Stash the current draft")
  } finally {
    await controller.close()
    setup.renderer.destroy()
  }
})
