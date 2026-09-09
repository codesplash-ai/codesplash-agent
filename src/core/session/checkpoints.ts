import { existsSync, lstatSync, readdirSync, unlinkSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import type { SessionStateAccess } from "./control.ts"
import { atomic, bytes, canonicalRoot, component, digest, directory, hostPath } from "./files.ts"
import { attachmentIdentity } from "./input-queue.ts"
import { SafeParent } from "./secure-path.ts"

export type CheckpointPolicy = {
  cwd: string
  scope?: string
  trusted(): boolean
  writable(): boolean
  readable(path: string): boolean
  writablePath(path: string): boolean
  sanitize(text: string): string
  protectedPaths: readonly string[]
}
export type SnapshotFile = { blob: string; hash: string; mode: 0o644 | 0o755; size: number }
export type FileSnapshot = {
  version: 1
  id: string
  commit: string
  cwd: string
  created: string
  files: Record<string, SnapshotFile>
  excluded: Array<{ path: string; reason: string }>
}
export type SnapshotRef = { id: string; hash: string }
export type CheckpointStep = {
  id: string
  label: string
  created: string
  before: SnapshotRef
  after?: SnapshotRef
  context?: string
}
export type CheckpointState = { version: 1; steps: CheckpointStep[]; pins: string[]; restore?: unknown }
const FILE_LIMIT = 2 * 1024 * 1024,
  TOTAL_LIMIT = 64 * 1024 * 1024
const oid = /^[a-f0-9]{40}$/
const hash = /^[a-f0-9]{64}$/
const deniedNames =
  /^(?:\.git|\.codex|\.agents|\.claude|\.codesplash(?:-.*)?|node_modules|vendor|\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519|dsa))(?:$)|\.(?:pem|key|p12|pfx)$/i

export function snapshotPath(value: string): string {
  // Paths are data passed via NUL trees, never command options or shell source.
  if (
    !value ||
    value.length > 4096 ||
    isAbsolute(value) ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject unsupported path bytes
    /[\x00-\x1f\x7f\\]/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Unsafe checkpoint path")
  return value
}
function within(root: string, path: string): boolean {
  const rel = relative(hostPath(root), hostPath(path))
  return (
    !rel ||
    (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== ".." && !isAbsolute(rel))
  )
}

/** Private bare Git blobs/trees only. The user's repository/index/config are never selected. */
export class CheckpointStore {
  readonly root: string | undefined
  readonly gitDirectory: string | undefined
  readonly key: string
  constructor(
    readonly state: SessionStateAccess,
    readonly policy: CheckpointPolicy,
  ) {
    if (policy.scope && !hash.test(policy.scope)) throw new Error("Invalid checkpoint directory scope")
    this.key = policy.scope ? `checkpoints:${policy.scope}` : "checkpoints"
    this.root = state.directory
      ? join(state.directory, "checkpoints", ...(policy.scope ? [policy.scope] : []))
      : undefined
    this.gitDirectory = this.root ? join(this.root, "objects.git") : undefined
  }
  availability(): string | undefined {
    if (process.platform !== "darwin" && process.platform !== "linux")
      return "Native file checkpoints require macOS or Linux"
    if (!this.state.durable || !this.root) return "File checkpoints require recorded history"
    if (!this.policy.trusted()) return "File checkpoints require a trusted workspace"
    if (!this.policy.writable()) return "File checkpoints are unavailable in read-only or plan mode"
    if (!Bun.which("git")) return "File checkpoints require Git"
    return undefined
  }
  view(): CheckpointState & { revision: string; unavailable?: string } {
    const record = this.state.read()
    const data = (record.state.values[this.key] ?? { version: 1, steps: [], pins: [] }) as CheckpointState
    if (
      data.version !== 1 ||
      !Array.isArray(data.steps) ||
      data.steps.length > 1000 ||
      !Array.isArray(data.pins)
    )
      throw new Error("Unsupported checkpoint state")
    const ids = new Set<string>()
    for (const step of data.steps) {
      if (
        !step ||
        typeof step.label !== "string" ||
        step.label.length > 200 ||
        typeof step.created !== "string" ||
        !/^[a-f0-9-]{36}$/.test(step.id) ||
        ids.has(step.id) ||
        !validRef(step.before) ||
        (step.after && !validRef(step.after))
      )
        throw new Error("Corrupt checkpoint step")
      ids.add(step.id)
    }
    if (data.pins.some((id) => !ids.has(id))) throw new Error("Invalid checkpoint pin")
    return { ...structuredClone(data), revision: record.revision, unavailable: this.availability() }
  }
  #owned(): void {
    const reason = this.availability()
    if (reason) throw new Error(reason)
    if (!this.state.assertOwned) throw new Error("Checkpoint storage requires its writer lease")
    this.state.assertOwned()
  }
  eligible(path: string, write = false): boolean {
    const absolute = canonicalRoot(resolve(this.policy.cwd, snapshotPath(path)))
    return (
      within(this.policy.cwd, absolute) &&
      !path.split("/").some((part) => deniedNames.test(part)) &&
      !this.policy.protectedPaths.some((root) => within(root, absolute)) &&
      (!this.root || !within(this.root, absolute)) &&
      this.policy.readable(absolute) &&
      (!write || this.policy.writablePath(absolute))
    )
  }
  async begin(label: string, signal?: AbortSignal): Promise<string | undefined> {
    if (this.availability()) return undefined
    this.#owned()
    const before = this.view()
    if (before.restore) throw new Error("Finish or roll back the interrupted restore before another mutation")
    if (before.steps.length >= 1000) throw new Error("Checkpoint limit reached; prune unreferenced steps")
    const snapshot = await this.capture(signal),
      id = crypto.randomUUID()
    this.update(before.revision, "step-start", (state) => {
      state.steps.push({
        id,
        label: this.policy.sanitize(label).slice(0, 200),
        created: new Date().toISOString(),
        before: snapshot,
      })
    })
    return id
  }
  async end(id: string | undefined, signal?: AbortSignal): Promise<void> {
    if (!id) return
    this.#owned()
    const before = this.view(),
      snapshot = await this.capture(signal)
    this.update(before.revision, "step-finish", (state) => {
      const step = state.steps.find((step) => step.id === id)
      if (!step || step.after) throw new Error("Unknown or already completed checkpoint step")
      step.after = snapshot
    })
  }
  bindContext(context: string): void {
    this.update(this.view().revision, "context-bind", (state) => {
      for (const step of state.steps) if (!step.context && step.after) step.context = context
    })
  }
  step(id: string): CheckpointStep {
    const matches = this.view().steps.filter((step) => step.id === id || step.id.startsWith(id))
    if (matches.length !== 1) throw new Error("Checkpoint not found or ambiguous")
    return matches[0] as CheckpointStep
  }
  read(ref: SnapshotRef): FileSnapshot {
    if (!this.root || !validRef(ref)) throw new Error("Invalid checkpoint reference")
    const source = bytes(join(this.root, "snapshots", `${ref.id}.json`), 16 * 1024 * 1024)
    if (digest(source) !== ref.hash) throw new Error("Checkpoint manifest checksum mismatch")
    const snapshot = JSON.parse(source.toString()) as FileSnapshot
    if (
      snapshot.version !== 1 ||
      snapshot.id !== ref.id ||
      !oid.test(snapshot.commit) ||
      hostPath(snapshot.cwd) !== hostPath(this.policy.cwd) ||
      !snapshot.files ||
      typeof snapshot.files !== "object" ||
      Array.isArray(snapshot.files) ||
      Object.keys(snapshot.files).length > 5000 ||
      !Array.isArray(snapshot.excluded)
    )
      throw new Error("Corrupt checkpoint manifest")
    for (const [path, file] of Object.entries(snapshot.files)) {
      snapshotPath(path)
      if (
        !file ||
        !oid.test(file.blob) ||
        !hash.test(file.hash) ||
        ![0o644, 0o755].includes(file.mode) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > FILE_LIMIT
      )
        throw new Error("Corrupt checkpoint file")
    }
    return snapshot
  }
  async content(file: SnapshotFile): Promise<Buffer> {
    if (!oid.test(file.blob)) throw new Error("Invalid Git blob")
    const data = await this.git(["cat-file", "blob", file.blob])
    if (data.length !== file.size || digest(data) !== file.hash)
      throw new Error("Checkpoint blob checksum mismatch")
    return data
  }
  async capture(signal?: AbortSignal): Promise<SnapshotRef> {
    this.#owned()
    await this.#initialize()
    if (this.diskUsage() + TOTAL_LIMIT > 512 * 1024 * 1024)
      throw new Error(
        "Checkpoint assets approach 512 MiB; prune abandoned branches/checkpoints and collect unreferenced recovery assets",
      )
    const root = this.root as string,
      files: Record<string, SnapshotFile> = {},
      excluded: FileSnapshot["excluded"] = []
    const candidates: string[] = []
    let entries = 0,
      total = 0
    const walk = (dir: string, prefix = "") => {
      signal?.throwIfAborted()
      directory(dir)
      const ignore = join(dir, ".gitignore")
      if (
        existsSync(ignore) &&
        (!this.policy.readable(ignore) || !lstatSync(ignore).isFile() || lstatSync(ignore).nlink !== 1)
      ) {
        excluded.push({ path: prefix || ".", reason: "Ignore rules cannot be read safely" })
        return
      }
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (++entries > 10000) throw new Error("Checkpoint scan exceeds 10,000 entries")
        const path = prefix ? `${prefix}/${entry.name}` : entry.name
        try {
          snapshotPath(path)
        } catch {
          excluded.push({ path: "[unsupported filename]", reason: "Unsafe filename" })
          continue
        }
        if (!this.eligible(path)) {
          excluded.push({ path, reason: "Protected, secret-shaped or denied path" })
          continue
        }
        if (entry.isSymbolicLink()) {
          excluded.push({ path, reason: "Symlink" })
          continue
        }
        if (entry.isDirectory()) walk(join(dir, entry.name), path)
        else if (entry.isFile()) candidates.push(path)
        else excluded.push({ path, reason: "Special file" })
      }
    }
    walk(this.policy.cwd)
    // Check-ignore reads only worktree .gitignore files; denied-rule subtrees were excluded above.
    const ignored = candidates.length
      ? new Set(
          (
            await this.git(
              ["--work-tree", this.policy.cwd, "check-ignore", "--no-index", "--stdin", "-z"],
              Buffer.from(`${candidates.map((path) => `./${path}`).join("\0")}\0`),
              [0, 1],
            )
          )
            .toString()
            .split("\0")
            .map((path) => path.replace(/^\.\//, "")),
        )
      : new Set<string>()
    for (const path of candidates.sort()) {
      signal?.throwIfAborted()
      if (ignored.has(path)) {
        excluded.push({ path, reason: "Ignored by worktree rules" })
        continue
      }
      const absolute = join(this.policy.cwd, path),
        info = lstatSync(absolute),
        identity = attachmentIdentity(absolute)
      if (!identity || info.nlink !== 1) {
        excluded.push({ path, reason: "Unsafe or hardlinked file" })
        continue
      }
      if (info.size > FILE_LIMIT || total + info.size > TOTAL_LIMIT || Object.keys(files).length >= 5000) {
        excluded.push({ path, reason: "File or snapshot quota" })
        continue
      }
      if (!this.eligible(path)) {
        excluded.push({ path, reason: "Permissions changed" })
        continue
      }
      const parent = SafeParent.open(this.policy.cwd, path)
      if (!parent) throw new Error("Checkpoint parent disappeared")
      let content: Buffer
      try {
        const read = parent.read()
        if (!read) throw new Error("Checkpoint file disappeared")
        content = read.content
      } finally {
        parent.close()
      }
      if (attachmentIdentity(absolute)?.fingerprint !== identity.fingerprint)
        throw new Error("File changed during checkpoint capture")
      const text = content.toString("utf8")
      if (this.policy.sanitize(text) !== text) {
        excluded.push({ path, reason: "Content contains secret-shaped data" })
        continue
      }
      const blob = (await this.git(["hash-object", "-w", "--no-filters", "--stdin"], content))
        .toString()
        .trim()
      if (!oid.test(blob)) throw new Error("Invalid Git object response")
      files[path] = {
        blob,
        hash: digest(content),
        mode: info.mode & 0o111 ? 0o755 : 0o644,
        size: content.length,
      }
      total += content.length
    }
    const tree = await this.#tree(files),
      commit = (await this.git(["commit-tree", tree], Buffer.from("CodeSplash private checkpoint\n")))
        .toString()
        .trim()
    if (!oid.test(commit)) throw new Error("Invalid Git checkpoint commit")
    const snapshot: FileSnapshot = {
      version: 1,
      id: crypto.randomUUID(),
      commit,
      cwd: hostPath(this.policy.cwd),
      created: new Date().toISOString(),
      files,
      excluded,
    }
    const source = JSON.stringify(snapshot)
    atomic(join(root, "snapshots", `${snapshot.id}.json`), source)
    await this.git(["update-ref", `refs/checkpoints/${snapshot.id}`, commit])
    return { id: snapshot.id, hash: digest(source) }
  }
  diskUsage(): number {
    const root = this.state.directory ? join(this.state.directory, "checkpoints") : undefined
    if (!root || !existsSync(root)) return 0
    let count = 0
    const size = (path: string): number => {
      if (++count > 100000) throw new Error("Checkpoint object count exceeds limit")
      const info = lstatSync(path)
      if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)))
        throw new Error("Unsafe checkpoint asset")
      return info.isDirectory()
        ? readdirSync(path).reduce((sum, name) => sum + size(join(path, component(name))), 0)
        : info.size
    }
    return size(root)
  }
  async collect(revision: string): Promise<{ snapshots: number; reclaimedBytes: number }> {
    this.#owned()
    const state = this.view()
    if (state.revision !== revision || state.restore)
      throw new Error("Session changed or restore requires recovery")
    if (!this.root || !existsSync(this.root)) return { snapshots: 0, reclaimedBytes: 0 }
    const before = this.diskUsage(),
      retained = new Set(state.steps.flatMap((step) => [step.before.id, step.after?.id]))
    let snapshots = 0
    const root = join(this.root, "snapshots")
    if (existsSync(root))
      for (const name of readdirSync(root)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name) || retained.has(name.slice(0, -5))) continue
        await this.git(["update-ref", "-d", `refs/checkpoints/${name.slice(0, -5)}`])
        unlinkSync(join(root, name))
        snapshots++
      }
    await this.git(["prune", "--expire=now"])
    return { snapshots, reclaimedBytes: Math.max(0, before - this.diskUsage()) }
  }
  async #tree(files: Record<string, SnapshotFile>, prefix = ""): Promise<string> {
    const rows: string[] = [],
      directories = new Set<string>()
    for (const [path, file] of Object.entries(files)) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length),
        split = rest.indexOf("/")
      if (split >= 0) directories.add(rest.slice(0, split))
      else rows.push(`${file.mode === 0o755 ? "100755" : "100644"} blob ${file.blob}\t${rest}\0`)
    }
    for (const name of [...directories].sort())
      rows.push(`040000 tree ${await this.#tree(files, `${prefix}${name}/`)}\t${name}\0`)
    const result = (await this.git(["mktree", "-z"], Buffer.from(rows.join("")))).toString().trim()
    if (!oid.test(result)) throw new Error("Invalid Git tree")
    return result
  }
  async #initialize(): Promise<void> {
    const root = this.root as string
    directory(root, true)
    if (!existsSync(join(this.gitDirectory as string, "HEAD")))
      await this.git(["init", "--bare", "--template=", "--object-format=sha1", this.gitDirectory as string])
    directory(this.gitDirectory as string)
  }
  async git(args: string[], input?: Buffer, accepted = [0]): Promise<Buffer> {
    if (!this.gitDirectory) throw new Error("No private checkpoint repository")
    const processGit = Bun.spawn(
      [
        Bun.which("git") ?? "git",
        "--no-pager",
        "--git-dir",
        this.gitDirectory,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.attributesFile=/dev/null",
        "-c",
        "core.excludesFile=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.autocrlf=false",
        "-c",
        "gc.auto=0",
        "-c",
        "protocol.allow=never",
        ...args,
      ],
      {
        cwd: this.policy.cwd,
        stdin: input ? new Blob([new Uint8Array(input)]) : "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env.PATH,
          LC_ALL: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_ATTR_NOSYSTEM: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_AUTHOR_NAME: "CodeSplash",
          GIT_AUTHOR_EMAIL: "local@codesplash.invalid",
          GIT_COMMITTER_NAME: "CodeSplash",
          GIT_COMMITTER_EMAIL: "local@codesplash.invalid",
        },
      },
    )
    const timer = setTimeout(() => processGit.kill("SIGKILL"), 15000)
    try {
      const [output, error, status] = await Promise.all([
        boundedOutput(processGit.stdout, () => processGit.kill("SIGKILL")),
        boundedOutput(processGit.stderr, () => processGit.kill("SIGKILL")).then((value) => value.toString()),
        processGit.exited,
      ])
      if (!accepted.includes(status))
        throw new Error(`Private checkpoint Git failed: ${this.policy.sanitize(error).slice(0, 500)}`)
      if (output.byteLength > 16 * 1024 * 1024) throw new Error("Private Git output exceeds limit")
      return Buffer.from(output)
    } finally {
      clearTimeout(timer)
    }
  }
  update(revision: string, operation: string, change: (state: CheckpointState) => void): void {
    this.#owned()
    this.state.update(revision, `checkpoint/${operation}`, (state) => {
      const checkpoints = (state.values[this.key] ?? { version: 1, steps: [], pins: [] }) as CheckpointState
      change(checkpoints)
      state.values[this.key] = checkpoints
    })
  }
  pin(id: string, pinned: boolean, revision: string): void {
    const step = this.step(id)
    this.update(revision, "pin", (state) => {
      state.pins = state.pins.filter((value) => value !== step.id)
      if (pinned) state.pins.push(step.id)
    })
  }
  async diff(id: string) {
    const step = this.step(id)
    if (!step.after) throw new Error("Interrupted checkpoint has no after-image")
    const before = this.read(step.before),
      after = this.read(step.after)
    const rows = []
    for (const path of [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort()) {
      const a = before.files[path],
        b = after.files[path]
      if (a?.hash === b?.hash && a?.mode === b?.mode) continue
      if (!this.eligible(path)) {
        rows.push({ path, unavailable: "Current read policy excludes this path" })
        continue
      }
      const render = async (file: SnapshotFile | undefined) => {
        if (!file) return null
        const content = await this.content(file)
        if (content.includes(0)) return { hash: file.hash, size: file.size, mode: file.mode, binary: true }
        return {
          hash: file.hash,
          size: file.size,
          mode: file.mode,
          text: this.policy.sanitize(content.toString()).slice(0, 8192),
          truncated: content.length > 8192,
        }
      }
      rows.push({ path, before: await render(a), after: await render(b) })
      if (rows.length >= 100) break
    }
    return { checkpoint: step.id, rows, limit: 100, excluded: [...before.excluded, ...after.excluded] }
  }
  async prune(ids: string[], referencedContexts: ReadonlySet<string>, revision: string): Promise<string[]> {
    const before = this.view(),
      selected = new Set(ids.map((id) => this.step(id).id))
    if (
      before.restore ||
      before.steps.some(
        (step) =>
          selected.has(step.id) &&
          (!step.after ||
            before.pins.includes(step.id) ||
            (step.context && referencedContexts.has(step.context))),
      )
    )
      throw new Error("Only complete, unreferenced, unpinned checkpoints can be pruned")
    this.update(revision, "prune", (state) => {
      state.steps = state.steps.filter((step) => !selected.has(step.id))
    })
    const retained = new Set(this.view().steps.flatMap((step) => [step.before.id, step.after?.id]))
    for (const step of before.steps.filter((step) => selected.has(step.id)))
      for (const ref of [step.before, step.after])
        if (ref && !retained.has(ref.id)) {
          await this.git(["update-ref", "-d", `refs/checkpoints/${ref.id}`])
          unlinkSync(join(this.root as string, "snapshots", `${component(ref.id)}.json`))
        }
    await this.git(["prune", "--expire=now"])
    return [...selected]
  }
}
function validRef(value: SnapshotRef | undefined): boolean {
  return !!value && /^[a-f0-9-]{36}$/.test(value.id) && hash.test(value.hash)
}

async function boundedOutput(stream: ReadableStream<Uint8Array>, cancel: () => void): Promise<Buffer> {
  const reader = stream.getReader(),
    chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks)
      total += value.length
      if (total > 16 * 1024 * 1024) {
        cancel()
        throw new Error("Private Git output exceeds 16 MiB")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
}
