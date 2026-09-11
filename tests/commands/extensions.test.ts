import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runExtensionsCommand } from "../../src/commands/extensions.ts"

test("extension management preserves the raw source and requires the current reviewed fingerprint", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "extensions-cli-"))),
    cfg = join(root, "config")
  const env = { CODESPLASH_AGENT_CONFIG_DIR: cfg, CODESPLASH_AGENT_DATA_DIR: join(root, "data") }
  let printed = ""
  const run = async (args: string[]) => {
    printed = ""
    await runExtensionsCommand(args, {
      cwd: root,
      env,
      output: (value) => {
        printed += value
      },
    })
    return JSON.parse(printed)
  }
  try {
    await mkdir(cfg)
    await mkdir(join(root, "package"))
    await writeFile(join(root, "package/entry.ts"), "throw new Error('NEVER IMPORT DURING REVIEW')")
    await writeFile(
      join(cfg, "config.toml"),
      `future="preserve"\n[profiles.work.models]\ncodesplash="fixture:model"\n[extensions.entries.fixture]\nroot=${JSON.stringify(join(root, "package"))}\nentry="entry.ts"\n`,
    )
    expect((await run(["list"])).entries.fixture.enabled).toBe(false)
    await run(["enable", "fixture"])
    const review = await run(["show", "fixture"])
    expect(review.trusted).toBe(false)
    expect((await run(["trust", "fixture", "--fingerprint", review.fingerprint])).trusted).toBe(true)
    await writeFile(join(root, "package/entry.ts"), "throw new Error('changed')")
    expect((await run(["show", "fixture"])).trusted).toBe(false)
    await expect(run(["trust", "fixture", "--fingerprint", review.fingerprint])).rejects.toThrow("changed")
    await run(["disable", "fixture"])
    expect((await run(["list"])).entries.fixture.enabled).toBe(false)
    const raw = Bun.TOML.parse(await readFile(join(cfg, "config.toml"), "utf8")) as Record<string, unknown>
    expect(raw.future).toBe("preserve")
    expect(raw.profiles).toEqual({ work: { models: { codesplash: "fixture:model" } } })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
