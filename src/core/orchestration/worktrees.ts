import { existsSync, lstatSync, opendirSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { dataDirectory } from "../config.ts"
import { snapshotPath } from "../session/checkpoints.ts"
import { atomic, bytes, canonicalRoot, digest, directory, json, lease } from "../session/files.ts"
import { SafeParent } from "../session/secure-path.ts"
import { git } from "./git.ts"
import { MutationCoordinator } from "./mutations.ts"

export type WorktreeRecord = {
  id: string
  cwd: string
  base: string
  created: string
  status: "creating" | "ready" | "applying" | "conflict" | "removing"
  source?: string
  recovery?: string
  error?: string
  excluded: string[]
  metadata?: string
  applyRows?: ApplyRow[]
}
export type WorktreeRequest =
  | { action: "list" | "gc" }
  | { action: "create"; base?: string }
  | { action: "preview" | "remove" | "recover" | "rollback"; id: string }
  | { action: "apply"; id: string; fingerprint: string }
export type WorktreePolicy = { readable(path: string): boolean; writable(path: string): boolean }
type FileState = { hash: string; mode: number }
type ApplyRow = { path: string; expected?: FileState; target?: FileState; hold: string }
const sameFile = (a: FileState | undefined, b: FileState | undefined) =>
  a?.hash === b?.hash && a?.mode === b?.mode
type Journal = { version: 1; repo: string; gitdir: string; trees: WorktreeRecord[] }
type File = { mode: string; oid: string; path: string }
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const denied =
  /^(?:\.git|\.codesplash(?:-.*)?|\.claude|\.codex|\.agents|\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519|dsa))$|\.(?:pem|key|p12|pfx)$/i
const MAX_BYTES = 256 * 1024 * 1024
export class WorktreeStore {
  /** Fault-injection seam used by the same external-edit recovery tests as M5 restore. */
  beforeInstall?: (path: string) => void
  #deadline = 0
  #checkDeadline() {
    if (this.#deadline && Date.now() > this.#deadline)
      throw new Error("Worktree lifecycle exceeded two minutes; inspect retained intent")
  }
  private constructor(
    readonly repo: string,
    readonly gitdir: string,
    readonly root: string,
    readonly policy?: WorktreePolicy,
  ) {}
  static async open(cwd: string, data = dataDirectory(), policy?: WorktreePolicy) {
    const repo = canonicalRoot((await git(cwd, ["rev-parse", "--show-toplevel"])).toString().trim())
    const gitdir = canonicalRoot(
      (await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).toString().trim(),
    )
    directory(repo)
    directory(gitdir)
    return new WorktreeStore(repo, gitdir, join(canonicalRoot(data), "worktrees", digest(repo)), policy)
  }
  static async claimWorkspace(cwd: string, data?: string) {
    const path = canonicalRoot(cwd)
    if (basename(dirname(path)) !== ".codesplash-worktrees" || !idPattern.test(basename(path)))
      return undefined
    return (await WorktreeStore.open(dirname(dirname(path)), data)).claim(basename(path))
  }
  #read(): Journal {
    if (!existsSync(join(this.root, "manifest.json")))
      return { version: 1, repo: this.repo, gitdir: this.gitdir, trees: [] }
    const value = json<Journal>(join(this.root, "manifest.json"))
    if (
      value.version !== 1 ||
      value.repo !== this.repo ||
      value.gitdir !== this.gitdir ||
      !Array.isArray(value.trees) ||
      value.trees.length > 16 ||
      value.trees.some(
        (t) =>
          !t ||
          !idPattern.test(t.id) ||
          t.cwd !== join(this.repo, ".codesplash-worktrees", t.id) ||
          !oidPattern.test(t.base) ||
          !Array.isArray(t.excluded) ||
          t.excluded.length > 5000 ||
          t.excluded.some((p) => typeof p !== "string" || snapshotPath(p) !== p) ||
          !["creating", "ready", "applying", "conflict", "removing"].includes(t.status) ||
          [t.source, t.recovery].some((v) => v !== undefined && !oidPattern.test(v)),
      )
    )
      throw new Error("Corrupt worktree manifest")
    if (new Set(value.trees.map((t) => t.id)).size !== value.trees.length)
      throw new Error("Duplicate worktree identities")
    for (const tree of value.trees)
      if (tree.applyRows !== undefined) {
        if (!Array.isArray(tree.applyRows) || tree.applyRows.length > 128)
          throw new Error("Corrupt apply journal")
        for (const row of tree.applyRows) {
          if (
            !row ||
            typeof row.path !== "string" ||
            !/^\.codesplash-worktree-[a-f0-9-]{36}$/.test(row.hold) ||
            snapshotPath(row.path)
              .split("/")
              .some((p) => denied.test(p)) ||
            [row.expected, row.target].some(
              (f) =>
                f !== undefined && (!f || !/^[a-f0-9]{64}$/.test(f.hash) || ![0o644, 0o755].includes(f.mode)),
            )
          )
            throw new Error("Corrupt apply file journal")
        }
      }
    return value
  }
  #write(value: Journal) {
    const text = JSON.stringify(value)
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("Worktree journal exceeds 1 MiB")
    atomic(join(this.root, "manifest.json"), text)
  }
  async #transaction<T>(run: (journal: Journal) => Promise<T>, alreadyClaimed = false): Promise<T> {
    const unlock = alreadyClaimed
      ? undefined
      : await new MutationCoordinator().acquire([this.repo], AbortSignal.timeout(30000))
    try {
      directory(this.root, true)
      const release = lease(this.root)
      try {
        this.#deadline = Date.now() + 120000
        return await run(this.#read())
      } finally {
        release()
      }
    } finally {
      await unlock?.()
    }
  }
  #record(journal: Journal, id: string) {
    const tree = journal.trees.find((t) => t.id === id)
    if (!idPattern.test(id) || !tree) throw new Error("Unknown owned worktree")
    return tree
  }
  #eligible(path: string, write = false) {
    snapshotPath(path)
    if (path.split("/").some((p) => denied.test(p))) return false
    const absolute = join(this.repo, path)
    return (this.policy?.readable(absolute) ?? true) && (!write || (this.policy?.writable(absolute) ?? true))
  }
  async #identity(tree: WorktreeRecord) {
    directory(tree.cwd)
    if (!existsSync(tree.cwd)) throw new Error("Owned worktree is missing; inspect recovery before cleanup")
    const common = canonicalRoot(
      (await git(tree.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).toString().trim(),
    )
    const top = canonicalRoot((await git(tree.cwd, ["rev-parse", "--show-toplevel"])).toString().trim())
    if (common !== this.gitdir || top !== tree.cwd) throw new Error("Worktree repository identity changed")
    const pointer = bytes(join(tree.cwd, ".git"), 4096).toString()
    if (digest(pointer) !== tree.metadata) throw new Error("Worktree metadata fingerprint changed")
    if (!pointer.startsWith(`gitdir: ${join(this.gitdir, "worktrees")}/`))
      throw new Error("Worktree metadata is not owned by this repository")
  }
  #disk(cwd: string) {
    let total = 0,
      count = 0
    const visit = (path: string, depth = 0) => {
      if (depth > 64) throw new Error("Worktree directory depth exceeded")
      const dir = opendirSync(path)
      try {
        for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
          if (++count > 10000) throw new Error("Worktree entry limit exceeded")
          const next = join(path, entry.name),
            stat = lstatSync(next)
          if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
            throw new Error("Worktree contains unsupported filesystem entries")
          if (stat.isDirectory()) visit(next, depth + 1)
          else {
            total += stat.size
            if (total > MAX_BYTES) throw new Error("Worktree disk limit exceeded")
          }
        }
      } finally {
        dir.closeSync()
      }
    }
    visit(cwd)
    return { bytes: total, entries: count }
  }
  async list() {
    const result = []
    for (const tree of this.#read().trees) {
      let disk: { bytes: number; entries: number } | undefined, unavailable: string | undefined
      try {
        await this.#identity(tree)
        disk = this.#disk(tree.cwd)
      } catch (e) {
        unavailable = e instanceof Error ? e.message : "Unavailable"
      }
      result.push({ ...tree, ...disk, unavailable })
    }
    return result
  }
  async #files(commit: string): Promise<File[]> {
    const entries = (await git(this.repo, ["ls-tree", "-r", "-z", commit]))
      .toString()
      .split("\0")
      .filter(Boolean)
    if (entries.length > 5000) throw new Error("Worktree tracked file limit exceeded")
    return entries.map((entry) => {
      const match = /^(100644|100755) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entry)
      if (!match || !oidPattern.test(match[2]!))
        throw new Error(
          "Worktrees require regular tracked files; symlinks and submodules need manual isolation",
        )
      const path = snapshotPath(match[3]!)
      if (path.split("/").some((p) => p === ".git" || p === ".codesplash-worktrees"))
        throw new Error("Reserved worktree source path")
      return { mode: match[1]!, oid: match[2]!, path }
    })
  }
  async create(base = "HEAD") {
    if (!base || base.startsWith("-") || base.length > 256 || /[\s\0]/.test(base))
      throw new Error("Invalid worktree base reference")
    return this.#transaction(async (journal) => {
      if (journal.trees.length >= 16) throw new Error("Worktree count limit reached")
      const commit = (await git(this.repo, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]))
        .toString()
        .trim()
      if (!oidPattern.test(commit)) throw new Error("Invalid base commit")
      const allFiles = await this.#files(commit)
      const files = allFiles.filter((file) => this.#eligible(file.path)),
        blobs: Buffer[] = []
      let size = 0
      for (const file of files) {
        this.#checkDeadline()
        const blob = await git(this.repo, ["cat-file", "blob", file.oid])
        size += blob.length
        if (size > 64 * 1024 * 1024) throw new Error("Worktree checkout exceeds 64 MiB")
        blobs.push(blob)
      }
      const id = crypto.randomUUID(),
        tree: WorktreeRecord = {
          id,
          cwd: join(this.repo, ".codesplash-worktrees", id),
          base: commit,
          status: "creating",
          excluded: allFiles.filter((file) => !this.#eligible(file.path)).map((file) => file.path),
          created: new Date().toISOString(),
        }
      directory(dirname(tree.cwd), true)
      journal.trees.push(tree)
      this.#write(journal)
      await git(this.repo, ["update-ref", `refs/codesplash/worktrees/${id}/base`, commit])
      await git(this.repo, ["worktree", "add", "--detach", "--no-checkout", "--lock", tree.cwd, commit])
      for (let i = 0; i < files.length; i++) {
        this.#checkDeadline()
        const file = files[i]!,
          path = join(tree.cwd, file.path)
        directory(dirname(path), true)
        writeFileSync(path, blobs[i]!, { flag: "wx", mode: file.mode === "100755" ? 0o755 : 0o644 })
      }
      // Populate only the index from the tree; raw hydration deliberately does not invoke filters.
      await git(tree.cwd, ["read-tree", commit])
      if (tree.excluded.length)
        await git(
          tree.cwd,
          ["update-index", "--skip-worktree", "-z", "--stdin"],
          tree.excluded.map((path) => `${path}\0`).join(""),
        )
      tree.metadata = digest(bytes(join(tree.cwd, ".git"), 4096))
      tree.status = "ready"
      this.#write(journal)
      return structuredClone(tree)
    })
  }
  async claim(id: string) {
    return this.#transaction(async (journal) => {
      const tree = this.#record(journal, id)
      if (tree.status !== "ready") throw new Error("Worktree has unfinished lifecycle work")
      await this.#identity(tree)
      this.#disk(tree.cwd)
      const release = lease(join(this.root, id), "active.lease")
      return { tree: structuredClone(tree), release }
    })
  }
  async #snapshot(cwd: string, base: string, id: string) {
    const names = (
      await git(cwd, [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        ".",
        ":(exclude).codesplash-worktrees",
      ])
    )
      .toString()
      .split("\0")
      .filter(Boolean)
    const excluded = new Set(this.#record(this.#read(), id).excluded)
    const files = [...new Set(names)].filter((path) => !excluded.has(path))
    if (files.length > 5000) throw new Error("Worktree snapshot file limit exceeded")
    const index = join(this.root, `${crypto.randomUUID()}.index`),
      env = { GIT_INDEX_FILE: index }
    let total = 0
    try {
      await git(cwd, ["read-tree", "--empty"], undefined, env)
      const entries = []
      for (const path of files) {
        this.#checkDeadline()
        if (!this.#eligible(path)) continue
        snapshotPath(path)
        const absolute = join(cwd, path)
        if (!existsSync(absolute)) continue
        const content = bytes(absolute, 16 * 1024 * 1024),
          stat = lstatSync(absolute)
        total += content.length
        if (total > 64 * 1024 * 1024) throw new Error("Snapshot exceeds 64 MiB")
        const oid = (await git(cwd, ["hash-object", "-w", "--stdin"], content)).toString().trim()
        entries.push(`${stat.mode & 0o111 ? "100755" : "100644"} ${oid}\t${path}\0`)
      }
      await git(cwd, ["update-index", "-z", "--index-info"], entries.join(""), env)
      const tree = (await git(cwd, ["write-tree"], undefined, env)).toString().trim()
      const commit = (await git(cwd, ["commit-tree", tree, "-p", base], `CodeSplash worktree ${id}\n`))
        .toString()
        .trim()
      return commit
    } finally {
      if (existsSync(index)) unlinkSync(index)
    }
  }
  async #preview(tree: WorktreeRecord) {
    await this.#identity(tree)
    this.#disk(tree.cwd)
    const head = (await git(this.repo, ["rev-parse", "HEAD"])).toString().trim()
    const source = await this.#snapshot(tree.cwd, tree.base, tree.id)
    const destination = await this.#snapshot(this.repo, head, tree.id)
    // Hash trees, not time-dependent commit metadata.
    const sourceTree = (await git(this.repo, ["rev-parse", `${source}^{tree}`])).toString().trim()
    const destinationTree = (await git(this.repo, ["rev-parse", `${destination}^{tree}`])).toString().trim()
    const paths = (await git(this.repo, ["diff", "--name-only", "-z", tree.base, source, "--"]))
      .toString()
      .split("\0")
      .filter((path) => path && !tree.excluded.includes(path) && this.#eligible(path))
    const patch = paths.length
      ? await git(this.repo, [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--binary",
          tree.base,
          source,
          "--",
          ...paths,
        ])
      : Buffer.alloc(0)
    const fingerprint = digest(
      JSON.stringify({
        id: tree.id,
        base: tree.base,
        head,
        sourceTree,
        destinationTree,
        patch: digest(patch),
      }),
    )
    return { fingerprint, source, destination, paths, patch }
  }
  async preview(id: string) {
    return this.#transaction(async (journal) => {
      const tree = this.#record(journal, id),
        release = lease(join(this.root, id), "active.lease")
      try {
        const preview = await this.#preview(tree)
        return {
          ...preview,
          patch: preview.patch.toString().slice(0, 65536),
          truncated: preview.patch.length > 65536,
        }
      } finally {
        release()
      }
    })
  }
  async apply(id: string, fingerprint: string) {
    if (!/^[a-f0-9]{64}$/.test(fingerprint))
      throw new Error("Apply requires the reviewed preview fingerprint")
    const coordinator = new MutationCoordinator()
    const unlock = await coordinator.acquire([this.repo], AbortSignal.timeout(30000))
    try {
      return await this.#transaction(async (journal) => {
        const tree = this.#record(journal, id),
          release = lease(join(this.root, id), "active.lease")
        try {
          if (!["ready", "conflict"].includes(tree.status))
            throw new Error("Worktree has uncertain lifecycle work; recover first")
          const preview = await this.#preview(tree)
          if (preview.fingerprint !== fingerprint)
            throw new Error("Worktree or destination changed since preview")
          tree.source = preview.source
          tree.recovery = preview.destination
          tree.status = "applying"
          this.#write(journal)
          await git(this.repo, ["update-ref", `refs/codesplash/worktrees/${id}/source`, preview.source])
          await git(this.repo, [
            "update-ref",
            `refs/codesplash/worktrees/${id}/recovery`,
            preview.destination,
          ])
          try {
            await this.#publish(tree, preview, journal)
            tree.status = "ready"
            delete tree.error
            this.#write(journal)
            return { applied: id, paths: preview.paths, recovery: `refs/codesplash/worktrees/${id}/recovery` }
          } catch (error) {
            tree.status = tree.applyRows?.length ? "applying" : "conflict"
            tree.error = tree.applyRows?.length
              ? "Apply interrupted; use worktree rollback with the retained journal before retry"
              : "Apply conflict; destination is unchanged; inspect retained source/recovery refs and preview again"
            tree.error += `: ${error instanceof Error ? error.message.slice(0, 512) : "Unknown apply failure"}`
            this.#write(journal)
            throw new Error(tree.error)
          }
        } finally {
          release()
        }
      }, true)
    } finally {
      await unlock()
    }
  }
  async #publish(tree: WorktreeRecord, preview: { source: string; paths: string[] }, journal: Journal) {
    if (preview.paths.length > 128) throw new Error("Apply is limited to 128 changed files")
    const base = new Map((await this.#files(tree.base)).map((f) => [f.path, f]))
    const source = new Map((await this.#files(preview.source)).map((f) => [f.path, f]))
    const rows: ApplyRow[] = [],
      contents = new Map<string, Buffer>()
    for (const path of preview.paths) {
      this.#checkDeadline()
      if (!this.#eligible(path, true)) throw new Error("Apply path is outside writable authority")
      const original = base.get(path),
        selected = source.get(path)
      const before = original ? await git(this.repo, ["cat-file", "blob", original.oid]) : undefined
      const after = selected ? await git(this.repo, ["cat-file", "blob", selected.oid]) : undefined
      if ((before?.length ?? 0) > 2 * 1024 * 1024 || (after?.length ?? 0) > 2 * 1024 * 1024)
        throw new Error("Apply files exceed 2 MiB")
      const expected = before
        ? { hash: digest(before), mode: original!.mode === "100755" ? 0o755 : 0o644 }
        : undefined
      const target = after
        ? { hash: digest(after), mode: selected!.mode === "100755" ? 0o755 : 0o644 }
        : undefined
      const parent = SafeParent.open(this.repo, path)
      try {
        const current = parent?.read()
        if (sameFile(current, target)) continue
        if (!sameFile(current, expected)) throw new Error(`Destination conflict: ${path}`)
      } finally {
        parent?.close()
      }
      rows.push({ path, expected, target, hold: `.codesplash-worktree-${crypto.randomUUID()}` })
      if (after) contents.set(path, after)
    }
    tree.applyRows = rows
    this.#write(journal)
    for (const row of rows) {
      if (!this.#eligible(row.path, true)) throw new Error("Apply authority changed")
      const parent = SafeParent.open(this.repo, row.path, true)!
      try {
        if (!sameFile(parent.read(), row.expected)) throw new Error(`External edit preserved: ${row.path}`)
        if (row.expected) {
          parent.rename(parent.file, row.hold)
          if (!sameFile(parent.read(row.hold), row.expected))
            throw new Error(`Concurrent file change held: ${row.path}`)
        }
        if (row.target) {
          parent.write(`${row.hold}.next`, contents.get(row.path)!, row.target.mode)
          this.beforeInstall?.(row.path)
          parent.link(`${row.hold}.next`, parent.file)
          parent.unlink(`${row.hold}.next`)
        }
        if (!sameFile(parent.read(), row.target))
          throw new Error(`Concurrent file change preserved: ${row.path}`)
      } finally {
        parent.close()
      }
    }
    // Only delete verified hold files after all replacements have succeeded.
    for (const row of rows) {
      if (!this.#eligible(row.path, true)) throw new Error("Apply authority changed")
      const parent = SafeParent.open(this.repo, row.path)!
      try {
        if (row.expected && sameFile(parent.read(row.hold), row.expected)) parent.unlink(row.hold)
      } finally {
        parent.close()
      }
    }
    delete tree.applyRows
  }
  async rollback(id: string) {
    const unlock = await new MutationCoordinator().acquire([this.repo], AbortSignal.timeout(30000))
    try {
      return await this.#transaction(async (journal) => {
        const tree = this.#record(journal, id),
          release = lease(join(this.root, id), "active.lease")
        try {
          if (!tree.applyRows?.length) throw new Error("No interrupted apply has held files to roll back")
          const recovery = tree.recovery
            ? new Map((await this.#files(tree.recovery)).map((f) => [f.path, f]))
            : new Map<string, File>()
          for (const row of [...tree.applyRows].reverse()) {
            this.#checkDeadline()
            if (!this.#eligible(row.path, true))
              throw new Error("Rollback path is outside writable authority")
            let original: Buffer | undefined
            if (row.expected) {
              const file = recovery.get(row.path)
              if (!file) throw new Error("Recovery object is unavailable")
              original = await git(this.repo, ["cat-file", "blob", file.oid])
              if (digest(original) !== row.expected.hash)
                throw new Error("Recovery object does not match expected file")
            }
            const parent = SafeParent.open(this.repo, row.path, true)!
            const discard = `${row.hold}.rollback`,
              restore = `${row.hold}.restore`
            try {
              const current = parent.read(),
                held = parent.read(row.hold)
              const cleanup = (name: string, expected: FileState | undefined) => {
                const file = parent.read(name)
                if (!file) return
                if (!sameFile(file, expected)) throw new Error(`Recovery temporary file changed: ${row.path}`)
                parent.unlink(name)
              }
              if (sameFile(current, row.expected) && !held) {
                cleanup(discard, row.target)
                cleanup(`${row.hold}.next`, row.target)
                cleanup(restore, row.expected)
                continue
              }
              if (held && !sameFile(held, row.expected)) throw new Error(`Recovery hold changed: ${row.path}`)
              if (current && !sameFile(current, row.target))
                throw new Error(`External edit prevents rollback: ${row.path}`)
              const discarded = parent.read(discard)
              if (discarded && !sameFile(discarded, row.target)) throw new Error("Rollback hold changed")
              if (current) {
                if (discarded) throw new Error("Concurrent target appeared during rollback")
                parent.rename(parent.file, discard)
                if (!sameFile(parent.read(discard), row.target)) {
                  try {
                    parent.link(discard, parent.file)
                    parent.unlink(discard)
                  } catch {}
                  throw new Error("Concurrent edit preserved during rollback")
                }
              }
              if (row.expected) {
                if (held) {
                  parent.link(row.hold, parent.file)
                  parent.unlink(row.hold)
                } else {
                  const staged = parent.read(restore)
                  if (staged && !sameFile(staged, row.expected))
                    throw new Error("Rollback restore stage changed")
                  if (!staged) parent.write(restore, original!, row.expected.mode)
                  parent.link(restore, parent.file)
                  parent.unlink(restore)
                }
              }
              cleanup(discard, row.target)
              cleanup(`${row.hold}.next`, row.target)
            } finally {
              parent.close()
            }
          }
          delete tree.applyRows
          tree.status = "conflict"
          tree.error = "Interrupted apply rolled back; preview again"
          this.#write(journal)
          return { rolledBack: id }
        } finally {
          release()
        }
      }, true)
    } finally {
      await unlock()
    }
  }
  async recover(id: string) {
    const tree = this.#record(this.#read(), id)
    return {
      ...tree,
      sourceRef: `refs/codesplash/worktrees/${id}/source`,
      recoveryRef: `refs/codesplash/worktrees/${id}/recovery`,
      instruction:
        "Inspect source/recovery refs with git show or git diff. Resolve conflicts explicitly, then generate a fresh preview before apply. No effects are replayed.",
    }
  }
  async remove(id: string) {
    return this.#transaction(async (journal) => {
      const tree = this.#record(journal, id),
        release = lease(join(this.root, id), "active.lease")
      try {
        if (tree.status !== "ready") throw new Error("Worktree lifecycle needs recovery before removal")
        await this.#identity(tree)
        this.#disk(tree.cwd)
        const ignored = await git(tree.cwd, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"])
        const hidden = (await git(tree.cwd, ["ls-files", "-v", "-z"]))
          .toString()
          .split("\0")
          .filter(Boolean)
          .some((line) => line[0] !== "H" && !(line[0] === "S" && tree.excluded.includes(line.slice(2))))
        const existing = (
          await git(tree.cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        )
          .toString()
          .split("\0")
          .filter(Boolean)
        if (
          existing.some(
            (path) =>
              (!this.#eligible(path) || tree.excluded.includes(path)) &&
              existsSync(join(tree.cwd, snapshotPath(path))),
          )
        )
          throw new Error("Excluded worktree content prevents removal")
        const currentHead = (await git(tree.cwd, ["rev-parse", "HEAD"])).toString().trim()
        const snapshot = await this.#snapshot(tree.cwd, currentHead, tree.id)
        const cleanTree = (await git(tree.cwd, ["rev-parse", `${currentHead}^{tree}`])).toString().trim()
        const changes = (await git(tree.cwd, ["diff", "--name-only", "-z", currentHead, snapshot, "--"]))
          .toString()
          .split("\0")
          .filter((path) => path && !tree.excluded.includes(path) && this.#eligible(path))
        const indexTree = (await git(tree.cwd, ["write-tree"])).toString().trim()
        if (ignored.length || hidden || changes.length || cleanTree !== indexTree)
          throw new Error("Dirty, ignored or hidden-index worktree content prevents removal")
        const head = (await git(tree.cwd, ["rev-parse", "HEAD"])).toString().trim()
        await git(this.repo, ["update-ref", `refs/codesplash/worktrees/${id}/retained`, head])
        tree.status = "removing"
        this.#write(journal)
        await git(this.repo, ["worktree", "unlock", tree.cwd])
        await git(this.repo, ["worktree", "remove", "--force", tree.cwd])
        journal.trees = journal.trees.filter((t) => t.id !== id)
        this.#write(journal)
        return { removed: id, retained: `refs/codesplash/worktrees/${id}/retained` }
      } finally {
        release()
      }
    })
  }
  async gc() {
    const removed: string[] = [],
      retained: { id: string; reason: string }[] = []
    for (const tree of this.#read().trees) {
      try {
        await this.remove(tree.id)
        removed.push(tree.id)
      } catch (e) {
        retained.push({ id: tree.id, reason: e instanceof Error ? e.message : "Unavailable" })
      }
    }
    return { removed, retained }
  }
}
