/** Bounded boot measurements; recording is attached only after the CLI enables diagnostics. */
export const startupKinds = [
  "startup.arguments",
  "startup.hardening",
  "startup.installation",
  "startup.configuration",
  "startup.credentials",
  "startup.project",
  "startup.tui-import",
  "startup.renderer",
] as const
export type StartupKind = (typeof startupKinds)[number]
type Span = { kind: StartupKind; durationMs: number; failed: number }
const pending: Span[] = []
let sink: ((span: Span) => void) | undefined
export function attachStartupTiming(record: (span: Span) => void): () => void {
  sink = record
  for (const span of pending.splice(0)) record(span)
  return () => {
    if (sink === record) sink = undefined
  }
}
export function beginStartupPhase(kind: StartupKind): (failed?: boolean) => void {
  const start = performance.now()
  let settled = false
  return (failed = false) => {
    if (settled) return
    settled = true
    const span = { kind, durationMs: performance.now() - start, failed: Number(failed) }
    if (sink) sink(span)
    else if (pending.length < 32) pending.push(span)
  }
}
export async function measureStartup<T>(kind: StartupKind, run: () => T | Promise<T>): Promise<T> {
  const end = beginStartupPhase(kind)
  try {
    const result = await run()
    end()
    return result
  } catch (error) {
    end(true)
    throw error
  }
}
