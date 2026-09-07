import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "@opentui/react"
import { useEffect, useState } from "react"
import { InputQueue } from "../../src/core/session/input-queue.ts"
import { brandThemes } from "../../src/tui/brand.ts"
import { InputPanel } from "../../src/tui/input-panel.tsx"

test("rendered queue pane edits, reorders, removes and explicitly confirms uncertain retry", async () => {
  const queue = new InputQueue({ cwd: "/project" })
  const first = queue.submit({ text: "first prompt" }),
    second = queue.submit({ text: "second prompt" })
  queue.pause()
  const restored: string[] = []
  function App() {
    const [snapshot, setSnapshot] = useState(queue.snapshot())
    useEffect(() => queue.subscribe(() => setSnapshot(queue.snapshot())), [])
    return (
      <InputPanel
        queue={queue}
        snapshot={snapshot}
        tab="queue"
        palette={brandThemes.dark}
        onClose={() => {}}
        onRestore={(prompt) => {
          restored.push(prompt.id)
        }}
      />
    )
  }
  const setup = await createTestRenderer({ width: 120, height: 30, kittyKeyboard: true })
  const root = createRoot(setup.renderer)
  const settle = async () => {
    await setup.flush()
    await Bun.sleep(10)
    await setup.flush()
  }
  try {
    root.render(<App />)
    await settle()
    setup.mockInput.pressKey("e")
    await settle()
    expect(restored).toEqual([first.id])
    setup.mockInput.pressArrow("down", { ctrl: true })
    await settle()
    expect(queue.snapshot().items.map((item) => item.id)).toEqual([second.id, first.id])
    setup.mockInput.pressKey("d")
    await settle()
    expect(queue.snapshot().items.find((item) => item.id === first.id)?.status).toBe("cancelled")
    queue.finish(second.id, "execution-uncertain")
    await settle()
    setup.mockInput.pressKey("r")
    await settle()
    setup.mockInput.pressEnter()
    await settle()
    expect(queue.snapshot().items[0]?.status).toBe("execution-uncertain")
    await setup.mockInput.typeText("retry")
    await settle()
    setup.mockInput.pressEnter()
    await settle()
    expect(queue.snapshot().items[0]?.status).toBe("queued")
    expect(queue.snapshot().paused).toBe(true)
  } finally {
    setup.renderer.destroy()
  }
})
