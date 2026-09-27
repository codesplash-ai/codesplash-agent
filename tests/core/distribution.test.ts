import { expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveConfig } from "../../src/core/config/resolver.ts"
import { type FleetPayload, readFleetSources, refreshFleet } from "../../src/core/distribution/fleet.ts"
import { signDocument, verifyDocument } from "../../src/core/distribution/signed.ts"
import {
  type ReleaseManifest,
  UpdateManager,
  type UpdateSettings,
  validateRelease,
} from "../../src/core/distribution/update.ts"
import { assertVersion, compareVersions } from "../../src/core/distribution/versions.ts"
import { featureAnnouncements, resolveFeatures, setFeature } from "../../src/core/features.ts"
import { networkFetch, networkTLS, responseBytes } from "../../src/core/network.ts"
import { atomic, digest } from "../../src/core/session/files.ts"

function keys() {
  const pair = generateKeyPairSync("ed25519")
  return { ...pair, trusted: { test: pair.publicKey.export({ type: "spki", format: "pem" }).toString() } }
}
function stamp(kind: string, revision = 1) {
  return { version: 1 as const, kind, revision, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 3600000 }
}

test("signed fleet sources fail closed and intersect native managed ceilings; refresh prevents revision rollback", async () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-test-")),
    key = keys(),
    path = join(root, "fleet.json")
  const payload: FleetPayload = {
    ...stamp("fleet"),
    kind: "fleet",
    constraints: { permissionModes: ["default"], pluginIds: ["allowed"], featureIds: ["clock"] },
    settings: {
      disableFeatures: ["clock"],
      announcements: [{ id: "notice", text: "Hello\u001b world", minimum: "0.1.0" }],
    },
  }
  const envelope = signDocument(payload, "test", key.privateKey)
  try {
    atomic(
      path,
      JSON.stringify({
        version: 1,
        keys: key.trusted,
        document: envelope,
        url: "https://policy.example.test/current.json",
      }),
    )
    atomic(
      join(root, "managed.toml"),
      'permissionModes=["default","accept-edits"]\npluginIds=["allowed","other"]\n',
    )
    const config = await resolveConfig(join(root, "config.toml"))
    expect(config.resolution?.constraints.pluginIds).toEqual(["allowed"])
    expect(config.resolution?.constraints.permissionModes).toEqual(["default"])
    await expect(
      resolveConfig(join(root, "config.toml"), ['permissions.mode="accept-edits"']),
    ).rejects.toThrow("managed")
    expect(resolveFeatures(["clock", "browser"], root)).toEqual([])
    setFeature("browser", true, root)
    expect(resolveFeatures([], root)).toEqual([])
    expect(featureAnnouncements(root)[0]?.text).toBe("Hello  world")
    const next = signDocument({ ...payload, revision: 2, settings: {} }, "test", key.privateKey)
    await refreshFleet(path, (async () => Response.json(next)) as unknown as typeof fetch)
    expect(resolveFeatures(["clock"], root)).toEqual(["clock"])
    await expect(
      refreshFleet(path, (async () => Response.json(envelope)) as unknown as typeof fetch),
    ).rejects.toThrow("rollback")
    expect(readFleetSources(root, [])[0]?.payload.revision).toBe(2)
    const bad = {
      ...next,
      payload: Buffer.from(JSON.stringify({ ...payload, revision: 3 })).toString("base64"),
    }
    await expect(
      refreshFleet(path, (async () => Response.json(bad)) as unknown as typeof fetch),
    ).rejects.toThrow("verification")
    const invalid = signDocument(
      { ...payload, revision: 3, constraints: { allowEverything: true } },
      "test",
      key.privateKey,
    )
    await expect(
      refreshFleet(path, (async () => Response.json(invalid)) as unknown as typeof fetch),
    ).rejects.toThrow("Unknown managed")
    const expired = signDocument(
      { ...payload, issuedAt: Date.now() - 10000, expiresAt: Date.now() - 1000 },
      "test",
      key.privateKey,
    )
    expect(() => verifyDocument(expired, "fleet", key.trusted)).toThrow("expired")
    expect(() => verifyDocument(envelope, "release", key.trusted)).toThrow("invalid")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("verified updates stage payloads, migrate config, recover a partial activation, and preserve a reviewed rollback", async () => {
  const root = mkdtempSync(join(tmpdir(), "update-test-")),
    key = keys()
  const settings: UpdateSettings = {
    version: 1,
    root: join(root, "install"),
    configPath: join(root, "config.toml"),
    manifestUrl: "https://releases.example.test/manifest.json",
    keys: key.trusted,
    policy: { channel: "stable" },
  }
  let content = Buffer.from("first release"),
    fail = false
  let payload: ReleaseManifest = {
    ...stamp("release"),
    kind: "release",
    release: "1.0.0",
    target: `${process.platform}-${process.arch}`,
    baseUrl: "https://releases.example.test/files/",
    files: [{ path: "codesplash", sha256: digest(content), size: content.length, executable: true }],
  }
  const fetcher = (async (input: string | URL | Request) => {
    if (String(input).endsWith("manifest.json"))
      return Response.json(signDocument(payload, "test", key.privateKey))
    return fail ? new Response("bad", { status: 503 }) : new Response(content)
  }) as unknown as typeof fetch
  const manager = new UpdateManager(settings, fetcher)
  try {
    atomic(settings.configPath, 'oldSetting="kept"\n')
    const first = await manager.apply()
    expect(readFileSync(join(first.launcher), "utf8")).toBe("first release")
    content = Buffer.from("second release")
    payload = {
      ...payload,
      revision: 2,
      release: "1.1.0",
      files: [{ path: "codesplash", sha256: digest(content), size: content.length, executable: true }],
      migrations: [{ from: "1.0.0", rename: { oldSetting: "newSetting" } }],
    }
    fail = true
    await expect(manager.apply()).rejects.toThrow("503")
    expect(manager.status().active).toBe(first.current)
    fail = false
    const second = await manager.apply()
    expect(readFileSync(settings.configPath, "utf8")).toContain('newSetting = "kept"')
    // Restore the exact persisted state after the config phase, before pointer publication.
    const journal = JSON.parse(readFileSync(join(settings.root, "last-update.json"), "utf8"))
    journal.phase = "config"
    atomic(join(settings.root, "update-journal.json"), JSON.stringify(journal))
    unlinkSync(join(settings.root, "current"))
    symlinkSync(`versions/${first.current}`, join(settings.root, "current"))
    expect(manager.status().recoveryRequired).toBe(true)
    await expect(manager.apply()).rejects.toThrow("recovery")
    expect(manager.recover(false).current).toBe(second.current)
    expect(manager.rollback().current).toBe(first.current)
    expect(readFileSync(settings.configPath, "utf8")).toBe('oldSetting="kept"\n')
    expect(manager.status().revision).toBe(2)
    payload = { ...payload, revision: 1, release: "1.2.0" }
    await expect(manager.inspect()).rejects.toThrow("rollback")
    chmodSync(join(settings.root, "versions", first.current!, "codesplash"), 0o600)
    writeFileSync(join(settings.root, "versions", first.current!, "codesplash"), "tampered")
    expect(() => manager.verifyInstalled(first.current!)).toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("release admission rejects traversal, reserved filenames, wrong targets and channel/pin violations", () => {
  const base: ReleaseManifest = {
    ...stamp("release"),
    kind: "release",
    release: "1.0.0",
    target: `${process.platform}-${process.arch}`,
    baseUrl: "https://release.example.test/",
    files: [{ path: "codesplash", size: 0, sha256: digest(""), executable: true }],
  }
  for (const path of [
    "../escape",
    "/absolute",
    "CON.txt",
    "nested/../escape",
    ".release.json",
    "nested/trailing.",
  ])
    expect(() => validateRelease({ ...base, files: [{ ...base.files[0]!, path }] })).toThrow()
  expect(() => validateRelease({ ...base, target: "other" })).toThrow("target")
  expect(() => assertVersion("1.0.0-alpha.1", { channel: "stable" })).toThrow()
  expect(() => assertVersion("1.2.0", { pin: "1.1.0" })).toThrow()
  expect(compareVersions("1.0.0-alpha.2", "1.0.0-alpha.10")).toBe(-1)
})

test("network policy refuses offline before I/O, retains TLS verification, bounds downloads, and breaks failing uploads", async () => {
  let count = 0
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    count++
    expect((init as RequestInit & { tls: { rejectUnauthorized: boolean } }).tls.rejectUnauthorized).toBe(true)
    return new Response("failed", { status: 503 })
  }) as unknown as typeof fetch
  await expect(
    networkFetch("https://offline.example.test", {}, { env: { CODESPLASH_OFFLINE: "1" }, fetcher }),
  ).rejects.toThrow("offline")
  expect(count).toBe(0)
  expect(networkTLS({ CODESPLASH_EXTRA_CA: "/missing/m11-ca.pem" })).toEqual({ rejectUnauthorized: true })
  expect(() =>
    networkTLS({ CODESPLASH_EXTRA_CA: "/missing/m11-ca.pem", CODESPLASH_REQUIRE_EXTRA_CA: "1" }),
  ).toThrow("Required")
  for (let i = 0; i < 3; i++)
    await networkFetch("https://upload.example.test", { method: "POST" }, { env: {}, fetcher, upload: true })
  await expect(
    networkFetch("https://upload.example.test", { method: "POST" }, { env: {}, fetcher, upload: true }),
  ).rejects.toThrow("circuit")
  expect(count).toBe(3)
  await expect(responseBytes(new Response("longer"), 2)).rejects.toThrow("limit")
})

test.skipIf(process.platform !== "darwin")(
  "macOS managed preferences load signed JSON and preserve dotted announcement IDs",
  () => {
    const root = mkdtempSync(join(tmpdir(), "m11-mdm-")),
      key = keys(),
      path = join(root, "managed.plist")
    try {
      const trust = JSON.stringify({
        version: 1,
        keys: key.trusted,
        document: signDocument(
          {
            ...stamp("fleet"),
            settings: { announcements: [{ id: "notice.v2", text: "Managed notice" }] },
          },
          "test",
          key.privateKey,
        ),
      })
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
      writeFileSync(
        path,
        `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Fleet</key><string>${trust}</string></dict></plist>`,
      )
      const sources = readFleetSources(root, [path])
      expect(sources).toHaveLength(1)
      expect(featureAnnouncements(root, sources)).toEqual([{ id: "notice.v2", text: "Managed notice" }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)
