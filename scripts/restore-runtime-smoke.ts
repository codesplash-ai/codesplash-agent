/** Standalone interpreted/compiled feasibility proof for directory-relative restore primitives. */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SafeParent } from "../src/core/session/secure-path.ts"

const root = mkdtempSync(join(tmpdir(), "codesplash-restore-runtime-")),
  cwd = join(root, "project"),
  outside = join(root, "outside")
mkdirSync(cwd)
mkdirSync(outside)
mkdirSync(join(cwd, "sub"))
const parent = SafeParent.open(cwd, "sub/file", true)
assert.ok(parent)
try {
  parent.write("file", Buffer.from("original"), 0o644)
  parent.rename("file", "hold")
  parent.write("next", Buffer.from("replacement"), 0o755)
  writeFileSync(join(cwd, "sub", "file"), "external")
  assert.throws(() => parent.link("next", "file"), /EEXIST/)
  assert.equal(readFileSync(join(cwd, "sub", "file"), "utf8"), "external")
  renameSync(join(cwd, "sub"), join(cwd, "moved"))
  symlinkSync(outside, join(cwd, "sub"))
  assert.throws(() => parent.link("next", "unexpected"))
  process.stdout.write("Directory-relative restore runtime smoke passed\n")
} finally {
  parent.close()
  rmSync(root, { recursive: true, force: true })
}
