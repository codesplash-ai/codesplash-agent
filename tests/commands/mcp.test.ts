import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runMcpCommand } from "../../src/commands/mcp.ts"

test("MCP management preserves raw settings, never starts a server and invalidates changed executable trust", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "cs-mcp-command-")))
  const cfg = join(cwd, "config"),
    data = join(cwd, "data"),
    script = join(cwd, "fixture.js")
  const env = { CODESPLASH_AGENT_CONFIG_DIR: cfg, CODESPLASH_AGENT_DATA_DIR: data }
  let printed = ""
  const run = async (args: string[]) => {
    printed = ""
    expect(
      await runMcpCommand(args, {
        env,
        cwd,
        output: (text) => {
          printed += text
        },
      }),
    ).toBe(0)
    return JSON.parse(printed)
  }
  try {
    await mkdir(cfg)
    await writeFile(
      join(cfg, "config.toml"),
      'future="keep"\n[profiles.work.models]\ncodesplash="fixture:model"\n',
    )
    await writeFile(script, 'throw new Error("MUST_NOT_EXECUTE");')
    await run(["add", "fixture", "--", "/usr/bin/true", script, "-c", "literal", "--help"])
    const listed = await run(["list"])
    expect(listed.servers[0].enabled).toBe(false)
    const added = Bun.TOML.parse(await readFile(join(cfg, "config.toml"), "utf8")) as Record<string, unknown>
    expect(added.future).toBe("keep")
    expect(added.profiles).toEqual({ work: { models: { codesplash: "fixture:model" } } })
    await run(["enable", "fixture"])
    const review = await run(["show", "fixture"])
    expect(review.trusted).toBe(false)
    expect(review.connected).toBe(false)
    expect(review.config.args).toEqual([script, "-c", "literal", "--help"])
    expect((await run(["trust", "fixture", "--fingerprint", review.fingerprint])).trusted).toBe(true)
    await writeFile(script, 'throw new Error("CHANGED_MUST_NOT_EXECUTE");')
    expect((await run(["doctor", "fixture"])).trusted).toBe(false)
    await expect(run(["trust", "fixture", "--fingerprint", review.fingerprint])).rejects.toThrow(
      "changed since review",
    )
    await run(["remove", "fixture"])
    expect((await run(["list"])).servers).toEqual([])
    expect(await readFile(join(cfg, "config.toml"), "utf8")).toContain('future = "keep"')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
