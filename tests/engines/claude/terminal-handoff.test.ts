import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { runTerminalHandoff } from "../../../src/engines/claude/terminal-handoff.ts"

const fixture = new URL("../../fixtures/fake-terminal-child.ts", import.meta.url)

function fixtureCommand(...args: string[]): string[] {
  return [process.execPath, fileURLToPath(fixture), ...args]
}

/** The wait-mode child writes this file once its signal handlers are installed. */
async function readyFilePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "codesplash-agent-handoff-")), "ready")
}

async function waitForReady(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) return
    await Bun.sleep(10)
  }
  throw new Error("Fixture child never reported readiness")
}

/** SIGINT exit-code conventions and signalCode reporting are POSIX semantics. */
const posixTest = test.skipIf(process.platform === "win32")

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

  posixTest("forwards SIGINT without terminating the parent", async () => {
    const ready = await readyFilePath()
    const handoff = runTerminalHandoff({ command: fixtureCommand("wait", ready), stdio: "ignore" })
    await waitForReady(ready)
    process.emit("SIGINT")

    const result = await handoff
    expect(result.exitCode).toBe(130)
    expect(result.signalCode).toBeNull()
  })

  posixTest("force kills the child when the handoff is aborted", async () => {
    const controller = new AbortController()
    const ready = await readyFilePath()
    const handoff = runTerminalHandoff({
      command: fixtureCommand("wait", ready),
      stdio: "ignore",
      signal: controller.signal,
    })
    await waitForReady(ready)
    controller.abort()

    const result = await handoff
    expect(result.signalCode).toBe("SIGKILL")
  })
})
