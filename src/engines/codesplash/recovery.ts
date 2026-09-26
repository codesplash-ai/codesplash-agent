import { dirname } from "node:path"
import type { SessionUsageSnapshot } from "../../core/engine.ts"
import { type BranchNode, BranchStore, validNativeContext } from "../../core/session/branches.ts"
import { type CheckpointPolicy, CheckpointStore } from "../../core/session/checkpoints.ts"
import type { SessionStateAccess } from "../../core/session/control.ts"
import { digest, hostPath } from "../../core/session/files.ts"
import { forkLocalSession } from "../../core/session/fork.ts"
import { HunkService } from "../../core/session/hunks.ts"
import { type RestorePreview, RestoreService } from "../../core/session/restore.ts"
import { workingDirectory } from "../../core/session/working-directory.ts"
import type { ChatMessage } from "./contracts.ts"
import { writeTranscriptSnapshot } from "./transcript.ts"

export class NativeRecovery {
  readonly branches: BranchStore
  readonly checkpoints: CheckpointStore
  readonly restore: RestoreService
  constructor(
    readonly state: SessionStateAccess,
    readonly policy: CheckpointPolicy,
    readonly host: {
      history(): ChatMessage[]
      replace(messages: ChatMessage[]): void
      usage(): SessionUsageSnapshot
      notes(): Record<string, string>
      selectNotes(notes: Record<string, string>): void
      sequence(): number
      startSequence(): number
      reset(): void
      pause(): void
      flush(): Promise<void>
      transcript?: string
      notice(text: string): void
    },
  ) {
    this.branches = new BranchStore(state)
    this.checkpoints = new CheckpointStore(state, policy)
    this.restore = new RestoreService(this.checkpoints)
  }
  async initialize(): Promise<void> {
    const graph = this.branches.view()
    if (graph.switch) {
      const target = this.branches.context(graph.switch.to),
        current = digest(JSON.stringify(this.host.history()))
      if (current === digest(JSON.stringify(target))) this.branches.finishSwitch()
      else if (
        graph.switch.from &&
        current === digest(JSON.stringify(this.branches.context(graph.switch.from)))
      )
        this.branches.cancelSwitch()
      else
        throw new Error(
          "Interrupted head switch needs inspection; transcript matches neither retained boundary",
        )
    }
    const head = this.branches.view().head
    if (!head) this.capture("base", "Context when M5 recovery opened")
    if (head && (graph.origin || graph.epoch > 0)) this.host.selectNotes(this.branches.node(head).notes ?? {})
    if (this.restore.journal()) {
      this.host.pause()
      this.host.notice("An interrupted file restore requires finish or rollback before another prompt")
    }
  }
  assertReady(): void {
    if (workingDirectory(this.state.read().state)?.pending)
      throw new Error("Working-directory publication needs transcript recovery; reconnect before sending")
    if (this.restore.journal() || this.branches.view().switch)
      throw new Error("Finish session recovery before starting another turn")
  }
  capture(
    kind: BranchNode["kind"],
    label: string,
    messages = this.host.history(),
    promptId?: string,
  ): BranchNode | undefined {
    if (!validNativeContext(messages)) {
      this.host.notice("This partial provider exchange has no exact selectable branch boundary")
      return undefined
    }
    const node = this.branches.capture({
      kind,
      cwd: this.policy.cwd,
      label,
      promptId,
      messages,
      eventSequence: this.host.sequence(),
      eventStart: kind === "base" ? 0 : this.host.startSequence(),
      usage: this.host.usage(),
      inheritedUsage: this.branches.view().head ? this.branches.node().inheritedUsage : undefined,
      notes: this.host.notes(),
    })
    if (
      !this.checkpoints.availability() &&
      this.checkpoints.view().steps.some((step) => step.after && !step.context)
    )
      this.checkpoints.bindContext(node.id)
    return node
  }
  async fork(id?: string) {
    this.assertReady()
    await this.host.flush()
    return forkLocalSession(this.branches, id)
  }
  rewindPreview(id: string) {
    const view = this.branches.view(),
      node = this.branches.node(id)
    const cwd = node.cwd ?? workingDirectory(this.state.read().state)?.original ?? this.policy.cwd
    if (hostPath(cwd) !== hostPath(this.policy.cwd))
      throw new Error(
        "This boundary belongs to a different working directory; change to that directory before rewinding",
      )
    this.branches.context(node.id)
    return {
      node,
      revision: view.revision,
      selected: view.head,
      files: "unchanged",
      apply: "Review checkpoint restore separately; applying this preview changes conversation context",
    }
  }
  async rewind(id: string, revision: string): Promise<void> {
    this.assertReady()
    this.rewindPreview(id)
    if (this.branches.view().revision !== revision)
      throw new Error("Session changed; review the boundary again")
    this.host.pause()
    const messages = this.branches.context(id),
      node = this.branches.prepareSwitch(id, this.branches.view().revision)
    if (this.host.transcript) {
      if (
        this.state.durable &&
        hostPath(dirname(this.host.transcript)) !== hostPath(this.state.directory ?? "")
      )
        throw new Error("Native transcript is outside owned session recovery storage")
      await writeTranscriptSnapshot(this.host.transcript, messages)
    }
    this.branches.finishSwitch()
    this.host.replace(messages)
    this.host.selectNotes(node.notes ?? {})
    this.host.reset()
    this.host.notice(`Selected branch boundary ${node.id}; displaced conversation and files remain available`)
  }
  async execute(
    request: import("../../core/session/recovery-contract.ts").RecoveryRequest,
  ): Promise<import("../../core/session/recovery-contract.ts").RecoveryResult> {
    if (request.action === "acknowledge-fork")
      throw new Error("Only Codex provider forks have uncertain remote receipts")
    if (request.action === "gc-recovery") {
      this.assertReady()
      return {
        title: "Unreferenced recovery assets collected",
        data: {
          contextBytes: this.branches.collect(request.revision),
          ...(await this.checkpoints.collect(request.revision)),
        },
      }
    }
    if (request.action === "hunks")
      return {
        title: "Checkpoint hunk attribution",
        data: await new HunkService(this.checkpoints).preview(request.checkpoint, request.path),
      }
    if (request.action === "accept-hunk" || request.action === "reject-hunk") {
      this.assertReady()
      return {
        title: "Hunk decision",
        data: await new HunkService(this.checkpoints).decide(
          request.checkpoint,
          request.path,
          request.hunk,
          request.action === "accept-hunk" ? "accept" : "reject",
          request.revision ?? "",
          !!request.apply,
        ),
      }
    }
    if (request.action === "tree") return { title: "Session branches", data: this.branches.view() }
    if (request.action === "checkpoints") return { title: "File checkpoints", data: this.checkpoints.view() }
    if (request.action === "checkpoint-diff")
      return {
        title: "Checkpoint changes (before / after)",
        data: await this.checkpoints.diff(request.checkpoint),
      }
    if (request.action === "pin-branch") {
      this.branches.pin(request.node, request.pinned, request.revision)
      return { title: "Branch pin updated", data: this.branches.view() }
    }
    if (request.action === "pin-checkpoint") {
      this.checkpoints.pin(request.checkpoint, request.pinned, request.revision)
      return { title: "Checkpoint pin updated", data: this.checkpoints.view() }
    }
    switch (request.action) {
      case "fork": {
        const fork = await this.fork(request.node)
        return { title: "Independent fork created", data: fork, fork }
      }
      case "rewind": {
        const preview = this.rewindPreview(request.node)
        if (!request.apply) return { title: "Conversation rewind preview", data: preview }
        if (!request.revision) throw new Error("Apply requires the reviewed branch revision")
        await this.rewind(request.node, request.revision)
        return { title: "Selected conversation boundary", data: this.branches.view() }
      }
      case "restore": {
        const preview = this.restore.preview(request.checkpoint, request.paths)
        if (!request.apply) return { title: "File restore preview", data: preview }
        if (request.revision !== preview.revision)
          throw new Error("Apply requires the current reviewed restore revision")
        return { title: "File restore completed", data: await this.restoreFiles(preview) }
      }
      case "recover-restore":
        return {
          title: "File restore recovery",
          data: await this.restore.recover(request.direction),
        }
      case "prune-branches":
        return {
          title: "Abandoned branches pruned",
          data: this.branches.prune(request.nodes, request.revision),
        }
      case "prune-checkpoints":
        return {
          title: "Unreferenced checkpoints pruned",
          data: {
            removed: await this.checkpoints.prune(
              request.checkpoints,
              new Set(this.branches.view().nodes.map((node) => node.id)),
              request.revision,
            ),
          },
        }
    }
  }
  async restoreFiles(preview: RestorePreview) {
    if (this.branches.view().revision !== preview.revision)
      throw new Error("Session changed; refresh the restore preview")
    this.host.pause()
    return this.restore.apply({ ...preview, revision: this.branches.view().revision })
  }
}
