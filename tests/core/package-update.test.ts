import { expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PackageUpdateManager } from "../../src/core/distribution/package-update.ts"
import { signDocument } from "../../src/core/distribution/signed.ts"
import type { ReleaseManifest, UpdateSettings } from "../../src/core/distribution/update.ts"
import { atomic, digest } from "../../src/core/session/files.ts"

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "package-update-")),
    key = generateKeyPairSync("ed25519")
  const artifacts = new Map([
    ["1.0.0", Buffer.from("old package")],
    ["1.1.0", Buffer.from("new package")],
  ])
  const settings: UpdateSettings = {
    version: 1,
    root: join(root, "state"),
    configPath: join(root, "config.toml"),
    manifestUrl: "https://updates.example.test/manifest.json",
    policy: { channel: "stable" },
    keys: { test: key.publicKey.export({ format: "pem", type: "spki" }).toString() },
    manager: {
      kind: "npm",
      executable: Bun.which("npm") ?? "/usr/bin/npm",
      installRoot: join(root, "prefix"),
    },
  }
  const manifest: ReleaseManifest = {
    version: 1,
    kind: "release",
    revision: 2,
    issuedAt: Date.now() - 1000,
    expiresAt: Date.now() + 3600000,
    release: "1.1.0",
    target: `${process.platform}-${process.arch}`,
    baseUrl: "https://updates.example.test/files/",
    files: [
      {
        path: process.platform === "win32" ? "codesplash.exe" : "codesplash",
        size: 1,
        sha256: digest("x"),
        executable: true,
      },
    ],
    migrations: [{ from: "1.0.0", rename: { oldSetting: "newSetting" } }],
  }
  const fetcher = (async (input: string | URL | Request) => {
    if (String(input) === settings.manifestUrl)
      return Response.json(signDocument(manifest, "test", key.privateKey))
    const data = artifacts.get(
      String(input)
        .split("/")
        .at(-1)!
        .replace(/\.tgz$/, ""),
    )
    return data ? new Response(data) : new Response("missing", { status: 404 })
  }) as typeof fetch
  const refresh = () => {
    manifest.npmArtifacts = [...artifacts].map(([version, data]) => ({
      version,
      url: `https://updates.example.test/${version}.tgz`,
      size: data.length,
      sha256: digest(data),
    }))
  }
  refresh()
  atomic(settings.configPath, 'oldSetting="retained"\n')
  return { root, settings, manifest, fetcher, artifacts, refresh }
}

test("manager updates recover after activation, reject config conflicts and retain rollback revision floor", async () => {
  const f = fixture()
  let installed = "1.0.0",
    interrupt = true
  const manager = new PackageUpdateManager(f.settings, f.fetcher, async (argv) => {
    if (argv[1] === "list")
      return JSON.stringify({ dependencies: { "codesplash-agent": { version: installed } } })
    expect(argv).toContain("--ignore-scripts")
    expect(argv).toContain("--offline")
    installed = readFileSync(argv.at(-1)!, "utf8") === "old package" ? "1.0.0" : "1.1.0"
    if (interrupt) {
      interrupt = false
      throw new Error("interrupted")
    }
    return ""
  })
  try {
    await expect(manager.apply()).rejects.toThrow("interrupted")
    expect(installed).toBe("1.1.0")
    expect(manager.status().recoveryRequired).toBe(true)
    atomic(f.settings.configPath, "userEdit=true\n")
    await expect(manager.recover(false)).rejects.toThrow("Config changed")
    atomic(f.settings.configPath, 'oldSetting="retained"\n')
    await manager.recover(false)
    expect(readFileSync(f.settings.configPath, "utf8")).toContain("newSetting")
    expect(manager.status().recoveryRequired).toBe(false)
    await manager.rollback()
    expect(installed).toBe("1.0.0")
    expect(readFileSync(f.settings.configPath, "utf8")).toBe('oldSetting="retained"\n')
    expect(manager.status().revision).toBe(2)
    f.manifest.revision = 1
    await expect(manager.apply()).rejects.toThrow("rollback")
    expect(existsSync(join(f.settings.root, "current"))).toBe(false)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test("signed artifact mismatch refuses manager mutation", async () => {
  const f = fixture()
  let mutations = 0
  const manager = new PackageUpdateManager(f.settings, f.fetcher, async (argv) => {
    if (argv[1] === "list")
      return JSON.stringify({ dependencies: { "codesplash-agent": { version: "1.0.0" } } })
    mutations++
    return ""
  })
  try {
    f.manifest.npmArtifacts![1]!.sha256 = "0".repeat(64)
    await expect(manager.apply()).rejects.toThrow("checksum")
    expect(mutations).toBe(0)
    expect(manager.status().recoveryRequired).toBe(false)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test("real npm isolated prefix upgrades and rolls back verified offline tarballs", async () => {
  const f = fixture()
  async function npm(args: string[]) {
    const child = Bun.spawn([f.settings.manager!.executable, ...args], {
      cwd: f.root,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code) throw new Error(err)
    return out
  }
  try {
    for (const version of f.artifacts.keys()) {
      const dir = join(f.root, version)
      atomic(
        join(dir, "package.json"),
        JSON.stringify({
          name: "codesplash-agent",
          version,
          bin: { codesplash: "cli.js" },
          scripts: { install: "exit 91" },
        }),
      )
      atomic(join(dir, "cli.js"), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)})\n`)
      const packed = JSON.parse(await npm(["pack", "--ignore-scripts", "--json", dir]))
      f.artifacts.set(version, readFileSync(join(f.root, packed[0].filename)))
    }
    f.refresh()
    await npm([
      "install",
      "--global",
      "--prefix",
      f.settings.manager!.installRoot,
      "--ignore-scripts",
      "--offline",
      "--no-audit",
      "--no-fund",
      join(f.root, "codesplash-agent-1.0.0.tgz"),
    ])
    const manager = new PackageUpdateManager(f.settings, f.fetcher)
    expect(await manager.installedVersion()).toBe("1.0.0")
    await manager.apply()
    expect(await manager.installedVersion()).toBe("1.1.0")
    await manager.rollback()
    expect(await manager.installedVersion()).toBe("1.0.0")
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
}, 60000)
