import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runPluginCommand } from "../../../src/commands/plugin.ts"
import { resolveConfigForWorkspace } from "../../../src/core/config/resolver.ts"
import { readConfigSource } from "../../../src/core/config/source.ts"
import { loadConfig } from "../../../src/core/config.ts"
import { installerCommand } from "../../../src/engines/codesplash/plugins/acquire.ts"
import { unpackArchive } from "../../../src/engines/codesplash/plugins/files.ts"
import { pluginComponentId } from "../../../src/engines/codesplash/plugins/resolve.ts"
import { stagePackage, verifySelection } from "../../../src/engines/codesplash/plugins/store.ts"

function tar(files: Record<string, string>, type = "0"): Buffer {
  const chunks: Buffer[] = []
  for (const [name, content] of Object.entries(files)) {
    const bytes = Buffer.from(content),
      header = Buffer.alloc(512)
    header.write(name)
    header.write("0000600\0", 100)
    header.write("0000000\0", 108)
    header.write("0000000\0", 116)
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124)
    header.write("00000000000\0", 136)
    header.fill(32, 148, 156)
    header.write(type, 156)
    header.write("ustar\0", 257)
    header.write("00", 263)
    header.write(
      header
        .reduce((sum, n) => sum + n, 0)
        .toString(8)
        .padStart(6, "0") + "\0 ",
      148,
    )
    chunks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512))
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)])
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "plugin-test-"))),
    source = join(root, "source"),
    cfg = join(root, "config"),
    data = join(root, "data")
  await mkdir(source)
  await mkdir(cfg)
  const manifest = {
    schemaVersion: 1,
    api: 1,
    id: "fixture",
    version: "1.0.0",
    commands: ["commands/hello.md"],
    extensions: { main: { entry: "entry.ts" } },
  }
  await mkdir(join(source, "commands"))
  await writeFile(join(source, "commands/hello.md"), "Hello $ARGUMENTS")
  await writeFile(
    join(source, "entry.ts"),
    "export default api => api.registerCommand({name:'hello',description:'Hello',run:()=> 'ONE'})",
  )
  await writeFile(join(source, "codesplash-plugin.json"), JSON.stringify(manifest))
  const env = { CODESPLASH_AGENT_CONFIG_DIR: cfg, CODESPLASH_AGENT_DATA_DIR: data }
  const run = async (args: string[]) => {
    let text = ""
    await runPluginCommand(args, {
      cwd: root,
      env,
      output: (value) => {
        text += value
      },
    })
    return text
      .trim()
      .split(/\n(?=\{)/)
      .map((value) => JSON.parse(value))
      .at(-1)
  }
  return {
    root,
    source,
    cfg,
    data,
    env,
    run,
    manifest,
    close: () => rm(root, { recursive: true, force: true }),
  }
}
test("plugins install inertly, preserve raw source, pin sessions and retain rollback versions", async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.cfg, "config.toml"), 'future="keep"\n')
    const first = await f.run(["install", f.source])
    expect(first.selection.enabled).toBe(false)
    expect((await f.run(["list"])).selections.fixture.integrity).toBe(first.selection.integrity)
    await f.run(["enable", "fixture"])
    const config = await loadConfig(join(f.cfg, "config.toml"), [], { cwd: f.root, env: f.env })
    const id = pluginComponentId("fixture", "extension", "main")
    expect(config.extensions?.entries[id]?.enabled).toBe(true)
    expect(config.resolution?.provenance[`extensions.entries.${id}.entry`]).toEqual(["plugin:fixture"])
    expect(config.pluginResources?.[0]?.paths).toEqual(["commands/hello.md"])
    await writeFile(join(f.source, "entry.ts"), "throw new Error('STAGED VERSION NEVER IMPORTED')")
    const second = await f.run(["update", "fixture"])
    expect(second.selection.integrity).not.toBe(first.selection.integrity)
    expect((await resolveConfigForWorkspace(config, f.root)).plugins?.entries.fixture?.integrity).toBe(
      first.selection.integrity,
    )
    expect(
      (await resolveConfigForWorkspace(config, f.root, true, true)).plugins?.entries.fixture?.integrity,
    ).toBe(second.selection.integrity)
    await f.run(["rollback", "fixture", first.selection.integrity])
    expect((await f.run(["list"])).selections.fixture.integrity).toBe(first.selection.integrity)
    await f.run(["remove", "fixture"])
    await verifySelection(first.selection)
    expect(readConfigSource(join(f.cfg, "config.toml")).raw.future).toBe("keep")
  } finally {
    await f.close()
  }
})
test("source mutation, links, malformed updates and managed pins fail without replacing selection", async () => {
  const f = await fixture()
  try {
    const first = await f.run(["install", f.source])
    await symlink("entry.ts", join(f.source, "linked.ts"))
    await expect(f.run(["update", "fixture"])).rejects.toThrow("links")
    expect((await f.run(["list"])).selections.fixture.integrity).toBe(first.selection.integrity)
    await writeFile(join(first.selection.root, "entry.ts"), "changed")
    await expect(f.run(["enable", "fixture"])).rejects.toThrow("changed")
    await f.run(["disable", "fixture"])
    expect((await f.run(["list"])).selections.fixture.enabled).toBe(false)
    await writeFile(join(f.cfg, "managed.toml"), "pluginIds=[]\n")
    await expect(f.run(["enable", "fixture"])).rejects.toThrow("prohibited")
  } finally {
    await f.close()
  }
})
test("archive parser rejects traversal, symlinks, hardlinks, duplicate names and expansion bombs", async () => {
  const f = await fixture()
  try {
    for (const path of ["../escape", "/escape", "a/../../escape", "a\\b"])
      await expect(unpackArchive(tar({ [path]: "x" }), f.data)).rejects.toThrow()
    for (const type of ["1", "2", "3", "x"])
      await expect(unpackArchive(tar({ file: "x" }, type), f.data)).rejects.toThrow()
    const one = tar({ file: "x" })
    await expect(unpackArchive(Buffer.concat([one.subarray(0, 1024), one]), f.data)).rejects.toThrow(
      "Duplicate",
    )
    await expect(unpackArchive(Bun.gzipSync(Buffer.alloc(129 * 1024 * 1024)))).rejects.toThrow("limit")
  } finally {
    await f.close()
  }
})
test("marketplace browsing is inert and resolves only pinned explicit packages", async () => {
  const f = await fixture()
  try {
    const market = join(f.root, "market")
    await mkdir(market)
    const staged = await stagePackage(f.data, f.source, "plugin")
    await writeFile(
      join(market, "codesplash-marketplace.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "local",
        plugins: { fixture: { source: "npm:fixture@1.0.0", description: "Inert" } },
      }),
    )
    await f.run(["marketplace", "add", market])
    const shown = await f.run(["marketplace", "show", "local"])
    expect(shown.executesCode).toBe(false)
    expect(shown.manifest.plugins.fixture.source).toBe("npm:fixture@1.0.0")
    await f.run(["marketplace", "remove", "local"])
    await verifySelection(staged.selection)
  } finally {
    await f.close()
  }
})
test("pinned Git archives install without checkout hooks and preserve exact commit identity", async () => {
  const f = await fixture()
  try {
    const signal = AbortSignal.timeout(15000)
    await installerCommand(["git", "init", f.source], f.root, f.root, signal)
    await installerCommand(["git", "add", "."], f.source, f.root, signal)
    await installerCommand(
      [
        "git",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "fixture",
      ],
      f.source,
      f.root,
      signal,
    )
    const commit = (await installerCommand(["git", "rev-parse", "HEAD"], f.source, f.root, signal)).trim()
    const staged = await stagePackage(f.data, `git:${f.source}#${commit}`, "plugin")
    expect(staged.selection.source).toBe(`git:${f.source}#${commit}`)
    await verifySelection(staged.selection)
  } finally {
    await f.close()
  }
})
test("npm source and Bun dependency resolution use verified bounded registry archives without scripts", async () => {
  const f = await fixture()
  const pkg = {
    name: "fixture",
    version: "1.0.0",
    dependencies: { "fixture-dependency": "^1.0.0" },
    scripts: { postinstall: "touch MUST_NOT_EXIST" },
  }
  const archive = Bun.gzipSync(
    new Uint8Array(
      tar({
        "package/codesplash-plugin.json": JSON.stringify(f.manifest),
        "package/commands/hello.md": "Hello",
        "package/entry.ts": "export default()=>{}",
        "package/package.json": JSON.stringify(pkg),
      }),
    ),
  )
  const dep = Bun.gzipSync(
    new Uint8Array(
      tar({
        "package/package.json": JSON.stringify({
          name: "fixture-dependency",
          version: "1.0.0",
          main: "index.js",
          scripts: { postinstall: "touch MUST_NOT_EXIST" },
        }),
        "package/index.js": "module.exports = 42",
      }),
    ),
  )
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req): Response {
      const path = decodeURIComponent(new URL(req.url).pathname)
      if (path.endsWith(".tgz")) return new Response(path.includes("dependency") ? dep : archive)
      const name = path.slice(1),
        data = name === "fixture" ? archive : dep
      return Response.json({
        name,
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            ...(name === "fixture" ? pkg : { name, version: "1.0.0" }),
            dist: {
              tarball: `${server.url.origin}/${name}.tgz`,
              integrity: `sha512-${createHash("sha512").update(data).digest("base64")}`,
            },
          },
        },
      })
    },
  })
  try {
    const staged = await stagePackage(f.data, "npm:fixture@1.0.0", "plugin", {
      registry: server.url.origin,
      allowLoopback: true,
    })
    expect(
      await readFile(join(staged.selection.root, "node_modules/fixture-dependency/index.js"), "utf8"),
    ).toContain("42")
    expect(staged.lock.files.some((file) => file.path.includes("MUST_NOT_EXIST"))).toBe(false)
    expect(staged.lock.files.some((file) => file.path === "codesplash-dependencies.lock")).toBe(true)
    await verifySelection(staged.selection)
    expect(staged.lock.registry).toBe(server.url.origin)
    expect(staged.lock.npm?.integrity).toStartWith("sha512-")
    const repeated = await stagePackage(f.data, "npm:fixture@1.0.0", "plugin", {
      registry: server.url.origin,
      allowLoopback: true,
    })
    expect(repeated.selection.integrity).toBe(staged.selection.integrity)
  } finally {
    await server.stop(true)
    await f.close()
  }
}, 30000)
test("explicit builds require exact fingerprint and publish a new disabled version; failures retain selection", async () => {
  const f = await fixture()
  try {
    const first = await f.run(["install", f.source])
    await expect(f.run(["build", "fixture", "--fingerprint", "bad", "--", "false"])).rejects.toThrow(
      "fingerprint",
    )
    await expect(
      f.run(["build", "fixture", "--fingerprint", first.selection.integrity, "--", "false"]),
    ).rejects.toThrow("failed")
    expect((await f.run(["list"])).selections.fixture.integrity).toBe(first.selection.integrity)
    const built = await f.run([
      "build",
      "fixture",
      "--fingerprint",
      first.selection.integrity,
      "--",
      "sh",
      "-c",
      "echo built > built.txt",
    ])
    expect(built.selection.enabled).toBe(false)
    expect(built.selection.integrity).not.toBe(first.selection.integrity)
    expect(await readFile(join(built.selection.root, "built.txt"), "utf8")).toBe("built\n")
    await verifySelection(first.selection)
  } finally {
    await f.close()
  }
})

test("project plugin pins do not cross cwd/trust boundaries and managed required values override pins", async () => {
  const f = await fixture()
  try {
    await f.run(["install", f.source, "--scope", "project"])
    await f.run(["enable", "fixture", "--scope", "project"])
    const path = join(f.cfg, "config.toml")
    const untrusted = await loadConfig(path, [], { cwd: f.root, env: f.env, workspaceTrusted: false })
    expect(untrusted.pluginResources).toEqual([])
    const config = await loadConfig(path, [], { cwd: f.root, env: f.env, workspaceTrusted: true })
    expect(config.pluginResources).toHaveLength(1)
    const other = join(f.root, "other")
    await mkdir(other)
    expect((await resolveConfigForWorkspace(config, other, false)).pluginResources).toEqual([])
    expect((await resolveConfigForWorkspace(config, f.root, false)).pluginResources).toEqual([])
    await writeFile(join(f.cfg, "managed.toml"), "[required.plugins.entries.fixture]\nenabled=false\n")
    expect((await resolveConfigForWorkspace(config, f.root, true)).pluginResources).toEqual([])
    await writeFile(join(f.cfg, "managed.toml"), `pluginPins=["fixture/${"0".repeat(64)}"]\n`)
    await expect(resolveConfigForWorkspace(config, f.root, true)).rejects.toThrow("pin")
  } finally {
    await f.close()
  }
})
