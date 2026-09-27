/** Build an inert review artifact from a local vendor snapshot; never changes bundled prices. */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { digest } from "../src/core/session/files.ts"
import { modelManifest } from "../src/engines/codesplash/model-cache.ts"

const [source, provenance, output] = process.argv.slice(2)
if (!source || !provenance || !output || process.argv.length !== 5)
  throw new Error("Use review-model-catalog.ts SOURCE.json HTTPS_VENDOR_SOURCE OUTPUT.json")
const url = new URL(provenance)
if (url.protocol !== "https:" || url.username || url.password || url.hash)
  throw new Error("Require a vendor HTTPS provenance URL")
const input = readFileSync(source)
if (input.length > 4 * 1024 * 1024) throw new Error("Catalog exceeds 4 MiB")
const manifest = modelManifest(JSON.parse(input.toString()))
const encoded = `${JSON.stringify(manifest, null, 2)}\n`
const target = resolve(output)
writeFileSync(target, encoded, { flag: "wx", mode: 0o600 })
writeFileSync(
  `${target}.review.json`,
  JSON.stringify(
    {
      version: 1,
      reviewRequired: true,
      source: url.href,
      sourceSha256: digest(input),
      manifestSha256: digest(encoded),
      createdAt: new Date().toISOString(),
      checks: [
        "Confirm model identifiers, limits and capabilities against vendor documentation",
        "Confirm each price and cached-input rate at the stated source date",
        "Run provider fixtures and obtain bounded live-account acceptance",
        "Review and commit source/manifest before publishing or checksum-pinned refresh",
      ],
    },
    null,
    2,
  ) + "\n",
  { flag: "wx", mode: 0o600 },
)
console.log(`Review artifact: ${target}; SHA256 ${digest(encoded)}. No catalog was activated.`)
