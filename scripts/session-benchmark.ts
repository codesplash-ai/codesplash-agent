/** Disposable 10,000-session / ~100 MiB canonical corpus; no provider traffic. */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { cpus, tmpdir } from "node:os"
import { join } from "node:path"
import { SessionRepository } from "../src/core/session/repository.ts"

const root = mkdtempSync(join(tmpdir(), "codesplash-session-benchmark-"))
try {
  const text = "Common sapphire investigation evidence. ".repeat(270)
  for (let i = 0; i < 10_000; i++) {
    const id = `session-${i}`,
      path = join(root, "project", id)
    mkdirSync(path, { recursive: true, mode: 0o700 })
    writeFileSync(
      join(path, "meta.json"),
      JSON.stringify({
        schemaVersion: 2,
        engine: "codesplash",
        localSessionId: id,
        projectId: "project",
        projectPath: "/project",
        title: `Investigation ${i}`,
        createdAt: "2026-09-07T00:00:00Z",
        updatedAt: "2026-09-07T00:00:00Z",
        lastStatus: "closed",
        lastSequence: 0,
      }),
      { mode: 0o600 },
    )
    writeFileSync(
      join(path, "events.jsonl"),
      `${JSON.stringify({ schemaVersion: 1, engine: "codesplash", localSessionId: id, sequence: 0, timestamp: "2026-09-07T00:00:00Z", kind: "user.message", payload: { id: "u", text: `${text}${i === 42 ? " ultramarinecanary" : ""}` } })}\n`,
      { mode: 0o600 },
    )
  }
  const repository = new SessionRepository(root),
    start = performance.now()
  await repository.reindex()
  const indexMs = performance.now() - start
  const results: Record<string, number> = {}
  for (const query of [undefined, "sapphire", "ultramarinecanary"]) {
    const samples: number[] = []
    for (let i = 0; i < 21; i++) {
      const start = performance.now(),
        page = await repository.list({ query, limit: 30 })
      assert.equal(page.total, query === "ultramarinecanary" ? 1 : 10_000)
      if (i) samples.push(performance.now() - start)
    }
    results[query ?? "list"] = samples.sort((a, b) => a - b)[18] as number
  }
  process.stdout.write(
    `${JSON.stringify({ sessions: 10_000, textBytes: Buffer.byteLength(text) * 10_000, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, bun: Bun.version, indexMs, p95Ms: results, rssMiB: process.memoryUsage().rss / 1024 / 1024 })}\n`,
  )
  assert.ok(
    Object.values(results).every((ms) => ms < 250),
    "Warm paged queries must stay under 250ms p95",
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
