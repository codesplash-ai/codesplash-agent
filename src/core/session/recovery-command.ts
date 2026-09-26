import { parse } from "shell-quote"
import type { RecoveryRequest } from "./recovery-contract.ts"

/** Shared slash/CLI grammar; shell operators are data errors, never evaluated. */
export function recoveryCommand(action: string, source: string | string[], apply = false): RecoveryRequest {
  const parsed = typeof source === "string" ? parse(source, () => "") : source
  if (parsed.some((part) => typeof part !== "string"))
    throw new Error("Recovery commands accept literal arguments only")
  const args = [...parsed] as string[]
  let revision: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") {
      apply = true
      args.splice(i--, 1)
    } else if (args[i] === "--revision") {
      revision = args[i + 1]
      if (!revision || revision.startsWith("--")) throw new Error("--revision requires the reviewed revision")
      args.splice(i--, 2)
    }
  }
  const [id, ...rest] = args
  if (action === "acknowledge-fork" && id && revision && !rest.length && apply)
    return { action, id, revision }
  if (action === "gc-recovery" && !id && revision && apply) return { action, revision }
  if (action === "hunks" && id && rest.length === 1) return { action, checkpoint: id, path: rest[0]! }
  if (["accept-hunk", "reject-hunk"].includes(action) && id && rest.length === 2)
    return {
      action: action as "accept-hunk" | "reject-hunk",
      checkpoint: id,
      path: rest[0]!,
      hunk: rest[1]!,
      revision,
      apply,
    }
  if (action === "tree" && !id) return { action }
  if (action === "fork" && !rest.length) return { action, node: id }
  if (action === "rewind" && id && !rest.length) return { action, node: id, revision, apply }
  if (action === "checkpoints" && !id) return { action }
  if (action === "checkpoint-diff" && id && !rest.length) return { action, checkpoint: id }
  if (action === "restore" && id)
    return { action, checkpoint: id, paths: rest.length ? rest : undefined, revision, apply }
  if (action === "recover-restore" && (id === "finish" || id === "rollback") && !rest.length && apply)
    return { action, direction: id }
  if (
    action === "pin-branch" &&
    id &&
    revision &&
    rest.length <= 1 &&
    (!rest[0] || rest[0] === "off") &&
    apply
  )
    return { action, node: id, pinned: rest[0] !== "off", revision }
  if (
    action === "pin-checkpoint" &&
    id &&
    revision &&
    rest.length <= 1 &&
    (!rest[0] || rest[0] === "off") &&
    apply
  )
    return { action, checkpoint: id, pinned: rest[0] !== "off", revision }
  if (action === "prune-branches" && id && revision && apply) return { action, nodes: args, revision }
  if (action === "prune-checkpoints" && id && revision && apply)
    return { action, checkpoints: args, revision }
  throw new Error(
    "Use tree | fork [NODE] | rewind NODE | checkpoints | checkpoint-diff ID | hunks ID PATH | accept-hunk ID PATH HUNK | reject-hunk ID PATH HUNK | restore ID [PATH…]. Apply a preview with --apply --revision REV. Recovery: recover-restore finish|rollback --apply. Pins/prune require --apply --revision REV.",
  )
}
