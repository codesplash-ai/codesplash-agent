/** Offline release-author operation. Reads a private-key FILE; never accepts keys in argv or publishes. */
import { createPrivateKey } from "node:crypto"
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { validatePackageArtifacts } from "../src/core/distribution/package-update.ts"
import { signDocument } from "../src/core/distribution/signed.ts"
import { type ReleaseManifest, validateRelease } from "../src/core/distribution/update.ts"
import { bytes, digest, json } from "../src/core/session/files.ts"
import { APP_VERSION } from "../src/version.ts"

export function releaseManifest(
  root: string,
  baseUrl: string,
  revision: number,
  target = `${process.platform}-${process.arch}`,
  release = APP_VERSION,
): ReleaseManifest {
  const files: ReleaseManifest["files"] = []
  function walk(relative: string): void {
    const path = join(root, relative),
      info = lstatSync(path)
    if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)))
      throw new Error("Release assets must be private regular files")
    if (info.isDirectory()) {
      for (const name of readdirSync(path).sort()) walk(`${relative}/${name}`)
      return
    }
    if (files.length >= 4096 || info.size > 256 * 1024 * 1024)
      throw new Error("Release asset limits exceeded")
    files.push({
      path: relative,
      size: info.size,
      sha256: digest(readFileSync(path)),
      ...(info.mode & 0o111 || relative === "codesplash.exe" ? { executable: true } : {}),
    })
  }
  for (const path of [
    target.startsWith("win32") ? "codesplash.exe" : "codesplash",
    "sandbox-runtime",
    "LICENSE",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
  ])
    walk(path)
  return validateRelease(
    {
      version: 1,
      kind: "release",
      revision,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 30 * 86400000,
      release,
      target,
      baseUrl,
      files,
    },
    target,
  )
}
if (import.meta.main) {
  const [root, base, revision, keyPath, keyId, output, ...rest] = process.argv.slice(2)
  if (
    !root ||
    !base ||
    !revision ||
    !keyPath ||
    !keyId ||
    !output ||
    (rest.length !== 0 && (rest.length !== 2 || rest[0] !== "--npm-artifacts")) ||
    !Number.isSafeInteger(Number(revision)) ||
    Number(revision) < 1
  )
    throw new Error(
      "Usage: bun scripts/release-manifest.ts ASSET_DIR HTTPS_BASE_URL REVISION PRIVATE_KEY_FILE KEY_ID OUTPUT_FILE [--npm-artifacts DESCRIPTORS.json]",
    )
  const manifest = releaseManifest(resolve(root), base, Number(revision))
  if (rest[1]) {
    const descriptors = json<Array<{ version: string; path: string; url: string }>>(resolve(rest[1]), 65536)
    if (!Array.isArray(descriptors) || descriptors.length > 16)
      throw new Error("Invalid npm artifact descriptors")
    manifest.npmArtifacts = validatePackageArtifacts(
      descriptors.map((item) => {
        const data = bytes(resolve(item.path), 64 * 1024 * 1024)
        return { version: item.version, url: item.url, size: data.length, sha256: digest(data) }
      }),
    )
  }
  const document = signDocument(manifest, keyId, createPrivateKey(readFileSync(keyPath)))
  writeFileSync(output, `${JSON.stringify(document)}\n`, { flag: "wx", mode: 0o600 })
  process.stdout.write(
    `Signed ${manifest.files.length} files for ${manifest.target}; expires ${new Date(manifest.expiresAt).toISOString()}\n`,
  )
}
