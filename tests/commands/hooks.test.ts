import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runHooksCommand } from "../../src/commands/hooks.ts"

test("hook management preserves the raw source and requires the current reviewed fingerprint", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hooks-cli-"))),
    cfg = join(root, "config")
  const env = { CODESPLASH_AGENT_CONFIG_DIR: cfg, CODESPLASH_AGENT_DATA_DIR: join(root, "data") }
  let printed = ""
  const run = async (args: string[]) => {
    printed = ""
    await runHooksCommand(args, {
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
    await writeFile(join(root, "handler.sh"), "exit 99 # NEVER EXECUTE DURING REVIEW\n")
    await writeFile(
      join(cfg, "config.toml"),
      `future="preserve"\n[profiles.work.models]\ncodesplash="fixture:model"\n[hooks.handlers.fixture]\nkind="command"\ncommand="/bin/sh"\nargs=[${JSON.stringify(join(root, "handler.sh"))}]\nevents=["tool.before"]\n`,
    )
    expect((await run(["list"])).handlers[0].enabled).toBe(false)
    await run(["enable", "fixture"])
    const review = await run(["show", "fixture"])
    expect(review.trusted).toBe(false)
    expect((await run(["trust", "fixture", "--fingerprint", review.fingerprint])).trusted).toBe(true)
    await writeFile(join(root, "handler.sh"), "exit 98 # changed\n")
    expect((await run(["show", "fixture"])).trusted).toBe(false)
    await expect(run(["trust", "fixture", "--fingerprint", review.fingerprint])).rejects.toThrow("changed")
    await run(["disable", "fixture"])
    expect((await run(["list"])).handlers[0].enabled).toBe(false)
    const raw = Bun.TOML.parse(await readFile(join(cfg, "config.toml"), "utf8")) as Record<string, unknown>
    expect(raw.future).toBe("preserve")
    expect(raw.profiles).toEqual({ work: { models: { codesplash: "fixture:model" } } })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
