import { expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../../src/core/config.ts"
import { changeSetting, settingsRows, settingsSnapshot } from "../../src/tui/settings.ts"

test("settings writes only reviewed user fields, preserves unknown data and obeys managed/CLI precedence", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "m8-settings-"))),
    path = join(dir, "config.toml")
  try {
    await writeFile(path, '[future]\nunknown = "preserve"\n[tui]\nvim = false\n')
    await writeFile(join(dir, "managed.toml"), "[required.tui]\nnotifications = false\n")
    const base = await loadConfig(path, ["tui.mouse=off"], { cwd: dir, env: {}, workspaceTrusted: false })
    const first = await settingsSnapshot(base, dir)
    expect(settingsRows(first.config).find((row) => row.key === "tui.notifications")?.locked).toBe(true)
    await expect(changeSetting(base, dir, "tui.notifications", true, first.fingerprint)).rejects.toThrow(
      "managed",
    )
    const edited = await changeSetting(base, dir, "tui.vim", true, first.fingerprint)
    expect(edited.tui?.vim).toBe(true)
    expect(await readFile(path, "utf8")).toContain("preserve")
    await expect(changeSetting(base, dir, "tui.vim", false, first.fingerprint)).rejects.toThrow("changed")
    const second = await settingsSnapshot(base, dir)
    const shadowed = await changeSetting(base, dir, "tui.mouse", "on", second.fingerprint)
    expect(shadowed.tui?.mouse).toBe("off")
    expect(await readFile(path, "utf8")).not.toContain("resolution")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("startup tip visits contain only a bounded count and space reminders across sessions", async () => {
  const { recordTipVisit } = await import("../../src/tui/tips.ts")
  const dir = await realpath(await mkdtemp(join(tmpdir(), "m8-tips-")))
  try {
    expect([recordTipVisit(dir), recordTipVisit(dir), recordTipVisit(dir), recordTipVisit(dir)]).toEqual([
      true,
      false,
      false,
      true,
    ])
    expect(JSON.parse(await readFile(join(dir, "tip-visits.json"), "utf8"))).toEqual({
      version: 1,
      visits: 4,
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
