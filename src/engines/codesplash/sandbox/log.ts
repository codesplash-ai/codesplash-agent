import { mkdir, open, rename, stat } from "node:fs/promises"
import { dirname } from "node:path"

/** Metadata only, serialized writes, capped retention. No-history callers omit the path. */
export class SandboxLog {
  #pending = Promise.resolve()
  constructor(readonly path?: string) {}
  record(kind: string, profileHash: string, outcome?: string): void {
    if (!this.path) return
    const path = this.path
    this.#pending = this.#pending
      .then(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        const size = await stat(path)
          .then((s) => s.size)
          .catch(() => 0)
        if (size > 1024 * 1024) await rename(path, `${path}.1`)
        const file = await open(path, "a", 0o600)
        try {
          await file.writeFile(
            `${JSON.stringify({ version: 1, timestamp: new Date().toISOString(), kind, profileHash, outcome })}\n`,
          )
        } finally {
          await file.close()
        }
      })
      .catch(() => {}) // Telemetry failure never changes an authorization decision.
  }
  flush(): Promise<void> {
    return this.#pending
  }
}
