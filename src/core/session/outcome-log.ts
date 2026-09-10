import { existsSync } from "node:fs"
import { join } from "node:path"
import type { SessionStateAccess } from "./control.ts"
import { atomic, bytes, digest } from "./files.ts"
import type { OutcomeState } from "./outcomes.ts"

export function persistOutcomes(state: SessionStateAccess, outcomes: OutcomeState): void {
  if (!state.durable || !state.directory) return
  state.assertOwned?.()
  const rows = outcomes.rows.map((row) => JSON.stringify(row)).join("\n"),
    source = rows ? `${rows}\n` : ""
  if (Buffer.byteLength(source) > 4 * 1024 * 1024) throw new Error("Outcome cache exceeds 4 MiB")
  const hash = digest(source),
    record = state.read(),
    cursor = record.state.values.outcomeCursor as { hash?: string; sequence?: number } | undefined
  const path = join(state.directory, "outcomes.jsonl")
  if (
    cursor?.hash === hash &&
    cursor.sequence === outcomes.cursor &&
    existsSync(path) &&
    digest(bytes(path, 4 * 1024 * 1024)) === hash
  )
    return
  atomic(path, source)
  state.update(record.revision, "outcomes/materialize", (value) => {
    value.values.outcomeCursor = {
      version: 1,
      hash,
      sequence: outcomes.cursor,
      rows: outcomes.rows.length,
      dropped: outcomes.dropped,
    }
  })
}
export function outcomeCacheStatus(
  state: SessionStateAccess,
  sequence?: number,
): "ephemeral" | "missing" | "verified" | "needs-rebuild" {
  if (!state.directory || !state.durable) return "ephemeral"
  const cursor = state.read().state.values.outcomeCursor as
    | { version?: number; hash?: string; sequence?: number }
    | undefined
  if (!cursor) return "missing"
  try {
    return cursor.version === 1 &&
      (sequence === undefined || cursor.sequence === sequence) &&
      digest(bytes(join(state.directory, "outcomes.jsonl"), 4 * 1024 * 1024)) === cursor.hash
      ? "verified"
      : "needs-rebuild"
  } catch {
    return "needs-rebuild"
  }
}
