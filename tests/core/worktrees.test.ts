import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { git } from "../../src/core/orchestration/git.ts"
import { WorktreeStore } from "../../src/core/orchestration/worktrees.ts"

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cs-worktrees-"))),
    repo = join(root, "repo")
  await mkdir(repo)
  await git(repo, ["init", "-q"])
  await Bun.write(join(repo, "file.txt"), "base\n")
  await git(repo, ["add", "file.txt"])
  await git(repo, ["commit", "-qm", "base"])
  return {
    root,
    repo,
    store: await WorktreeStore.open(repo, join(root, "data")),
    close: () => rm(root, { recursive: true, force: true }),
  }
}
test("real owned worktrees preserve user index, guard apply and retain recovery refs", async () => {
  const f = await fixture()
  try {
    const tree = await f.store.create()
    expect(await Bun.file(join(tree.cwd, "file.txt")).text()).toBe("base\n")
    expect((await git(tree.cwd, ["rev-parse", "--is-inside-work-tree"])).toString().trim()).toBe("true")
    const claim = await f.store.claim(tree.id)
    await expect(f.store.remove(tree.id)).rejects.toThrow("active")
    claim.release()
    await Bun.write(join(tree.cwd, "file.txt"), "child\n")
    await expect(f.store.remove(tree.id)).rejects.toThrow("Dirty")
    const preview = await f.store.preview(tree.id)
    expect(preview.paths).toEqual(["file.txt"])
    await f.store.apply(tree.id, preview.fingerprint)
    expect(await Bun.file(join(f.repo, "file.txt")).text()).toBe("child\n")
    expect((await git(f.repo, ["show", ":file.txt"])).toString()).toBe("base\n")
    expect(
      (await git(f.repo, ["show", `refs/codesplash/worktrees/${tree.id}/recovery:file.txt`])).toString(),
    ).toBe("base\n")
    await expect(f.store.apply(tree.id, preview.fingerprint)).rejects.toThrow("changed")
  } finally {
    await f.close()
  }
}, 30000)
test("worktree conflicts leave destination intact and recover after a reviewed retry", async () => {
  const f = await fixture()
  try {
    const tree = await f.store.create()
    await Bun.write(join(tree.cwd, "file.txt"), "child\n")
    await Bun.write(join(f.repo, "file.txt"), "external\n")
    await expect(f.store.apply(tree.id, (await f.store.preview(tree.id)).fingerprint)).rejects.toThrow(
      "conflict",
    )
    expect(await Bun.file(join(f.repo, "file.txt")).text()).toBe("external\n")
    expect((await f.store.recover(tree.id)).status).toBe("conflict")
    await Bun.write(join(f.repo, "file.txt"), "base\n")
    await f.store.apply(tree.id, (await f.store.preview(tree.id)).fingerprint)
    expect(await Bun.file(join(f.repo, "file.txt")).text()).toBe("child\n")
  } finally {
    await f.close()
  }
}, 30000)
test("GC refuses ignored or hidden content and removes only clean inactive owned trees", async () => {
  const f = await fixture()
  try {
    const clean = await f.store.create(),
      dirty = await f.store.create()
    await Bun.write(join(dirty.cwd, "local.txt"), "keep")
    const result = await f.store.gc()
    expect(result.removed).toEqual([clean.id])
    expect(result.retained.map((v) => v.id)).toEqual([dirty.id])
    expect(await Bun.file(join(dirty.cwd, "local.txt")).text()).toBe("keep")
    expect((await f.store.list())[0]?.bytes).toBeGreaterThan(0)
  } finally {
    await f.close()
  }
}, 30000)
test("host worktree lifecycle never executes repository smudge/clean hooks", async () => {
  const f = await fixture()
  try {
    await Bun.write(join(f.repo, ".gitattributes"), "*.txt filter=hostile\n")
    await git(f.repo, ["add", ".gitattributes"])
    await git(f.repo, ["commit", "-qm", "attributes"])
    await git(f.repo, ["config", "filter.hostile.smudge", `touch ${join(f.root, "executed")}; cat`])
    await git(f.repo, ["config", "filter.hostile.clean", `touch ${join(f.root, "executed")}; cat`])
    const tree = await f.store.create()
    await f.store.preview(tree.id)
    await f.store.remove(tree.id)
    expect(await Bun.file(join(f.root, "executed")).exists()).toBe(false)
  } finally {
    await f.close()
  }
}, 30000)

test("interrupted apply preserves a racing external edit and supports explicit guarded rollback", async () => {
  const f = await fixture()
  try {
    const tree = await f.store.create()
    await Bun.write(join(tree.cwd, "file.txt"), "child\n")
    const { writeFileSync, unlinkSync } = await import("node:fs")
    f.store.beforeInstall = (path) => writeFileSync(join(f.repo, path), "racing external\n")
    await expect(f.store.apply(tree.id, (await f.store.preview(tree.id)).fingerprint)).rejects.toThrow(
      "interrupted",
    )
    expect(await Bun.file(join(f.repo, "file.txt")).text()).toBe("racing external\n")
    expect((await f.store.recover(tree.id)).status).toBe("applying")
    await expect(f.store.rollback(tree.id)).rejects.toThrow("External edit")
    // The user has separately preserved/resolved their external edit before requesting rollback.
    unlinkSync(join(f.repo, "file.txt"))
    await f.store.rollback(tree.id)
    expect(await Bun.file(join(f.repo, "file.txt")).text()).toBe("base\n")
    f.store.beforeInstall = undefined
    await f.store.apply(tree.id, (await f.store.preview(tree.id)).fingerprint)
    expect(await Bun.file(join(f.repo, "file.txt")).text()).toBe("child\n")
  } finally {
    await f.close()
  }
}, 30000)

test("worktree copies and apply exclude credentials/configuration and denied read paths", async () => {
  const f = await fixture()
  try {
    await Bun.write(join(f.repo, ".env"), "PRIVATE_SECRET")
    await Bun.write(join(f.repo, "denied.txt"), "PRIVATE_DENIAL")
    await git(f.repo, ["add", ".env", "denied.txt"])
    await git(f.repo, ["commit", "-qm", "private fixtures"])
    const store = await WorktreeStore.open(f.repo, join(f.root, "data"), {
      readable: (path) => !path.endsWith("/denied.txt"),
      writable: () => true,
    })
    const tree = await store.create()
    expect(await Bun.file(join(tree.cwd, ".env")).exists()).toBe(false)
    expect(await Bun.file(join(tree.cwd, "denied.txt")).exists()).toBe(false)
    expect((await store.preview(tree.id)).paths).toEqual([])
    await store.remove(tree.id)
    expect(await Bun.file(join(f.repo, ".env")).text()).toBe("PRIVATE_SECRET")
  } finally {
    await f.close()
  }
}, 30000)

test("rollback recovers a crash during successful-apply cleanup from retained Git objects", async () => {
  const f = await fixture()
  try {
    const tree = await f.store.create()
    await Bun.write(join(tree.cwd, "file.txt"), "child\n")
    await f.store.apply(tree.id, (await f.store.preview(tree.id)).fingerprint)
    const { digest, atomic } = await import("../../src/core/session/files.ts")
    const path = join(f.store.root, "manifest.json"),
      journal = await Bun.file(path).json()
    journal.trees[0].status = "applying"
    journal.trees[0].applyRows = [
      {
        path: "file.txt",
        expected: { hash: digest("base\n"), mode: 0o644 },
        target: { hash: digest("child\n"), mode: 0o644 },
        hold: `.codesplash-worktree-${crypto.randomUUID()}`,
      },
    ]
    atomic(path, JSON.stringify(journal))
    await f.store.rollback(tree.id)
    expect(await Bun.file(join(f.repo, "file.txt")).text()).toBe("base\n")
  } finally {
    await f.close()
  }
}, 30000)

test("worktree CLI honors configured denial before creating persistent work", async () => {
  const f = await fixture()
  try {
    const { runWorktreeCommand } = await import("../../src/commands/worktree.ts")
    const configPath = join(f.root, "config.toml")
    await Bun.write(configPath, '[permissions]\ndeny=["worktree"]\n')
    await expect(
      runWorktreeCommand(["create", "--apply", "--trust"], {
        cwd: f.repo,
        dataDir: join(f.root, "data"),
        configPath,
        output: () => {},
      }),
    ).rejects.toThrow("denied")
    expect(await f.store.list()).toEqual([])
  } finally {
    await f.close()
  }
}, 30000)

test("prepared pool assigns each clean slot once and refuses changed bases, policy and content", async () => {
  const f = await fixture()
  try {
    const prepared = await f.store.fillPool(2)
    expect(prepared.every((t) => t.pooled)).toBe(true)
    expect((await f.store.fillPool(2)).map((t) => t.id)).toEqual(prepared.map((t) => t.id))
    const first = await f.store.takePool()
    expect(first.pooled).toBeUndefined()
    expect(first.id).toBe(prepared[0]!.id)
    await Bun.write(join(prepared[1]!.cwd, "file.txt"), "preserve me\n")
    await expect(f.store.takePool()).rejects.toThrow("Dirty")
    expect(await Bun.file(join(prepared[1]!.cwd, "file.txt")).text()).toBe("preserve me\n")
    await Bun.write(join(prepared[1]!.cwd, "file.txt"), "base\n")
    const claim = await f.store.claim(prepared[1]!.id)
    try {
      await expect(f.store.takePool()).rejects.toThrow("No prepared")
    } finally {
      claim.release()
    }
    await f.store.fillPool(1)
    const denied = await WorktreeStore.open(f.repo, join(f.root, "data"), {
      readable: () => false,
      writable: () => false,
    })
    await expect(denied.takePool()).rejects.toThrow()
    await Bun.write(join(f.repo, "new.txt"), "next")
    await git(f.repo, ["add", "new.txt"])
    await git(f.repo, ["commit", "-qm", "new base"])
    await expect(f.store.takePool()).rejects.toThrow("No prepared")
    expect((await f.store.fillPool(1))[0]?.base).not.toBe(first.base)
  } finally {
    await f.close()
  }
}, 30000)
