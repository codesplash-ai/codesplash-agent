import { basename, dirname, join, relative } from "node:path"
import { type CheckpointStore, type FileSnapshot, type SnapshotFile, snapshotPath } from "./checkpoints.ts"
import { SafeParent } from "./secure-path.ts"

type CurrentFile = { hash: string; mode: number; size: number }
export type RestoreRow = { path: string; expected?: SnapshotFile; target?: SnapshotFile; conflict?: string }
export type RestorePreview = {
  checkpoint: string
  revision: string
  direction: "before" | "after"
  rows: RestoreRow[]
  excluded: FileSnapshot["excluded"]
}
type RestoreEntry = RestoreRow & { applied?: boolean; rolledBack?: boolean }
export type RestoreJournal = {
  version: 1
  id: string
  checkpoint: string
  created: string
  status: "prepared" | "applying" | "interrupted" | "completed" | "rolled-back"
  direction: "finish" | "rollback"
  entries: RestoreEntry[]
  issue?: string
}
function same(current: CurrentFile | undefined, expected: CurrentFile | undefined): boolean {
  return current === undefined
    ? expected === undefined
    : !!expected &&
        current.hash === expected.hash &&
        current.mode === expected.mode &&
        current.size === expected.size
}
/** Recoverable, no-clobber per-file replacement. There is deliberately no force mode. */
export class RestoreService {
  constructor(
    readonly store: CheckpointStore,
    readonly afterFile?: (index: number) => void,
    readonly beforeInstall?: (path: string) => void,
  ) {}
  journal(): RestoreJournal | undefined {
    const journal = this.store.view().restore as RestoreJournal | undefined
    if (!journal) return undefined
    if (
      journal.version !== 1 ||
      !/^[a-f0-9-]{36}$/.test(journal.id) ||
      !["prepared", "applying", "interrupted", "completed", "rolled-back"].includes(journal.status) ||
      !["finish", "rollback"].includes(journal.direction) ||
      !Array.isArray(journal.entries) ||
      journal.entries.length > 5000 ||
      new Set(journal.entries.map((entry) => entry.path)).size !== journal.entries.length
    )
      throw new Error("Corrupt restore journal; preserve recovery holds")
    for (const entry of journal.entries) {
      snapshotPath(entry.path)
      for (const file of [entry.expected, entry.target])
        if (
          file &&
          (!/^[a-f0-9]{40}$/.test(file.blob) ||
            !/^[a-f0-9]{64}$/.test(file.hash) ||
            ![0o644, 0o755].includes(file.mode) ||
            !Number.isSafeInteger(file.size) ||
            file.size < 0 ||
            file.size > 2 * 1024 * 1024)
        )
          throw new Error("Corrupt restore before-image")
    }
    return journal
  }
  preview(
    checkpoint: string,
    selected?: readonly string[],
    direction: "before" | "after" = "before",
  ): RestorePreview {
    const view = this.store.view(),
      step = this.store.step(checkpoint)
    if (!step.after) throw new Error("Checkpoint has no completed after-image; inspect the interrupted step")
    const before = this.store.read(step.before),
      after = this.store.read(step.after)
    const expected = direction === "before" ? after : before,
      target = direction === "before" ? before : after
    const paths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort()
    const wanted = selected ? new Set(selected.map(snapshotPath)) : undefined
    if (wanted && [...wanted].some((path) => !paths.includes(path)))
      throw new Error("Selected path has no checkpoint coverage")
    const excluded = [...before.excluded, ...after.excluded]
    const rows = paths
      .filter((path) => (!wanted || wanted.has(path)) && !same(expected.files[path], target.files[path]))
      .map((path): RestoreRow => {
        let conflict: string | undefined
        if (
          excluded.some((item) => path === item.path || path.startsWith(`${item.path}/`) || item.path === ".")
        )
          conflict = "A snapshot excluded this path; its absence is not a recorded deletion"
        else if (!this.store.eligible(path, true)) conflict = "Current permissions exclude this path"
        else {
          try {
            if (!same(this.#current(path), expected.files[path]))
              conflict = "Current bytes or mode differ from the expected checkpoint"
          } catch {
            conflict = "Current path cannot be read safely"
          }
        }
        return { path, expected: expected.files[path], target: target.files[path], conflict }
      })
    return { checkpoint: step.id, revision: view.revision, direction, rows, excluded }
  }
  async apply(preview: RestorePreview): Promise<RestoreJournal> {
    if (this.journal()) throw new Error("A restore already requires recovery or acknowledgment")
    const fresh = this.preview(
      preview.checkpoint,
      preview.rows.map((row) => row.path),
      preview.direction,
    )
    if (fresh.revision !== preview.revision) throw new Error("Session changed; refresh the restore preview")
    if (JSON.stringify(fresh.rows) !== JSON.stringify(preview.rows))
      throw new Error("Restore preview changed; review it again")
    if (!fresh.rows.length || fresh.rows.some((row) => row.conflict))
      throw new Error("Restore has no selected changes or contains conflicts")
    // Validate every immutable blob before the first workspace mutation.
    for (const row of fresh.rows)
      for (const file of [row.expected, row.target]) if (file) await this.store.content(file)
    const journal: RestoreJournal = {
      version: 1,
      id: crypto.randomUUID(),
      checkpoint: fresh.checkpoint,
      created: new Date().toISOString(),
      status: "prepared",
      direction: "finish",
      entries: fresh.rows,
    }
    this.store.update(preview.revision, "restore-prepare", (state) => {
      state.restore = journal
    })
    return this.#run()
  }
  async recover(action: "finish" | "rollback"): Promise<RestoreJournal> {
    const journal = this.journal()
    if (!journal) throw new Error("No interrupted restore")
    if (journal.status === "completed" || journal.status === "rolled-back") {
      await this.#cleanup(journal)
      return journal
    }
    if (action === "rollback")
      this.#record((value) => {
        value.direction = "rollback"
      })
    return this.#run()
  }
  async #run(): Promise<RestoreJournal> {
    let journal = this.journal() as RestoreJournal
    this.#record((value) => {
      value.status = "applying"
      delete value.issue
    })
    try {
      const indices = journal.entries.map((_, index) => index)
      if (journal.direction === "rollback") indices.reverse()
      for (const index of indices) {
        journal = this.journal() as RestoreJournal
        const row = journal.entries[index] as RestoreEntry
        const forwardHold = this.#hold(journal, index, false)
        if (journal.direction === "finish") {
          if (!row.applied) await this.#replace(row.path, row.expected, row.target, forwardHold)
          else if (!same(this.#current(row.path), row.target))
            throw new Error(`Restored file changed: ${row.path}`)
          this.#record((value) => {
            ;(value.entries[index] as RestoreEntry).applied = true
          })
        } else {
          if (!row.rolledBack) {
            // A crash may leave the old file in its hold before the replacement was installed.
            if (this.#at(forwardHold) && !this.#current(row.path)) {
              if (!same(this.#at(forwardHold), row.expected))
                throw new Error(`Recovery hold changed: ${row.path}`)
              if (row.expected) {
                const parent = SafeParent.open(this.store.policy.cwd, row.path)
                if (!parent) throw new Error("Restore parent disappeared")
                try {
                  parent.link(basename(forwardHold), parent.file)
                  parent.unlink(basename(forwardHold))
                } finally {
                  parent.close()
                }
              }
            } else if (!same(this.#current(row.path), row.expected))
              await this.#replace(row.path, row.target, row.expected, this.#hold(journal, index, true))
          }
          if (!same(this.#current(row.path), row.expected)) throw new Error(`Rollback conflict: ${row.path}`)
          this.#record((value) => {
            ;(value.entries[index] as RestoreEntry).rolledBack = true
          })
        }
        this.afterFile?.(index)
      }
      this.#record((value) => {
        value.status = value.direction === "finish" ? "completed" : "rolled-back"
      })
      journal = this.journal() as RestoreJournal
      await this.#cleanup(journal)
      return journal
    } catch (error) {
      this.#record((value) => {
        value.status = "interrupted"
        value.issue = this.store.policy
          .sanitize(error instanceof Error ? error.message : String(error))
          .slice(0, 1000)
      })
      throw error
    }
  }
  async #replace(
    path: string,
    expected: SnapshotFile | undefined,
    target: SnapshotFile | undefined,
    hold: string,
  ): Promise<void> {
    if (this.store.availability() || !this.store.eligible(path, true))
      throw new Error(`Restore no longer permitted: ${path}`)
    const parent = SafeParent.open(this.store.policy.cwd, path, true)
    if (!parent) throw new Error("Restore parent disappeared")
    const holdName = basename(hold),
      stage = `${holdName}.next`
    try {
      const current = parent.read()
      if (same(current, target)) return
      if (parent.read(holdName)) {
        if (!same(parent.read(holdName), expected) || current !== undefined)
          throw new Error(`Recovery hold conflict: ${path}`)
      } else {
        if (!same(current, expected)) throw new Error(`External edit preserved: ${path}`)
        if (expected) {
          parent.rename(parent.file, holdName)
          if (!same(parent.read(holdName), expected)) {
            try {
              parent.link(holdName, parent.file)
              parent.unlink(holdName)
            } catch {
              /* Keep both external evidence and the journal. */
            }
            throw new Error(`File changed during restore; recovery evidence preserved: ${path}`)
          }
        }
      }
      if (target) {
        const content = await this.store.content(target)
        if (!this.store.eligible(path, true)) throw new Error(`Restore permissions changed: ${path}`)
        parent.assertVisible()
        if (parent.read(stage)) {
          if (!same(parent.read(stage), target)) throw new Error(`Recovery stage changed: ${path}`)
        } else parent.write(stage, content, target.mode)
        this.beforeInstall?.(path)
        // Directory-relative linkat refuses a concurrently recreated target and never follows a swapped parent.
        parent.link(stage, parent.file)
        parent.unlink(stage)
      }
      parent.assertVisible()
      if (!same(parent.read(), target))
        throw new Error(`Concurrent edit preserved after replacement: ${path}`)
    } finally {
      parent.close()
    }
  }
  #current(path: string): CurrentFile | undefined {
    if (!this.store.eligible(path, true))
      throw new Error("File is outside current restore permission coverage")
    return this.#at(join(this.store.policy.cwd, snapshotPath(path)))
  }
  #at(path: string): CurrentFile | undefined {
    const parent = SafeParent.open(this.store.policy.cwd, snapshotPath(relative(this.store.policy.cwd, path)))
    try {
      return parent?.read()
    } finally {
      parent?.close()
    }
  }
  #hold(journal: RestoreJournal, index: number, undo: boolean): string {
    const entry = journal.entries[index] as RestoreEntry
    return join(
      this.store.policy.cwd,
      dirname(snapshotPath(entry.path)),
      `.codesplash-restore-${journal.id}-${index}${undo ? "-undo" : ""}`,
    )
  }
  #record(change: (journal: RestoreJournal) => void): void {
    const current = this.journal()
    if (!current) throw new Error("Restore journal disappeared")
    this.store.update(this.store.view().revision, "restore-progress", (state) => {
      change(current)
      state.restore = current
    })
  }
  async #cleanup(journal: RestoreJournal): Promise<void> {
    for (let index = 0; index < journal.entries.length; index++) {
      if (this.store.availability()) throw new Error("Restore cleanup is no longer permitted")
      const row = journal.entries[index] as RestoreEntry,
        parent = SafeParent.open(this.store.policy.cwd, row.path)
      if (!parent) throw new Error("Restore parent changed before cleanup")
      try {
        for (const undo of [false, true]) {
          const hold = basename(this.#hold(journal, index, undo)),
            expected = undo ? row.target : row.expected
          if (parent.read(hold)) {
            if (!same(parent.read(hold), expected))
              throw new Error(`Recovery hold changed; preserve it: ${row.path}`)
            parent.unlink(hold)
          }
          const stage = `${hold}.next`
          if (parent.read(stage)) {
            if (!same(parent.read(stage), undo ? row.expected : row.target))
              throw new Error(`Recovery stage changed: ${row.path}`)
            parent.unlink(stage)
          }
        }
      } finally {
        parent.close()
      }
    }
    this.store.update(this.store.view().revision, "restore-complete", (state) => {
      delete state.restore
    })
  }
}
