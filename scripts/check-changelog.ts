/**
 * Fails when CHANGELOG.md lacks a non-empty section for the version being released, so a tag can
 * never ship with "See CHANGELOG.md" fallback notes again. Version comes from argv or version.ts.
 */
import { APP_VERSION } from "../src/version.ts"

const version = process.argv[2] ?? APP_VERSION
const changelog = await Bun.file(new URL("../CHANGELOG.md", import.meta.url)).text()

const heading = new RegExp(`^## ${version.replaceAll(".", "\\.")}\\b.*$`, "m")
const match = heading.exec(changelog)
if (!match) {
  console.error(`CHANGELOG.md has no "## ${version}" section — write the release notes before tagging.`)
  process.exit(1)
}

const rest = changelog.slice((match.index ?? 0) + match[0].length)
const body = rest.split(/^## /m)[0]?.trim() ?? ""
if (!body) {
  console.error(`The "## ${version}" section in CHANGELOG.md is empty — add the release notes.`)
  process.exit(1)
}

console.log(`CHANGELOG.md has release notes for ${version}.`)
