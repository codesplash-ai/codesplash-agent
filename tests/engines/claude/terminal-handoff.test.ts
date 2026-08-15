import { describe, expect, test } from "bun:test"
import { runTerminalHandoff } from "../../../src/engines/claude/terminal-handoff.ts"

const fixture = new URL("../../fixtures/fake-terminal-child.ts", import.meta.url)

function fixtureCommand(...args: string[]): string[] {
  return [process.execPath, fixture.pathname, ...args]
}

describe("runTerminalHandoff", () => {
  test("returns the child exit status and removes signal handlers", async () => {
    const before = process.listenerCount("SIGINT")
    const result = await runTerminalHandoff({
      command: fixtureCommand("normal", "7"),
      stdio: "ignore",
    })

    expect(result).toEqual({ exitCode: 7, signalCode: null })
    expect(process.listenerCount("SIGINT")).toBe(before)
  })

  test("forwards SIGINT without terminating the parent", async () => {
    const handoff = runTerminalHandoff({ command: fixtureCommand("wait"), stdio: "ignore" })
    await Bun.sleep(40)
    process.emit("SIGINT")

    const result = await handoff
    expect(result.exitCode).toBe(130)
    expect(result.signalCode).toBeNull()
  })

  test("force kills the child when the handoff is aborted", async () => {
    const controller = new AbortController()
    const handoff = runTerminalHandoff({
      command: fixtureCommand("wait"),
      stdio: "ignore",
      signal: controller.signal,
    })
    await Bun.sleep(40)
    controller.abort()

    const result = await handoff
    expect(result.signalCode).toBe("SIGKILL")
  })
})
