import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  cleanRecord,
  Diagnostics,
  diagnosticFiles,
  exportDiagnostics,
  replayDiagnostics,
} from "../../src/core/diagnostics.ts"
import { Telemetry } from "../../src/core/telemetry.ts"
import {
  type ProviderClient,
  ProviderHttpError,
  type ProviderRequest,
} from "../../src/engines/codesplash/contracts.ts"
import { observedProvider } from "../../src/engines/codesplash/providers/observed.ts"
import { withRetries } from "../../src/engines/codesplash/providers/retry.ts"

test("diagnostics retain only numeric allowlisted values and replay never reconstitutes content", async () => {
  const root = await mkdtemp(join(tmpdir(), "cs-diagnostics-"))
  try {
    const log = new Diagnostics(root)
    log.record("session.start", { count: 1, secret: "canary-secret", status: "canary-secret" } as never)
    log.event({ kind: "user.message", payload: { text: "canary-secret" } } as never)
    log.event({ kind: "item.updated", payload: { output: "canary-secret" } } as never)
    log.close()
    await log.settled()
    const data = exportDiagnostics(root)
    expect(JSON.stringify(data)).not.toContain("canary")
    expect(replayDiagnostics(data).counts["item.updated"]).toBe(1)
    expect(() => replayDiagnostics({ version: 1, records: [data.records[0], data.records[0]] })).toThrow(
      "sequence",
    )
    expect(() => cleanRecord({ ...data.records[0], kind: "secret" })).toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test("log rotation, retention and symlink denial cannot break session operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "cs-diagnostics-"))
  try {
    const log = new Diagnostics(root),
      target = join(root, "target")
    await writeFile(target, "untouched")
    await symlink(target, join(root, `${log.trace}-0.jsonl`))
    expect(() => log.record("app.start")).not.toThrow()
    expect(await readFile(target, "utf8")).toBe("untouched")
    const safe = new Diagnostics(join(root, "safe"))
    for (let i = 0; i < 55000; i++) safe.record("provider.delta", { gapMs: i, count: i })
    expect(diagnosticFiles(join(root, "safe")).length).toBeLessThanOrEqual(4)
    const exported = exportDiagnostics(join(root, "safe"))
    expect(exported.records.length).toBeLessThanOrEqual(20000)
    expect(replayDiagnostics(exported).records).toBe(exported.records.length)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
test("provider timing captures real retry and interruption with no input content", async () => {
  const records: unknown[] = []
  const log = new Diagnostics(undefined, (r) => records.push(r))
  let attempts = 0
  const provider: ProviderClient = {
    id: "openai",
    models: [],
    async *stream(_request, signal) {
      await withRetries(
        async () => {
          if (++attempts === 1) throw new ProviderHttpError("canary", 429, 0)
        },
        { signal },
      )
      yield { type: "text_delta", text: "canary" }
      yield { type: "done", stopReason: "end_turn" }
    },
  }
  for await (const _event of observedProvider(provider, log).stream(
    {} as ProviderRequest,
    new AbortController().signal,
  )) {
  }
  expect(records.some((r) => (r as { kind: string }).kind === "provider.retry")).toBe(true)
  expect(JSON.stringify(records)).not.toContain("canary")
  expect(records.at(-1)).toMatchObject({ kind: "provider.end", values: { failed: 0, count: 1 } })
})
test("OTLP sinks opt in independently; actual collector receives bounded scrubbed payloads", async () => {
  const received: Array<{ path: string; body: unknown }> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      received.push({ path: new URL(req.url).pathname, body: await req.json() })
      return new Response("{}", { headers: { "content-type": "application/json" } })
    },
  })
  try {
    const env: NodeJS.ProcessEnv = { CODESPLASH_OTLP_ENDPOINT: `http://127.0.0.1:${server.port}` }
    const telemetry = new Telemetry(env),
      log = new Diagnostics(undefined, (r) => telemetry.record(r))
    log.record("provider.end", { durationMs: 10 })
    await telemetry.flush()
    expect(received.length).toBe(0)
    env.CODESPLASH_OTLP_ENABLED = "1"
    env.CODESPLASH_LOGS_DISABLED = "1"
    log.record("provider.end", { durationMs: 20 })
    await telemetry.flush()
    expect(received.map((r) => r.path).sort()).toEqual(["/v1/metrics", "/v1/traces"])
    expect(JSON.stringify(received)).toContain("resourceSpans")
    env.CODESPLASH_OFFLINE = "1"
    log.record("provider.end")
    await telemetry.close()
    expect(received.length).toBe(2)
  } finally {
    await server.stop(true)
  }
})
test("exporter outage and queue bounds do not reject agent work", async () => {
  const telemetry = new Telemetry(
    { CODESPLASH_OTLP_ENABLED: "1", CODESPLASH_OTLP_ENDPOINT: "http://127.0.0.1:1" },
    (async () => {
      throw new Error("canary")
    }) as unknown as typeof fetch,
  )
  const log = new Diagnostics(undefined, (r) => telemetry.record(r))
  for (let i = 0; i < 1000; i++) log.record("provider.delta")
  expect(telemetry.dropped).toBe(488)
  await telemetry.close()
  expect(telemetry.failed).toBe(3)
})

test("real process crash markers recover without retaining exception content", async () => {
  const root = await mkdtemp(join(tmpdir(), "m10-crash-"))
  const module = new URL("../../src/core/diagnostics.ts", import.meta.url).href
  async function run(crash: boolean) {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import {startAppDiagnostics} from ${JSON.stringify(module)};const stop=startAppDiagnostics(${JSON.stringify(root)});${crash ? 'throw new Error("CRASH_CONTENT_CANARY")' : "stop()"}`,
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
        env: {
          ...process.env,
          CODESPLASH_OTLP_ENABLED: "0",
          CODESPLASH_ANALYTICS_ENABLED: "0",
          CODESPLASH_DIAGNOSTICS_DISABLED: "0",
        },
      },
    )
    return child.exited
  }
  try {
    expect(await run(true)).not.toBe(0)
    expect(await run(false)).toBe(0)
    const data = exportDiagnostics(root),
      counts = replayDiagnostics(data).counts
    expect(counts["app.crash"]).toBe(1)
    expect(counts["app.recovered"]).toBe(1)
    expect(JSON.stringify(data)).not.toContain("CRASH_CONTENT_CANARY")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
