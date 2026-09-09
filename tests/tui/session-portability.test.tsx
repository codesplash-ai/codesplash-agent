import { expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "@opentui/react"
import { type AgentEvent, AsyncQueue, type EngineSession, initialAppViewState } from "../../src/core/index.ts"
import { digest } from "../../src/core/session/files.ts"
import { envelope } from "../../src/core/session/portable.ts"
import type { DirectoryRequest } from "../../src/core/session/working-directory.ts"
import { SessionController } from "../../src/core/session-controller.ts"
import { CODESPLASH_CAPABILITIES } from "../../src/engines/codesplash/index.ts"
import { brandThemes } from "../../src/tui/brand.ts"
import { CodexSessionApp } from "../../src/tui/codex-session.tsx"

test("rendered /pwd, /cd preview/apply and /export use the effective directory without submitting a prompt", async () => {
  const destination = await realpath(await mkdtemp(join(tmpdir(), "codesplash-cwd-ui-"))),
    events = new AsyncQueue<AgentEvent>(),
    calls: DirectoryRequest[] = []
  let cwd = "/old-project",
    submissions = 0
  const node = crypto.randomUUID(),
    context = digest("[]")
  const session: EngineSession = {
    localSessionId: "test",
    capabilities: CODESPLASH_CAPABILITIES,
    events,
    send: async () => {
      submissions++
    },
    resolveRequest: async () => {},
    interrupt: async () => {},
    close: async () => events.end(),
    directoryStatus: () => ({ cwd, trusted: false }),
    changeDirectory: async (request) => {
      calls.push(request)
      const from = cwd
      if (request.apply) cwd = request.path
      return {
        from,
        cwd: request.path,
        trusted: false,
        revision: "reviewed",
        applied: !!request.apply,
        pending: 0,
      }
    },
    exportHistory: async () =>
      envelope({
        source: { engine: "codesplash", sessionId: "test", cwd },
        title: "UI export",
        exportedAt: new Date().toISOString(),
        head: node,
        nodes: [
          { id: node, kind: "base", label: "base", created: new Date().toISOString(), usage: {}, context },
        ],
        contexts: { [context]: [] },
        omissions: [],
        converted: false,
        redacted: false,
      }),
  }
  const controller = new SessionController(session, {
    initialState: { ...initialAppViewState, sessionStatus: "ready", transcript: [] },
  })
  const setup = await createTestRenderer({ width: 140, height: 40, kittyKeyboard: true }),
    root = createRoot(setup.renderer)
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
        project={{ cwd, name: "old-project", git: { available: false, repository: false, changedFiles: 0 } }}
        onAction={() => {}}
      />,
    )
    await settle()
    await command("/pwd")
    expect(setup.captureCharFrame()).toContain("/old-project")
    setup.mockInput.pressEscape()
    await settle()
    await command(`/cd '${destination}'`)
    expect(setup.captureCharFrame()).toContain("Working-directory preview")
    expect(cwd).toBe("/old-project")
    setup.mockInput.pressEscape()
    await settle()
    await command(`/cd '${destination}' --clear --apply --revision reviewed`)
    expect(calls.at(-1)).toEqual({ path: destination, context: "clear", apply: true, revision: "reviewed" })
    expect(setup.captureCharFrame()).toContain("Working directory changed")
    setup.mockInput.pressEscape()
    await settle()
    await command("/export --output exported.html --format html")
    expect(await readFile(join(destination, "exported.html"), "utf8")).toContain("default-src 'none'")
    expect(submissions).toBe(0)
  } finally {
    await controller.close()
    setup.renderer.destroy()
    await rm(destination, { recursive: true, force: true })
  }
})
