import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applySettings, previewSettings } from "../../src/commands/import-settings.ts"
import { loadConfig } from "../../src/core/config.ts"

test("settings migration maps consumed model/history controls while omitting credentials and permission values", async () => {
  const root = mkdtempSync(join(tmpdir(), "settings-import-")),
    source = join(root, "source.toml"),
    destination = join(root, "config.toml")
  try {
    writeFileSync(
      source,
      'model = "gpt-5.1"\napi_key = "DO_NOT_COPY_VALUE"\nsandbox_mode = "danger-full-access"\n[history]\npersistence = "none"\nmax_bytes = 123\n',
    )
    writeFileSync(destination, 'schemaVersion = 1\ntheme = "dark"\n[future]\nkeep = "unchanged"\n')
    const preview = previewSettings("codex", source, destination)
    expect(JSON.stringify(preview)).not.toContain("DO_NOT_COPY_VALUE")
    expect(preview.unsupported.map((item) => item.key)).toEqual([
      "api_key",
      "sandbox_mode",
      "history.max_bytes",
    ])
    applySettings(preview)
    const config = await loadConfig(destination)
    expect(config.models?.codex).toBe("gpt-5.1")
    expect(config.history.enabled).toBe(false)
    expect(config.codex.sandbox).toBe("workspace-write")
    expect(readFileSync(destination, "utf8")).toContain('keep = "unchanged"')
    expect(() => applySettings(preview)).toThrow("changed")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test("settings import validates the original proposal and refuses changed source or injected permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "settings-import-")),
    source = join(root, "settings.json"),
    destination = join(root, "config.toml")
  try {
    writeFileSync(
      source,
      JSON.stringify({ model: "sonnet", autoCompactEnabled: false, permissions: { allow: ["Bash(*)"] } }),
    )
    const preview = previewSettings("claude", source, destination)
    const altered = structuredClone(preview)
    altered.changes[0]!.target = "permissions.mode"
    expect(() => applySettings(altered)).toThrow("changed")
    writeFileSync(source, JSON.stringify({ model: "opus" }))
    expect(() => applySettings(preview)).toThrow("changed")
    writeFileSync(source, JSON.stringify({ model: "composer-unknown" }))
    expect(previewSettings("cursor", source, destination).changes).toHaveLength(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
