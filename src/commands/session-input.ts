import { control, MemorySessionState, type SessionStateAccess } from "../core/session/control.ts"
import { type InputIntent, InputQueue } from "../core/session/input-queue.ts"
import { projectPromptHistory } from "../core/session/prompt-history.ts"
import type { SessionRepository } from "../core/session/repository.ts"
import type { SessionMeta } from "../core/sessions.ts"
import { UsageError } from "./usage-error.ts"

export async function sessionInputCommand(
  repository: SessionRepository,
  meta: SessionMeta,
  category: "queue" | "history" | "stash",
  args: string[],
  apply: boolean,
): Promise<unknown> {
  const before = control(repository.path(meta)),
    memory = new MemorySessionState()
  memory.update("", "inspect", (state) => {
    Object.assign(state, before.state)
  })
  // Sanitize durable CLI additions even though the preview itself is held in memory.
  const state: SessionStateAccess = {
    durable: true,
    read: () => memory.read(),
    update: (...args) => memory.update(...args),
  }
  const history = await projectPromptHistory(repository.root, meta.projectId, meta.engine)
  const queue = new InputQueue({ state, cwd: meta.projectPath, recover: false, ...history })
  const [action = "list", id, ...rest] = args
  if (action === "list" || (category === "history" && action === "search"))
    return category === "queue"
      ? queue.snapshot()
      : category === "stash"
        ? queue.snapshot().stashes
        : { prompts: queue.history([id, ...rest].filter(Boolean).join(" ")), warnings: history.warnings }
  if ((action === "show" || action === "apply") && category === "stash" && id)
    return { draft: queue.stash(id), executing: false }
  const revision = queue.snapshot().revision
  if (category === "queue") {
    if (action === "pause") queue.pause(revision)
    else if (action === "resume") {
      // Recovery requires an explicit review and never promotes uncertain items.
      new InputQueue({ state, cwd: meta.projectPath }).resume()
    } else if (action === "clear") queue.clearCompleted(revision)
    else if (action === "add" && id) {
      const intent = id as InputIntent
      if (!rest.length) throw new UsageError("session queue ID add <follow-up|steering|interject> <text>")
      queue.submit({ text: rest.join(" "), sourceText: rest.join(" ") }, intent)
    } else if (id && action === "edit")
      queue.edit(id, { text: rest.join(" "), sourceText: rest.join(" ") }, revision)
    else if (id && action === "move") queue.move(id, Number(rest[0]), revision)
    else if (id && action === "remove") queue.remove(id, revision)
    else if (id && action === "retry") queue.retry(id, revision, rest[0] === "acknowledge-uncertain")
    else throw new UsageError("Queue actions: list, pause, resume, add, edit, move, remove, retry, clear")
  } else if (category === "history" && action === "clear") queue.clearHistory(revision)
  else if (category === "stash") {
    if (action === "save" && id && rest.length)
      queue.saveStash(id, { text: rest.join(" "), sourceText: rest.join(" ") }, revision)
    else if ((action === "drop" || action === "pop") && id) {
      const draft = queue.stash(id)
      if (action === "pop") queue.recall(draft)
      queue.dropStash(draft.id, revision)
      if (!apply) return { draft, apply: "Use --apply to remove this stash after reviewing the draft" }
      await repository.change(meta, before.revision, "input/stash-pop", (value) => {
        value.values.inputQueue = memory.read().state.values.inputQueue
      })
      return { draft, executing: false }
    } else throw new UsageError("Stash actions: list, show, save, apply, pop, drop")
  } else throw new UsageError("History actions: list, search, clear")
  if (!apply)
    return { preview: queue.snapshot(), apply: "Use --apply to commit these inactive-session changes" }
  await repository.change(meta, before.revision, `input/cli-${category}-${action}`, (value) => {
    value.values.inputQueue = memory.read().state.values.inputQueue
  })
  return { ...queue.snapshot(), revision: control(repository.path(meta)).revision }
}
