import type { SessionMeta } from "../sessions.ts"
import type { BranchView } from "./branches.ts"
import type { RestoreJournal, RestorePreview } from "./restore.ts"
export type RecoveryRequest =
  | { action: "tree" }
  | { action: "gc-recovery"; revision: string }
  | { action: "acknowledge-fork"; id: string; revision: string }
  | { action: "fork"; node?: string }
  | { action: "rewind"; node: string; revision?: string; apply?: boolean }
  | { action: "checkpoints" }
  | { action: "checkpoint-diff"; checkpoint: string }
  | { action: "pin-branch"; node: string; pinned: boolean; revision: string }
  | { action: "pin-checkpoint"; checkpoint: string; pinned: boolean; revision: string }
  | { action: "restore"; checkpoint: string; paths?: string[]; revision?: string; apply?: boolean }
  | { action: "recover-restore"; direction: "finish" | "rollback" }
  | { action: "prune-branches"; nodes: string[]; revision: string }
  | { action: "prune-checkpoints"; checkpoints: string[]; revision: string }
export type RecoveryResult = {
  title: string
  data: BranchView | SessionMeta | RestorePreview | RestoreJournal | Record<string, unknown>
  fork?: SessionMeta
}
