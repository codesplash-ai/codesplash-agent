/** Verify the exact packaged asset inventory with a disposable signing key; never publish it. */
import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import { resolve } from "node:path"
import { signDocument, verifyDocument } from "../src/core/distribution/signed.ts"
import type { ReleaseManifest } from "../src/core/distribution/update.ts"
import { releaseManifest } from "./release-manifest.ts"

const root = resolve(process.argv[2]!),
  manifest = releaseManifest(root, "https://fixture.invalid/assets/", 1),
  key = generateKeyPairSync("ed25519"),
  envelope = signDocument(manifest, "fixture", key.privateKey),
  verified = verifyDocument<ReleaseManifest>(envelope, "release", {
    fixture: key.publicKey.export({ type: "spki", format: "pem" }).toString(),
  })
assert.deepEqual(verified.payload, manifest)
assert.ok(manifest.files.some((file) => file.path.startsWith("sandbox-runtime/playwright-core/")))
assert.ok(manifest.files.some((file) => file.path === "THIRD_PARTY_NOTICES.md"))
assert.ok(manifest.files.some((file) => file.path === "sandbox-runtime/restore.c"))
console.log(
  `M11_PACKAGE_OK: ${manifest.files.length} signed files, ${manifest.files.reduce((sum, file) => sum + file.size, 0)} bytes`,
)
