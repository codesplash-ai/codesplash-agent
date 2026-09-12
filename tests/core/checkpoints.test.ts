import { expect, test } from "bun:test"
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { redactSensitiveText } from "../../src/core/redaction.ts"
import { CheckpointStore, type SnapshotFile } from "../../src/core/session/checkpoints.ts"
import { SessionStore } from "../../src/core/sessions.ts"

export async function checkpointFixture() {
  const root = mkdtempSync(join(tmpdir(), "m5-checkpoint-")),
    cwd = join(root, "project")
  mkdirSync(cwd)
  const handle = await new SessionStore(join(root, "sessions")).create({
    schemaVersion: 2,
    engine: "codesplash",
    localSessionId: "one",
    projectId: "project",
    projectPath: cwd,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastStatus: "closed",
    lastSequence: -1,
  })
  handle.acquire()
  const store = new CheckpointStore(handle.state, {
    cwd,
    trusted: () => true,
    writable: () => true,
    readable: (path) => !path.endsWith("denied.txt"),
    writablePath: () => true,
    protectedPaths: [],
    sanitize: redactSensitiveText,
  })
  return {
    root,
    cwd,
    store,
    close: () => {
      handle.release()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
test("private checkpoints preserve dirty binary/mode bytes while excluding unsafe and ignored files", async () => {
  const f = await checkpointFixture()
  try {
    writeFileSync(join(f.cwd, "dirty.txt"), "existing user changes")
    writeFileSync(join(f.cwd, "binary.bin"), Buffer.from([0, 255, 1, 2]))
    writeFileSync(join(f.cwd, "executable"), "#!/bin/sh\ntrue\n")
    chmodSync(join(f.cwd, "executable"), 0o755)
    writeFileSync(join(f.cwd, ".gitignore"), "ignored.txt\n")
    writeFileSync(join(f.cwd, "ignored.txt"), "ignored")
    writeFileSync(join(f.cwd, "denied.txt"), "denied")
    writeFileSync(join(f.cwd, "secret.txt"), "password=secretvalueverylong")
    writeFileSync(join(f.cwd, "linked"), "hardlink")
    linkSync(join(f.cwd, "linked"), join(f.cwd, "linked-again"))
    symlinkSync("dirty.txt", join(f.cwd, "symlink"))
    const snapshot = f.store.read(await f.store.capture())
    expect(Object.keys(snapshot.files).sort()).toEqual([
      ".gitignore",
      "binary.bin",
      "dirty.txt",
      "executable",
    ])
    expect(snapshot.files.executable?.mode).toBe(0o755)
    expect(await f.store.content(snapshot.files["binary.bin"] as SnapshotFile)).toEqual(
      Buffer.from([0, 255, 1, 2]),
    )
    expect(readFileSync(join(f.cwd, "dirty.txt"), "utf8")).toBe("existing user changes")
    expect(snapshot.excluded.map((row) => row.path)).toContain("ignored.txt")
  } finally {
    f.close()
  }
})
test("private snapshots ignore hostile user Git hooks, attributes and filter configuration", async () => {
  const f = await checkpointFixture()
  try {
    mkdirSync(join(f.cwd, ".git", "hooks"), { recursive: true })
    writeFileSync(
      join(f.cwd, ".git", "config"),
      '[filter "evil"]\n clean = touch SHOULD_NOT_EXIST\n[core]\n hooksPath = hooks\n',
    )
    writeFileSync(join(f.cwd, ".gitattributes"), "* filter=evil\n")
    writeFileSync(join(f.cwd, ".git", "hooks", "pre-commit"), "#!/bin/sh\ntouch SHOULD_NOT_EXIST\n", {
      mode: 0o755,
    })
    writeFileSync(join(f.cwd, "safe.txt"), "exact bytes\r\n")
    const snapshot = f.store.read(await f.store.capture())
    expect(await f.store.content(snapshot.files["safe.txt"] as SnapshotFile)).toEqual(
      Buffer.from("exact bytes\r\n"),
    )
    expect(() => readFileSync(join(f.cwd, "SHOULD_NOT_EXIST"))).toThrow()
    expect(Object.keys(snapshot.files).some((path) => path.startsWith(".git/"))).toBe(false)
  } finally {
    f.close()
  }
})

test("restore detects external edits and restores selected exact bytes without touching other dirty files", async () => {
  const f = await checkpointFixture()
  const { RestoreService } = await import("../../src/core/session/restore.ts")
  try {
    writeFileSync(join(f.cwd, "a.txt"), "user dirty before")
    writeFileSync(join(f.cwd, "b.txt"), "user untracked before")
    const id = (await f.store.begin("write files")) as string
    writeFileSync(join(f.cwd, "a.txt"), "agent after")
    writeFileSync(join(f.cwd, "b.txt"), "agent b after")
    await f.store.end(id)
    const restore = new RestoreService(f.store)
    writeFileSync(join(f.cwd, "b.txt"), "external newer edit")
    expect(restore.preview(id).rows.find((row) => row.path === "b.txt")?.conflict).toContain("differ")
    await restore.apply(restore.preview(id, ["a.txt"]))
    expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("user dirty before")
    expect(readFileSync(join(f.cwd, "b.txt"), "utf8")).toBe("external newer edit")
    expect(restore.journal()).toBeUndefined()
  } finally {
    f.close()
  }
})
test("interrupted multi-file restore can finish or roll back without losing before-images", async () => {
  const { RestoreService } = await import("../../src/core/session/restore.ts")
  for (const direction of ["finish", "rollback"] as const) {
    const f = await checkpointFixture()
    try {
      for (const name of ["a.txt", "b.txt"]) writeFileSync(join(f.cwd, name), `before ${name}`)
      const id = (await f.store.begin("change two")) as string
      for (const name of ["a.txt", "b.txt"]) writeFileSync(join(f.cwd, name), `after ${name}`)
      await f.store.end(id)
      const interrupted = new RestoreService(f.store, () => {
        throw new Error("simulated process stop")
      })
      await expect(interrupted.apply(interrupted.preview(id))).rejects.toThrow("simulated")
      expect(interrupted.journal()?.status).toBe("interrupted")
      const recovered = new RestoreService(f.store)
      await recovered.recover(direction)
      for (const name of ["a.txt", "b.txt"])
        expect(readFileSync(join(f.cwd, name), "utf8")).toBe(
          `${direction === "finish" ? "before" : "after"} ${name}`,
        )
      expect(recovered.journal()).toBeUndefined()
    } finally {
      f.close()
    }
  }
})
test("rollback preserves an external edit made after a partial restore", async () => {
  const f = await checkpointFixture()
  const { RestoreService } = await import("../../src/core/session/restore.ts")
  try {
    writeFileSync(join(f.cwd, "a.txt"), "before")
    const id = (await f.store.begin("change")) as string
    writeFileSync(join(f.cwd, "a.txt"), "after")
    await f.store.end(id)
    const interrupted = new RestoreService(f.store, () => {
      throw new Error("stop")
    })
    await expect(interrupted.apply(interrupted.preview(id))).rejects.toThrow("stop")
    writeFileSync(join(f.cwd, "a.txt"), "external preserved")
    await expect(new RestoreService(f.store).recover("rollback")).rejects.toThrow("External edit")
    expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("external preserved")
    expect(interrupted.journal()?.status).toBe("interrupted")
  } finally {
    f.close()
  }
})

test("a file recreated during replacement survives the no-clobber install", async () => {
  const f = await checkpointFixture()
  const { RestoreService } = await import("../../src/core/session/restore.ts")
  try {
    writeFileSync(join(f.cwd, "a.txt"), "before")
    const id = (await f.store.begin("change")) as string
    writeFileSync(join(f.cwd, "a.txt"), "after")
    await f.store.end(id)
    const restore = new RestoreService(f.store, undefined, () =>
      writeFileSync(join(f.cwd, "a.txt"), "external recreated"),
    )
    await expect(restore.apply(restore.preview(id))).rejects.toThrow("EEXIST")
    expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("external recreated")
    expect(restore.journal()?.status).toBe("interrupted")
  } finally {
    f.close()
  }
})
test("swapping a restore parent for a symlink cannot write to the outside directory", async () => {
  const f = await checkpointFixture()
  const { RestoreService } = await import("../../src/core/session/restore.ts")
  const { renameSync, existsSync } = await import("node:fs")
  try {
    mkdirSync(join(f.cwd, "sub"))
    const outside = join(f.root, "outside")
    mkdirSync(outside)
    writeFileSync(join(f.cwd, "sub", "a.txt"), "before")
    const id = (await f.store.begin("change")) as string
    writeFileSync(join(f.cwd, "sub", "a.txt"), "after")
    await f.store.end(id)
    const restore = new RestoreService(f.store, undefined, () => {
      renameSync(join(f.cwd, "sub"), join(f.cwd, "displaced"))
      symlinkSync(outside, join(f.cwd, "sub"))
    })
    await expect(restore.apply(restore.preview(id))).rejects.toThrow()
    expect(existsSync(join(outside, "a.txt"))).toBe(false)
    expect(restore.journal()?.status).toBe("interrupted")
  } finally {
    f.close()
  }
})

test("retention protects pinned and branch-bound checkpoints and collects abandoned assets", async () => {
  const f = await checkpointFixture()
  try {
    writeFileSync(join(f.cwd, "work"), "before")
    const step = (await f.store.begin("write")) as string
    writeFileSync(join(f.cwd, "work"), "after")
    await f.store.end(step)
    f.store.bindContext("retained-context")
    await expect(
      f.store.prune([step], new Set(["retained-context"]), f.store.view().revision),
    ).rejects.toThrow("unreferenced")
    f.store.pin(step, true, f.store.view().revision)
    await expect(f.store.prune([step], new Set(), f.store.view().revision)).rejects.toThrow("unpinned")
    f.store.pin(step, false, f.store.view().revision)
    const orphan = await f.store.capture()
    expect((await f.store.collect(f.store.view().revision)).snapshots).toBe(1)
    expect(() => f.store.read(orphan)).toThrow()
    expect(f.store.read(f.store.step(step).before).files.work).toBeDefined()
    expect(await f.store.prune([step], new Set(), f.store.view().revision)).toEqual([step])
  } finally {
    f.close()
  }
})
test("checkpoint captures tolerate unrelated orchestration revisions but reject checkpoint edits", async () => {
  const f = await checkpointFixture()
  try {
    writeFileSync(join(f.cwd, "file.txt"), "before")
    const capture = f.store.capture.bind(f.store)
    f.store.capture = async (signal) => {
      const snapshot = await capture(signal)
      const before = f.store.state.read()
      f.store.state.update(before.revision, "task/usage", (state) => {
        state.values.testUsage = Number(state.values.testUsage ?? 0) + 1
      })
      return snapshot
    }
    const id = await f.store.begin("background command")
    writeFileSync(join(f.cwd, "file.txt"), "after")
    await f.store.end(id)
    expect(f.store.step(id!).after).toBeDefined()
    expect(f.store.state.read().state.values.testUsage).toBe(2)
    f.store.capture = async (signal) => {
      const snapshot = await capture(signal)
      f.store.pin(id!, true, f.store.view().revision)
      return snapshot
    }
    await expect(f.store.begin("changed checkpoint state")).rejects.toThrow("Checkpoint state changed")
    expect(f.store.view().steps).toHaveLength(1)
    expect(f.store.view().pins).toEqual([id!])
  } finally {
    f.close()
  }
})
