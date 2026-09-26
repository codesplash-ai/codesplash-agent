import { type Diagnostics, diagnosticContext } from "../../../core/diagnostics.ts"
import type { ProviderClient } from "../contracts.ts"

export function observedProvider(provider: ProviderClient, diagnostics: Diagnostics): ProviderClient {
  return {
    id: provider.id,
    models: provider.models,
    async *stream(request, signal) {
      const start = performance.now()
      let last: number | undefined,
        count = 0,
        failed = false
      diagnostics.record("provider.start")
      const iterator = provider.stream(request, signal)[Symbol.asyncIterator]()
      try {
        for (;;) {
          const next = await diagnosticContext.run(diagnostics, () => iterator.next())
          if (next.done) break
          const now = performance.now()
          if (last === undefined) diagnostics.record("provider.first", { durationMs: now - start })
          if (next.value.type === "text_delta" || next.value.type === "reasoning_delta") {
            diagnostics.record("provider.delta", { gapMs: last === undefined ? 0 : now - last })
            count++
          }
          last = now
          yield next.value
        }
      } catch (error) {
        failed = true
        throw error
      } finally {
        try {
          await iterator.return?.()
        } finally {
          diagnostics.record("provider.end", {
            durationMs: performance.now() - start,
            count,
            failed: +failed,
            interrupted: +signal.aborted,
          })
        }
      }
    },
  }
}
