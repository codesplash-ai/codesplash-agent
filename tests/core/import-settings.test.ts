import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applySettings, previewSettings } from "../../src/commands/import-settings.ts"
import { resolveConfig } from "../../src/core/config/resolver.ts"
import { loadConfig } from "../../src/core/config.ts"

test("hook migration is inert and reports foreign execution and output incompatibilities", async () => {
  const root = mkdtempSync(join(tmpdir(), "settings-hooks-")),
    source = join(root, "hooks.json"),
    destination = join(root, "config.toml")
  try {
    writeFileSync(
      source,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: '/bin/echo "literal argument"', timeout: 5 }],
            },
          ],
          PostToolUse: [{ hooks: [{ type: "http", url: "https://example.test/hook" }] }],
          Stop: [{ hooks: [{ type: "command", command: "/bin/true", async: true }] }],
          SubagentStart: [{ hooks: [{ type: "command", command: "OMITTED_SUBAGENT" }] }],
          UserPromptSubmit: [
            {
              hooks: [
                { type: "command", command: 'echo "$SECRET_VALUE"', env: { TOKEN: "OMITTED_CREDENTIAL" } },
              ],
            },
          ],
        },
      }),
    )
    const preview = previewSettings("claude", source, destination)
    expect(preview.changes).toHaveLength(2)
    expect(preview.unsupported).toHaveLength(3)
    expect(JSON.stringify(preview)).not.toContain("OMITTED_")
    expect(preview.changes.every((entry) => entry.effect.includes("not translated"))).toBe(true)
    applySettings(preview)
    const config = await loadConfig(destination, [], { env: {} })
    const handlers = Object.values(config.hooks?.handlers ?? {})
    expect(
      handlers.every(
        (entry) =>
          !entry.enabled && !entry.allowInputRewrite && !entry.allowContinuation && entry.share.length === 0,
      ),
    ).toBe(true)
    expect(handlers.find((entry) => entry.kind === "command")?.args).toEqual(["literal argument"])
    expect(handlers.find((entry) => entry.kind === "command")?.matchTools).toEqual(["bash"])
    expect(previewSettings("claude", source, destination).changes).toHaveLength(0)
    writeFileSync(
      source,
      JSON.stringify({
        hooks: {
          beforeShellExecution: [{ command: "/bin/true" }],
          afterAgentThought: [{ command: "OMITTED_REASONING" }],
        },
      }),
    )
    const cursor = previewSettings("cursor", source, join(root, "cursor.toml"))
    expect(cursor.changes).toHaveLength(1)
    expect(cursor.changes[0]?.value).toMatchObject({
      matchTools: ["bash"],
      events: ["tool.before"],
      enabled: false,
    })
    expect(JSON.stringify(cursor)).not.toContain("OMITTED_REASONING")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

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

test("plugin migration retains inactive source references without installation or trust", async () => {
  const root = mkdtempSync(join(tmpdir(), "settings-plugins-")),
    source = join(root, "plugins.json"),
    destination = join(root, "config.toml")
  try {
    writeFileSync(
      source,
      JSON.stringify({ enabledPlugins: { "fixture@market": true }, plugins: ["npm:fixture@1.0.0"] }),
    )
    const preview = previewSettings("claude", source, destination)
    expect(preview.changes).toHaveLength(2)
    expect(
      preview.changes.every(
        (change) =>
          change.target.startsWith("plugins.pending.") &&
          (change.value as { enabled: boolean }).enabled === false,
      ),
    ).toBe(true)
    applySettings(preview)
    const config = await loadConfig(destination, [], { cwd: root, env: {}, strict: true })
    expect(Object.keys(config.plugins?.pending ?? {})).toHaveLength(2)
    expect(config.plugins?.entries).toEqual({})
    expect(config.pluginResources).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
