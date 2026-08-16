import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  configDirectory,
  dataDirectory,
  defaultConfig,
  loadConfig,
  saveConfig,
} from "../../src/core/config.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe("agent config", () => {
  test("defaults to the full default config when no file exists", async () => {
    const directory = await temporaryDirectory()
    expect(await loadConfig(join(directory, "config.toml"))).toEqual(defaultConfig)
  })

  test("persists the full versioned config and round-trips it", async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, "nested", "config.toml")
    const config = {
      schemaVersion: 1 as const,
      theme: "light" as const,
      history: { enabled: false },
      codex: { sandbox: "read-only" as const, approvalPolicy: "untrusted" as const },
    }

    await saveConfig(config, path)

    expect(await loadConfig(path)).toEqual(config)
    expect(await readFile(path, "utf8")).toBe(
      [
        "schemaVersion = 1",
        'theme = "light"',
        "",
        "[history]",
        "enabled = false",
        "",
        "[codex]",
        'sandbox = "read-only"',
        'approvalPolicy = "untrusted"',
        "",
      ].join("\n"),
    )
  })

  test("fills defaults for omitted fields and ignores unknown keys", async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, "config.toml")
    await Bun.write(path, 'schemaVersion = 1\ntheme = "dark"\nfutureSetting = "x"\n[future]\nkey = 1\n')

    expect(await loadConfig(path)).toEqual({ ...structuredClone(defaultConfig), theme: "dark" })
  })

  test("aggregates every invalid field into one actionable error", async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, "config.toml")
    await Bun.write(
      path,
      [
        "schemaVersion = 2",
        'theme = "green"',
        "[history]",
        'enabled = "yes"',
        "[codex]",
        'sandbox = "yolo"',
      ].join("\n"),
    )

    const error = await loadConfig(path).then(
      () => null,
      (thrown: Error) => thrown,
    )
    expect(error?.message).toContain(`Invalid config at ${path}:`)
    expect(error?.message).toContain("schemaVersion: got 2, expected 1")
    expect(error?.message).toContain('theme: got "green", expected "system", "dark", or "light"')
    expect(error?.message).toContain('[history].enabled: got "yes", expected true or false')
    expect(error?.message).toContain('[codex].sandbox: got "yolo", expected "read-only" or "workspace-write"')
  })

  test("rejects danger-full-access as a persisted default", async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, "config.toml")
    await Bun.write(path, 'schemaVersion = 1\n[codex]\nsandbox = "danger-full-access"\n')

    expect(loadConfig(path)).rejects.toThrow("full access requires the --full-access flag per session")
  })

  test("uses the platform config directory and supports a test override", () => {
    expect(configDirectory({ CODESPLASH_AGENT_CONFIG_DIR: "/custom" }, "darwin", "/Users/test")).toBe(
      "/custom",
    )
    expect(configDirectory({}, "darwin", "/Users/test")).toBe(
      "/Users/test/Library/Application Support/codesplash-agent",
    )
    expect(configDirectory({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/test")).toBe("/xdg/codesplash-agent")
  })

  test("uses the platform data directory and supports a test override", () => {
    expect(dataDirectory({ CODESPLASH_AGENT_DATA_DIR: "/data" }, "linux", "/home/test")).toBe("/data")
    expect(dataDirectory({}, "darwin", "/Users/test")).toBe(
      "/Users/test/Library/Application Support/codesplash-agent",
    )
    expect(dataDirectory({ XDG_DATA_HOME: "/xdg-data" }, "linux", "/home/test")).toBe(
      "/xdg-data/codesplash-agent",
    )
    expect(dataDirectory({}, "linux", "/home/test")).toBe("/home/test/.local/share/codesplash-agent")
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codesplash-agent-config-"))
  temporaryDirectories.push(directory)
  return directory
}
