import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applySettings, previewSettings } from "../../src/commands/import-settings.ts"
import { resolveConfig } from "../../src/core/config/resolver.ts"
import { loadConfig } from "../../src/core/config.ts"

test("Codex profile model import stays inactive and omits executable settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "settings-profile-")),
    source = join(root, "source.toml"),
    destination = join(root, "config.toml")
  try {
    writeFileSync(
      source,
      '[profiles.work]\nmodel="gpt-5.1"\n[profiles.work.mcp_servers.remote]\ncommand="DO_NOT_COPY"',
    )
    const preview = previewSettings("codex", source, destination)
    expect(JSON.stringify(preview)).not.toContain("DO_NOT_COPY")
    applySettings(preview)
    expect((await resolveConfig(destination, [], { env: {} })).models).toBeUndefined()
    expect((await resolveConfig(destination, [], { env: {}, profile: "work" })).models?.codex).toBe("gpt-5.1")
    expect(preview.unsupported).toHaveLength(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

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

test("MCP settings import is inert, preserves literal argv and rejects credentials and collisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "settings-mcp-")),
    source = join(root, "settings.json"),
    destination = join(root, "config.toml")
  try {
    writeFileSync(
      source,
      JSON.stringify({
        mcpServers: {
          fixture: { command: "/usr/bin/printf", args: ["", "a", "a"], enabled: true },
          remote: { type: "http", url: "https://example.test/mcp" },
          secret: { command: "helper", env: { API_KEY: "DO_NOT_COPY" } },
          existing: { command: "replacement" },
        },
      }),
    )
    writeFileSync(
      destination,
      '[mcp.servers.existing]\ntransport="stdio"\ncommand="original"\nenabled=true\n',
    )
    const preview = previewSettings("claude", source, destination)
    expect(preview.changes).toHaveLength(2)
    expect(preview.unsupported).toHaveLength(2)
    expect(JSON.stringify(preview)).not.toContain("DO_NOT_COPY")
    applySettings(preview)
    const config = await loadConfig(destination)
    expect(config.mcp?.servers.fixture).toMatchObject({ enabled: false, args: ["", "a", "a"] })
    expect(config.mcp?.servers.remote?.enabled).toBe(false)
    expect(config.mcp?.servers.existing).toMatchObject({ enabled: true, command: "original" })
    expect(config.mcp?.servers.secret).toBeUndefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
