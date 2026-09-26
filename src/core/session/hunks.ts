import type { CheckpointStore, SnapshotFile } from "./checkpoints.ts"
import { snapshotPath } from "./checkpoints.ts"
import { digest } from "./files.ts"
import { RestoreService } from "./restore.ts"
import { SafeParent } from "./secure-path.ts"
export type TextHunk = {
  id: string
  beforeStart: number
  afterStart: number
  removed: string[]
  added: string[]
}
/** Bounded LCS; ambiguous or large files use whole-file checkpoint restore instead. */
export function textHunks(before: string, after: string): TextHunk[] {
  const a = before.split("\n"),
    b = after.split("\n")
  if (a.length > 2000 || b.length > 2000 || before.length + after.length > 256000)
    throw new Error("Hunk diff exceeds bounded text limits; use checkpoint restore")
  const width = b.length + 1,
    table = new Uint16Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * width + j] =
        a[i] === b[j]
          ? 1 + table[(i + 1) * width + j + 1]!
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
  let i = 0,
    j = 0,
    current: Omit<TextHunk, "id"> | undefined
  const hunks: TextHunk[] = []
  const flush = () => {
    if (current) {
      hunks.push({ ...current, id: digest(JSON.stringify(current)).slice(0, 24) })
      current = undefined
    }
  }
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush()
      i++
      j++
      continue
    }
    current ??= { beforeStart: i, afterStart: j, removed: [], added: [] }
    if (j < b.length && (i === a.length || table[i * width + j + 1]! > table[(i + 1) * width + j]!))
      current.added.push(b[j++]!)
    else current.removed.push(a[i++]!)
  }
  flush()
  return hunks
}
export function rejectTextHunk(before: string, after: string, current: string, id: string): string {
  const hunk = textHunks(before, after).find((h) => h.id === id)
  if (!hunk) throw new Error("Unknown hunk")
  const lines = after.split("\n"),
    actual = current.split("\n"),
    start = Math.max(0, hunk.afterStart - 3),
    end = Math.min(lines.length, hunk.afterStart + hunk.added.length + 3),
    needle = lines.slice(start, end),
    matches: number[] = []
  for (let i = 0; i <= actual.length - needle.length; i++)
    if (needle.every((line, j) => actual[i + j] === line)) matches.push(i)
  if (matches.length !== 1)
    throw new Error("Hunk conflicts with external edits or repeated context; file preserved")
  actual.splice(matches[0]! + hunk.afterStart - start, hunk.added.length, ...hunk.removed)
  return actual.join("\n")
}
export class HunkService {
  constructor(readonly store: CheckpointStore) {}
  async preview(checkpoint: string, path: string) {
    snapshotPath(path)
    if (!this.store.eligible(path)) throw new Error("Path is outside current read policy")
    const step = this.store.step(checkpoint)
    if (!step.after) throw new Error("Checkpoint is incomplete")
    const before = this.store.read(step.before).files[path],
      after = this.store.read(step.after).files[path]
    const text = async (file: SnapshotFile | undefined) => {
      if (!file) return ""
      const value = await this.store.content(file)
      if (value.includes(0)) throw new Error("Binary files require whole-file restore")
      const raw = value.toString()
      if (this.store.policy.sanitize(raw) !== raw) throw new Error("Hunk operations refuse redacted content")
      return raw
    }
    const a = await text(before),
      b = await text(after),
      parent = SafeParent.open(this.store.policy.cwd, path)
    let current: ReturnType<SafeParent["read"]>
    try {
      current = parent?.read()
    } finally {
      parent?.close()
    }
    const raw = current?.content.toString() ?? ""
    if (this.store.policy.sanitize(raw) !== raw) throw new Error("Current file requires redaction")
    return {
      checkpoint,
      path,
      revision: this.store.view().revision,
      currentHash: current?.hash,
      before,
      after,
      beforeText: a,
      afterText: b,
      currentText: raw,
      hunks: textHunks(a, b).map((h) => ({ ...h, attribution: "agent-checkpoint" as const })),
      external: textHunks(b, raw).map((h) => ({ ...h, attribution: "external-since-checkpoint" as const })),
    }
  }
  async decide(
    checkpoint: string,
    path: string,
    hunk: string,
    decision: "accept" | "reject",
    revision: string,
    apply: boolean,
  ) {
    const preview = await this.preview(checkpoint, path)
    if (!preview.hunks.some((h) => h.id === hunk)) throw new Error("Unknown hunk")
    const next =
      decision === "reject"
        ? rejectTextHunk(preview.beforeText, preview.afterText, preview.currentText, hunk)
        : preview.currentText
    if (!apply) return { ...preview, decision, hunk, proposed: next }
    if (preview.revision !== revision || this.store.availability() || !this.store.eligible(path, true))
      throw new Error("Hunk decision requires current revision and write permission")
    if (decision === "reject") {
      const blob = async (text: string, mode: number): Promise<SnapshotFile> => ({
        blob: (await this.store.git(["hash-object", "-w", "--stdin"], Buffer.from(text))).toString().trim(),
        hash: digest(text),
        size: Buffer.byteLength(text),
        mode: mode === 0o755 ? 0o755 : 0o644,
      })
      const expected = preview.currentHash
        ? await blob(preview.currentText, preview.after?.mode ?? preview.before?.mode ?? 0o644)
        : undefined
      const target =
        !preview.before && next === "" ? undefined : await blob(next, preview.before?.mode ?? 0o644)
      await new RestoreService(this.store).applySelection(checkpoint, revision, [{ path, expected, target }])
    }
    this.store.state.update(this.store.state.read().revision, "hunk/decision", (state) => {
      const prior = (state.values.hunkDecisions ?? []) as unknown[]
      state.values.hunkDecisions = [
        ...prior.slice(-999),
        { checkpoint, path, hunk, decision, created: new Date().toISOString() },
      ]
    })
    return { checkpoint, path, hunk, decision, applied: true }
  }
}
