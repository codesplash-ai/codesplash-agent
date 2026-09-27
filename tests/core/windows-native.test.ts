import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { atomic, bytes, lease, localFilesystem } from "../../src/core/session/files.ts"
import { SafeParent } from "../../src/core/session/secure-path.ts"

test.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "Windows handle-relative transactions refuse reparse aliases, pin ancestors, and recover atomic storage",
  () => {
    const root = mkdtempSync(join(tmpdir(), "codesplash-native-"))
    try {
      expect(localFilesystem(root)).toBe(true)
      const release = lease(root)
      expect(() => lease(root)).toThrow()
      release()
      atomic(join(root, "state.json"), "first")
      atomic(join(root, "state.json"), "second")
      expect(bytes(join(root, "state.json")).toString()).toBe("second")
      mkdirSync(join(root, "child"))
      writeFileSync(join(root, "child", "file"), "old")
      const parent = SafeParent.open(root, "child/file")!
      try {
        expect(() => renameSync(join(root, "child"), join(root, "moved"))).toThrow()
        expect(parent.read()?.content.toString()).toBe("old")
        parent.write("new", Buffer.from("new"), 0o644)
        parent.rename("new", "file")
        expect(parent.read()?.content.toString()).toBe("new")
        parent.link("file", "held")
        expect(() => parent.read()).toThrow("Unsafe")
        parent.unlink("held")
      } finally {
        parent.close()
      }
      mkdirSync(join(root, "outside"))
      symlinkSync(join(root, "outside"), join(root, "junction"), "junction")
      expect(() => SafeParent.open(root, "junction/file", true)).toThrow("Reparse")
      expect(readFileSync(join(root, "child", "file"), "utf8")).toBe("new")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)
