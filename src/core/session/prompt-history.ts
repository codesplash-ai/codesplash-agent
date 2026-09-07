import type { EngineId } from "../events.ts"
import { control, MemorySessionState } from "./control.ts"
import { type AcceptedPrompt, InputQueue } from "./input-queue.ts"
import { SessionRepository } from "./repository.ts"

export type PromptHistory = { history: AcceptedPrompt[]; historyClearedAt?: string; warnings: string[] }
/** Canonical per-session captures are authority; this bounded projection performs no writes. */
export async function projectPromptHistory(
  root: string,
  project: string,
  engine: EngineId,
): Promise<PromptHistory> {
  const repository = new SessionRepository(root),
    history: AcceptedPrompt[] = [],
    warnings: string[] = []
  let historyClearedAt: string | undefined
  const sessions = (await repository.all())
    .filter((meta) => meta.projectId === project && meta.engine === engine)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 1000)
  for (const meta of sessions) {
    try {
      const record = control(repository.path(meta))
      if (!record.state.values.inputQueue) continue
      const state = new MemorySessionState()
      state.update("", "history/inspect", (value) => {
        value.values.inputQueue = record.state.values.inputQueue
      })
      const snapshot = new InputQueue({ state, cwd: meta.projectPath, recover: false }).snapshot()
      history.push(...snapshot.history)
      if (snapshot.historyClearedAt && (!historyClearedAt || snapshot.historyClearedAt > historyClearedAt))
        historyClearedAt = snapshot.historyClearedAt
    } catch {
      warnings.push(`Prompt history unavailable for session ${meta.localSessionId}`)
    }
  }
  return {
    history: [...new Map(history.map((item) => [item.id, item])).values()]
      .filter((item) => !historyClearedAt || item.created > historyClearedAt)
      .sort((a, b) => b.created.localeCompare(a.created))
      .slice(0, 100),
    historyClearedAt,
    warnings,
  }
}
