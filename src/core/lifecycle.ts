/** App-level signal handling, ordered shutdown cleanups, and orphaned-child prevention. */

type Cleanup = () => void | Promise<void>

type KillableChild = {
  kill(signal?: number | NodeJS.Signals): void
}

const cleanups: Cleanup[] = []
const liveChildren = new Set<KillableChild>()
let signalDepth = 0
let shuttingDown = false
let installed = false

/** Registers a shutdown cleanup; cleanups run newest-first. Returns an unregister function. */
export function registerCleanup(cleanup: Cleanup): () => void {
  cleanups.push(cleanup)
  return () => {
    const index = cleanups.lastIndexOf(cleanup)
    if (index !== -1) cleanups.splice(index, 1)
  }
}

/** Tracks a spawned child so a dying parent never leaves it orphaned. */
export function registerChildProcess(child: KillableChild): () => void {
  liveChildren.add(child)
  return () => {
    liveChildren.delete(child)
  }
}

/**
 * Suppresses the signal-exit path while a child owns the terminal (Claude handoff,
 * `codex login`): the foreground child receives the same signal and handles it.
 */
export function deferSignalExit(): () => void {
  signalDepth += 1
  let released = false
  return () => {
    if (released) return
    released = true
    signalDepth -= 1
  }
}

/** Suspends the TUI, hands the terminal back to the shell, and resumes on `fg`. */
export function suspendToShell(renderer: { suspend(): void; resume(): void }): void {
  renderer.suspend()
  process.once("SIGCONT", () => renderer.resume())
  process.kill(process.pid, "SIGTSTP")
}

export function installSignalHandlers(): void {
  if (installed) return
  installed = true

  process.on("SIGINT", () => void handleSignal(130))
  process.on("SIGTERM", () => void handleSignal(143))
  process.on("exit", killLiveChildren)
}

async function handleSignal(exitCode: number): Promise<void> {
  if (signalDepth > 0) return
  if (shuttingDown) {
    // A second signal skips graceful shutdown entirely.
    killLiveChildren()
    process.exit(exitCode)
  }
  shuttingDown = true

  await runCleanups()
  killLiveChildren()
  process.exit(exitCode)
}

export async function runCleanups(): Promise<void> {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()
    try {
      await cleanup?.()
    } catch (error) {
      process.stderr.write(
        `codesplash: cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
  }
}

function killLiveChildren(): void {
  for (const child of liveChildren) {
    try {
      child.kill("SIGKILL")
    } catch {
      // The child may already be gone; nothing to clean up.
    }
  }
  liveChildren.clear()
}

/** Test-only: clears module state so lifecycle tests stay independent. */
export function resetLifecycleForTests(): void {
  cleanups.length = 0
  liveChildren.clear()
  signalDepth = 0
  shuttingDown = false
}
