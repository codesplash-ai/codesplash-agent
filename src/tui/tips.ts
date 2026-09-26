import { join } from "node:path"
import type { AppViewState } from "../core/index.ts"
import { atomic, bytes } from "../core/session/files.ts"

export function contextualTip(state: AppViewState): string {
  if (state.pendingRequest)
    return "Tip: Tab moves between the approval and your draft; typing never approves a request."
  if (state.turnStatus === "running") return "Tip: Enter queues a follow-up; /tasks shows background work."
  if (state.transcript.length > 20)
    return "Tip: /search finds transcript text; /screen inline keeps terminal scrollback."
  return "Tip: Ctrl+P finds commands, Ctrl+G edits your draft, and /config customizes the terminal."
}
export const onboardingText = `Welcome to CodeSplash

Choose the engine for your work:
• CodeSplash runs the native agent with your API keys, local permissions and sandbox.
• Codex uses your installed official CLI and its authentication.
• Claude hands your terminal to the official Claude CLI.

Enter sends a prompt. During a turn it queues a follow-up. Escape interrupts.
Approvals are explicit; use Tab to write a draft while an approval is open.

Ctrl+P: find a command     Ctrl+G: external editor
/config: appearance, input and attention preferences with source provenance
/integrations: MCP, plugins, hooks, skills and extensions
/docs: local documentation     /help: commands and shortcuts

A finishes this first-run guide. Esc closes it for this session.
No model request or credential exchange is made by this guide.`

/** User-local visit count only; callers skip persistence under no-history. */
export function recordTipVisit(directory: string): boolean {
  const path = join(directory, "tip-visits.json")
  let visits = 0
  try {
    const value = JSON.parse(bytes(path, 1024).toString())
    if (Number.isSafeInteger(value.visits) && value.visits >= 0) visits = value.visits
  } catch {}
  try {
    atomic(path, JSON.stringify({ version: 1, visits: (visits + 1) % 1_000_000 }))
  } catch {
    return true
  }
  return visits % 3 === 0
}
