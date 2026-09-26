import { expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RGBA, SyntaxStyle } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "@opentui/react"
import { useState } from "react"
import { tuiDefaults } from "../../src/core/config/tui.ts"
import { loadConfig } from "../../src/core/config.ts"
import { initialAppViewState } from "../../src/core/index.ts"
import { Attention } from "../../src/tui/attention.tsx"
import { brandThemes } from "../../src/tui/brand.ts"
import { DocsPanel } from "../../src/tui/docs-panel.tsx"
import { SearchPanel } from "../../src/tui/search-panel.tsx"
import { SettingsPanel } from "../../src/tui/settings-panel.tsx"

const palette = brandThemes.dark
async function screen() {
  const setup = await createTestRenderer({ width: 120, height: 35 })
  const root = createRoot(setup.renderer)
  const settle = async () => {
    await setup.flush()
    await Bun.sleep(30)
    await setup.flush()
  }
  return { ...setup, root, settle }
}

test("settings panel searches across tabs, edits a user preference and retains a visible source", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "m8-panel-")))
  const setup = await screen()
  let changed = false,
    closed = false
  try {
    const base = await loadConfig(join(dir, "config.toml"), [], {
      cwd: dir,
      env: {},
      workspaceTrusted: false,
    })
    setup.root.render(
      <SettingsPanel
        base={base}
        cwd={dir}
        palette={palette}
        onChange={(config) => {
          changed = config.tui?.vim === true
        }}
        onClose={() => {
          closed = true
        }}
      />,
    )
    await setup.settle()
    expect(setup.captureCharFrame()).toContain("Settings")
    await setup.mockInput.typeText("tui.vim")
    await setup.settle()
    expect(setup.captureCharFrame()).toContain("tui.vim = false")
    setup.mockInput.pressEnter()
    await setup.settle()
    expect(changed).toBe(true)
    expect(await readFile(join(dir, "config.toml"), "utf8")).toContain("vim = true")
    expect(setup.captureCharFrame()).toContain("Saved user preference")
    setup.mockInput.pressEscape()
    await setup.settle()
    expect(closed).toBe(true)
  } finally {
    setup.renderer.destroy()
    await rm(dir, { recursive: true, force: true })
  }
})

test("bundled docs navigate guides and releases; transcript search selects the exact retained item", async () => {
  const setup = await screen(),
    style = SyntaxStyle.fromStyles({ default: { fg: RGBA.fromHex(palette.foreground) } })
  let selected = ""
  try {
    setup.root.render(
      <DocsPanel releaseNotes={false} palette={palette} syntaxStyle={style} onClose={() => {}} />,
    )
    await setup.settle()
    await setup.mockInput.typeText("Terminal workspace")
    await setup.settle()
    setup.mockInput.pressEnter()
    await setup.settle()
    for (let attempt = 0; attempt < 40 && !setup.captureCharFrame().includes("Ctrl+P"); attempt++) {
      await Bun.sleep(50)
      await setup.settle()
    }
    expect(setup.captureCharFrame()).toContain("Ctrl+P")
    setup.mockInput.pressTab()
    await setup.settle()
    expect(setup.captureCharFrame()).toContain("Unreleased")
    setup.root.unmount()
    const item = {
      id: "found",
      kind: "message" as const,
      status: "completed" as const,
      text: "needle 日本語",
    }
    setup.root.render(
      <SearchPanel
        transcript={[item]}
        initialQuery="needle"
        palette={palette}
        onSelect={(row) => {
          selected = row.id
        }}
        onClose={() => {}}
      />,
    )
    await setup.settle()
    expect(setup.captureCharFrame()).toContain("1 matches")
    setup.mockInput.pressEnter()
    await setup.settle()
    expect(selected).toBe("found")
  } finally {
    setup.renderer.destroy()
    style.destroy()
  }
})

test("notifications require opt-in and loss of focus, deduplicate transitions and contain no transcript", async () => {
  const setup = await screen(),
    notices: string[] = []
  setup.renderer.triggerNotification = (text) => {
    notices.push(text)
    return true
  }
  const settings = { ...tuiDefaults, notifications: true, notificationIdleMs: 0 }
  let update!: (state: { turnStatus: "running" | "completed"; request?: string }) => void
  function View() {
    const [state, setState] = useState<{ turnStatus: "running" | "completed"; request?: string }>({
      turnStatus: "running",
    })
    update = setState
    const { turnStatus, request } = state
    return (
      <Attention
        settings={settings}
        state={{
          ...initialAppViewState,
          turnStatus,
          pendingRequest: request
            ? {
                id: request,
                requestKind: "approval",
                title: "PRIVATE",
                detail: "",
                choices: ["accept", "decline"],
              }
            : undefined,
        }}
        project="test"
        cwd={tmpdir()}
        directory={tmpdir()}
        palette={palette}
        enabled={false}
      />
    )
  }
  setup.root.render(<View />)
  await setup.settle()
  const show = async (turnStatus: "running" | "completed", request?: string) => {
    update({ turnStatus, request })
    await setup.settle()
  }
  try {
    await show("running")
    await show("completed")
    expect(notices).toEqual([])
    setup.renderer.emit("blur")
    settings.notificationIdleMs = 60000
    await show("running")
    await show("completed")
    expect(notices).toEqual([])
    settings.notificationIdleMs = 0
    await show("running")
    await show("completed")
    await show("completed")
    expect(notices).toEqual(["CodeSplash turn finished"])
    await show("running", "one")
    await show("running", "one")
    expect(notices).toEqual(["CodeSplash turn finished", "CodeSplash needs your input"])
    setup.renderer.emit("focus")
    await show("completed")
    expect(notices).toHaveLength(2)
  } finally {
    setup.renderer.destroy()
  }
})
