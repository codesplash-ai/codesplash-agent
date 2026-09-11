/** Configuration CLI must work in the standalone release without user state or credentials. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"

const argument = process.argv[2]
if (!argument) throw new Error("Usage: bun scripts/config-smoke.ts /path/to/codesplash")
const binary = resolve(argument)
const root = await realpath(await mkdtemp(join(tmpdir(), "codesplash-config-smoke-")))
try {
  const cwd = join(root, "workspace"),
    config = join(root, "config")
  await mkdir(join(cwd, ".codesplash"), { recursive: true })
  await mkdir(config)
  await writeFile(
    join(config, "config.toml"),
    'theme="light"\n[profiles.careful]\ntheme="dark"\n[profiles.careful.permissions]\nmode="plan"\n',
  )
  await writeFile(join(cwd, ".codesplash", "config.toml"), "invalid project TOML [")
  const env = {
    ...process.env,
    CODESPLASH_AGENT_CONFIG_DIR: config,
    CODESPLASH_AGENT_DATA_DIR: join(root, "data"),
    CODESPLASH_PROFILE: "",
    CODESPLASH_THEME: "light",
  }
  delete (env as NodeJS.ProcessEnv).CODESPLASH_PROFILE
  const run = async (args: string[], okay = true) => {
    const result = await runProcess(
      [...(binary.endsWith(".js") ? [process.execPath, binary] : [binary]), "config", ...args],
      {
        cwd,
        env,
        signal: new AbortController().signal,
        timeoutMs: 30_000,
        maxBytes: 2 * 1024 * 1024,
        structured: true,
      },
    )
    assert.equal(result.exitCode === 0, okay, `${result.stdout}\n${result.stderr}`)
    return result.stdout
  }
  const explained = JSON.parse(await run(["explain", "--profile", "careful", "-c", "theme=dark"]))
  assert.equal(explained.config.theme, "dark")
  assert.equal(explained.config.permissions.mode, "plan")
  assert.ok(
    explained.sources.find((source: { scope: string; disabledReason?: string }) => source.scope === "project")
      .disabledReason,
  )
  assert.ok(explained.provenance.theme.includes("cli"))
  assert.ok(JSON.parse(await run(["schema"])).properties.profiles)
  assert.ok(JSON.parse(await run(["schema", "managed"])).properties.sandboxModes)
  await writeFile(
    join(config, "managed.toml"),
    'permissionModes=["plan"]\n[required.permissions]\nmode="plan"\n',
  )
  assert.equal(
    JSON.parse(await run(["explain", "-c", "permissions.mode=accept-edits"])).config.permissions.mode,
    "plan",
  )
  await run(["validate", "--strict-config", "-c", "unknown.field=true"], false)
  console.log(
    "Compiled configuration smoke passed: precedence, profiles, provenance, untrusted source exclusion, schemas and managed constraints",
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
