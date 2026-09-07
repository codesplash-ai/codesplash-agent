import { expect, test } from "bun:test"
import { type Renderable, TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "@opentui/react"
import { type AgentEvent, AsyncQueue, type EngineSession, initialAppViewState } from "../../src/core/index.ts"
import { InputQueue } from "../../src/core/session/input-queue.ts"
import { SessionController } from "../../src/core/session-controller.ts"
import { CODESPLASH_CAPABILITIES } from "../../src/engines/codesplash/index.ts"
import { brandThemes } from "../../src/tui/brand.ts"
import { CodexSessionApp } from "../../src/tui/codex-session.tsx"

const project = {
  cwd: "/project",
  name: "project",
  git: { available: false, repository: false, changedFiles: 0 },
}
async function fixture(approval = false) {
  const queue = new InputQueue({ cwd: project.cwd }),
    events = new AsyncQueue<AgentEvent>(),
    decisions: string[] = []
  let acknowledge!: () => void
  const barrier = new Promise<void>((resolve) => {
    acknowledge = resolve
  })
  const session: EngineSession = {
    localSessionId: "test",
    capabilities: CODESPLASH_CAPABILITIES,
    events,
    inputQueue: queue,
    submit: async (input, intent, id) => {
      await barrier
      return queue.submit(input, intent, id)
    },
    send: async () => {},
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
      sessionStatus: "ready",
      turnStatus: "running",
      transcript: [],
      pendingRequest: approval
        ? {
            id: "approval",
            requestKind: "approval",
            title: "Write a file?",
            detail: "Needs permission",
            choices: ["accept", "decline", "cancel"],
          }
        : undefined,
    },
  })
  const setup = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true })
  const root = createRoot(setup.renderer)
  const settle = async () => {
    await setup.flush()
    await Bun.sleep(15)
    await setup.flush()
  }
  root.render(
    <CodexSessionApp
      controller={controller}
      palette={brandThemes.dark}
      project={project}
      engine="codesplash"
      onAction={() => {}}
    />,
  )
  await settle()
  const findComposer = (node: Renderable): TextareaRenderable | undefined =>
    node instanceof TextareaRenderable ? node : node.getChildren().map(findComposer).find(Boolean)
  const composer = findComposer(setup.renderer.root) as TextareaRenderable
  return { queue, controller, setup, settle, composer, decisions, acknowledge }
}
test("delayed acknowledgment preserves text typed after submission", async () => {
  const f = await fixture()
  try {
    await f.setup.mockInput.typeText("first draft")
    await f.settle()
    f.setup.mockInput.pressEnter()
    await f.settle()
    expect(f.composer.plainText).toBe("first draft")
    await f.setup.mockInput.typeText(" newer text")
    await f.settle()
    f.acknowledge()
    await f.settle()
    expect(f.queue.snapshot().items[0]?.input.text).toBe("first draft")
    expect(f.composer.plainText).toBe("first draft newer text")
  } finally {
    await f.controller.close()
    f.setup.renderer.destroy()
  }
})
test("approval focus can move to the composer without answering the pending approval", async () => {
  const f = await fixture(true)
  try {
    f.setup.mockInput.pressTab()
    await f.settle()
    await f.setup.mockInput.typeText("a follow-up")
    await f.settle()
    expect(f.decisions).toEqual([])
    expect(f.composer.plainText).toBe("a follow-up")
    f.setup.mockInput.pressEnter()
    await f.settle()
    f.acknowledge()
    await f.settle()
    expect(f.queue.snapshot().items[0]?.input.text).toBe("a follow-up")
    expect(f.composer.plainText).toBe("")
    expect(f.decisions).toEqual([])
  } finally {
    await f.controller.close()
    f.setup.renderer.destroy()
  }
})
