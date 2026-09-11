import { expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unknownConfigFields } from "../../src/core/config/resolver.ts"
import { loadConfig, saveConfig, validateConfig } from "../../src/core/config.ts"

test("MCP configuration is inert by default and rejects plaintext credentials and mixed transports", () => {
  const server = (value: unknown) => validateConfig({ mcp: { servers: { fixture: value } } }, "fixture")
  const config = server({ transport: "stdio", command: "bun", args: ["", "a", "a"] })
  expect(config.mcp?.servers.fixture?.enabled).toBe(false)
  expect(config.mcp?.servers.fixture?.args).toEqual(["", "a", "a"])
  expect(() => server({ transport: "stdio", command: "bun", token: "SECRET" })).toThrow("references")
  expect(() => server({ transport: "stdio", command: "bun", url: "https://example.test" })).toThrow(
    "HTTP settings",
  )
  expect(() => server({ transport: "http", url: "https://example.test", args: [] })).toThrow(
    "process settings",
  )
  expect(() => server({ transport: "http", url: "https://example.test/?token=secret" })).toThrow(
    "without credentials",
  )
  expect(() => server({ transport: "http", url: "http://127.0.0.1:9000" })).toThrow("loopback")
  expect(() => server({ transport: "http", url: "http://localhost:9000", allowLoopback: true })).toThrow(
    "loopback",
  )
  expect(
    server({ transport: "http", url: "http://127.0.0.1:9000", allowLoopback: true }).mcp?.servers.fixture
      ?.url,
  ).toBe("http://127.0.0.1:9000/")
  expect(() => server({ transport: "stdio", command: "bun", environment: ["NODE_OPTIONS"] })).toThrow(
    "injection",
  )
  expect(() => server({ transport: "stdio", command: "bun", requestTimeoutMs: 120001 })).toThrow("120000")
  expect(
    unknownConfigFields({ mcp: { servers: { fixture: { transport: "stdio", command: "bun" } } } }),
  ).toEqual([])
})

test("MCP policy layers intersect allowlists, retain denies and roundtrip without transport leakage", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "cs-mcp-config-")))
  const path = join(cwd, "config.toml")
  try {
    await writeFile(
      path,
      `[mcp.servers.fixture]\ntransport="stdio"\ncommand="bun"\nallowTools=["a","b"]\nreadOnlyTools=["a","b"]\ndenyTools=["c"]\n[profiles.tight.mcp.servers.fixture]\nallowTools=["b","c"]\nreadOnlyTools=["b","c"]\ndenyTools=["a"]\n`,
    )
    const config = await loadConfig(path, [], {
      cwd,
      env: {},
      workspaceTrusted: false,
      profile: "tight",
      strict: true,
    })
    expect(config.mcp?.servers.fixture?.allowTools).toEqual(["b"])
    expect(config.mcp?.servers.fixture?.readOnlyTools).toEqual(["b"])
    expect(config.mcp?.servers.fixture?.denyTools).toEqual(["c", "a"])
    await writeFile(join(cwd, "managed.toml"), 'mcpServers=[]\nmcpTools=["fixture/b"]\n')
    const managed = await loadConfig(path, [], { cwd, env: {}, workspaceTrusted: false })
    expect(managed.resolution?.constraints.mcpServers).toEqual([])
    expect(managed.resolution?.constraints.mcpTools).toEqual(["fixture/b"])
    for (const server of [
      { transport: "stdio", command: "bun" },
      { transport: "http", url: "https://example.test" },
    ]) {
      const plain = validateConfig({ mcp: { servers: { fixture: server } } }, path)
      await saveConfig(plain, path)
      const loaded = await loadConfig(path)
      expect(loaded.mcp).toEqual(plain.mcp)
      expect(unknownConfigFields(Bun.TOML.parse(await readFile(path, "utf8")))).toEqual([])
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
