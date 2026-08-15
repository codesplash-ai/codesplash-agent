import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configDirectory, loadConfig, saveConfig } from "../../src/core/config.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe("agent config", () => {
  test("defaults to the detected system theme when no file exists", async () => {
    const directory = await temporaryDirectory()
    expect(await loadConfig(join(directory, "config.toml"))).toEqual({ schemaVersion: 1, theme: "system" })
  })

  test("persists a versioned theme setting", async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, "nested", "config.toml")

    await saveConfig({ schemaVersion: 1, theme: "light" }, path)

    expect(await loadConfig(path)).toEqual({ schemaVersion: 1, theme: "light" })
    expect(await readFile(path, "utf8")).toBe('schemaVersion = 1\ntheme = "light"\n')
  })

  test("rejects an unsupported theme", async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, "config.toml")
    await Bun.write(path, 'schemaVersion = 1\ntheme = "green"\n')

    expect(loadConfig(path)).rejects.toThrow("theme must be system, dark, or light")
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
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codesplash-agent-config-"))
  temporaryDirectories.push(directory)
  return directory
}
