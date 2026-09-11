import type { SessionUsageSnapshot } from "../engine.ts"
import type { AppViewState } from "../reducer.ts"

/** Cumulative usage from replayed state, or undefined when the session recorded none. */
export function usageSnapshotOf(state: AppViewState): SessionUsageSnapshot | undefined {
  const { inputTokens, cachedInputTokens, outputTokens, estimatedCostUsd, hasUnpricedUsage } = state.usage
  const snapshot: SessionUsageSnapshot = {}
  if (inputTokens !== undefined) snapshot.inputTokens = inputTokens
  if (cachedInputTokens !== undefined) snapshot.cachedInputTokens = cachedInputTokens
  if (outputTokens !== undefined) snapshot.outputTokens = outputTokens
  if (estimatedCostUsd !== undefined) snapshot.estimatedCostUsd = estimatedCostUsd
  if (state.usage.embeddingInputTokens !== undefined)
    snapshot.embeddingInputTokens = state.usage.embeddingInputTokens
  if (hasUnpricedUsage !== undefined) snapshot.hasUnpricedUsage = hasUnpricedUsage
  return Object.keys(snapshot).length > 0 ? snapshot : undefined
}

/** Replayed state describes a past run; pending requests and turn state do not carry over. */
export function clearTransientState(state: AppViewState): AppViewState {
  return {
    ...state,
    extensionUi: [],
    sessionStatus: "starting",
    turnStatus: "idle",
    pendingRequest: undefined,
    error: undefined,
  }
}
