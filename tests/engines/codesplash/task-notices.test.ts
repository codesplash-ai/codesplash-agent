import { expect, test } from "bun:test"
import { MemorySessionState } from "../../../src/core/session/control.ts"
import { NativeCommands } from "../../../src/engines/codesplash/orchestration/commands.ts"
import type { SandboxRuntime } from "../../../src/engines/codesplash/sandbox/contracts.ts"

test("task notice floods stay bounded, omit excluded handles and survive a failed event consumer", async () => {
  const commands = new NativeCommands(
    crypto.randomUUID(),
    new MemorySessionState(),
    { profile: { hash: "fixture" } } as SandboxRuntime,
    () => "default",
  )
  commands.onTaskUpdate = () => {
    throw new Error("Viewer failed")
  }
  try {
    for (let batch = 0; batch < 4; batch++) {
      const handles = Array.from({ length: 20 }, (_, i) => {
        const handle = commands.tasks.submit(
          { kind: "command", label: i % 2 ? "visible" : "EXCLUDED_LABEL" },
          async () => {},
        )
        commands.adopt(handle, i % 2 === 1)
        commands.adopt(handle, i % 2 === 1) // Multiple ancestor observations never duplicate settlement.
        return handle
      })
      const results = await Promise.all(handles.map((h) => h.finished))
      expect(results.every((r) => r.status === "completed")).toBe(true)
    }
    let count = 0,
      omitted = 0
    for (let page = 0; page < 5; page++) {
      const result = commands.takeNotices()
      expect(result.notices.length).toBeLessThanOrEqual(8)
      expect(result.notices.every((n) => n.label === "visible")).toBe(true)
      count += result.notices.length
      omitted += result.omitted
    }
    expect(count).toBe(32)
    expect(omitted).toBe(8)
  } finally {
    await commands.close()
  }
})
test("closing an owner drains real settlement while suppressing subsequent presentation and model notices", async () => {
  const commands = new NativeCommands(
    crypto.randomUUID(),
    new MemorySessionState(),
    { profile: { hash: "fixture" } } as SandboxRuntime,
    () => "default",
  )
  let release!: () => void,
    events = 0
  const gate = new Promise<void>((r) => {
    release = r
  })
  commands.onTaskUpdate = () => {
    events++
  }
  const handle = commands.tasks.submit({ kind: "command", label: "held" }, async () => gate)
  commands.adopt(handle)
  const closing = commands.close()
  release()
  await closing
  expect(events).toBe(1)
  expect(commands.takeNotices()).toEqual({ notices: [], omitted: 0 })
})
