/** OTLP/HTTP JSON over the content-free diagnostic contract. No telemetry destination by default. */
import type { DiagnosticRecord } from "./diagnostics.ts"

type Signal = "traces" | "metrics" | "logs" | "analytics"
const signals: Signal[] = ["traces", "metrics", "logs", "analytics"]
const resource = { attributes: [{ key: "service.name", value: { stringValue: "codesplash-agent" } }] }
const scope = { name: "codesplash.diagnostics", version: "1" }
const nano = (ms: number) => (BigInt(Math.trunc(ms * 1000)) * 1000n).toString()
const attributes = (r: DiagnosticRecord) =>
  Object.entries(r.values).map(([key, value]) => ({
    key: `codesplash.${key}`,
    value: { doubleValue: value },
  }))

export function otlpBody(signal: Signal, records: DiagnosticRecord[]): unknown {
  if (signal === "analytics")
    return {
      version: 1,
      counts: Object.fromEntries(
        [...new Set(records.map((r) => r.kind))].map((kind) => [
          kind,
          records.filter((r) => r.kind === kind).length,
        ]),
      ),
    }
  if (signal === "logs")
    return {
      resourceLogs: [
        {
          resource,
          scopeLogs: [
            {
              scope,
              logRecords: records.map((r) => ({
                timeUnixNano: nano(r.time),
                observedTimeUnixNano: nano(r.time),
                severityNumber: r.kind === "error" || r.kind === "app.crash" ? 17 : 9,
                body: { stringValue: r.kind },
                traceId: r.trace,
                attributes: attributes(r),
              })),
            },
          ],
        },
      ],
    }
  if (signal === "metrics")
    return {
      resourceMetrics: [
        {
          resource,
          scopeMetrics: [
            {
              scope,
              metrics: [...new Set(records.map((r) => r.kind))].map((kind) => ({
                name: `codesplash.${kind}.count`,
                unit: "{event}",
                sum: {
                  aggregationTemporality: 1,
                  isMonotonic: true,
                  dataPoints: [
                    {
                      startTimeUnixNano: nano(records[0]!.time),
                      timeUnixNano: nano(records.at(-1)!.time),
                      asInt: String(records.filter((r) => r.kind === kind).length),
                    },
                  ],
                },
              })),
            },
          ],
        },
      ],
    }
  return {
    resourceSpans: [
      {
        resource,
        scopeSpans: [
          {
            scope,
            spans: records
              .filter((r) => r.kind.endsWith(".end") || r.kind === "turn.completed")
              .map((r) => ({
                traceId: r.trace,
                spanId: r.sequence.toString(16).padStart(16, "0"),
                name: r.kind,
                kind: 1,
                startTimeUnixNano: nano(Math.max(0, r.time - (r.values.durationMs ?? 0))),
                endTimeUnixNano: nano(r.time),
                attributes: attributes(r),
                status: { code: r.values.failed ? 2 : 1 },
              })),
          },
        ],
      },
    ],
  }
}

export class Telemetry {
  #queue: DiagnosticRecord[] = []
  #timer?: ReturnType<typeof setTimeout>
  #pending?: Promise<void>
  #closed = false
  dropped = 0
  failed = 0
  constructor(
    readonly env: NodeJS.ProcessEnv = process.env,
    readonly fetcher: typeof fetch = fetch,
  ) {}
  #destination(signal: Signal): URL | undefined {
    if (
      this.env.CODESPLASH_OFFLINE === "1" ||
      this.env.CODESPLASH_TELEMETRY_DISABLED === "1" ||
      this.env[`CODESPLASH_${signal.toUpperCase()}_DISABLED`] === "1"
    )
      return
    if (
      signal === "analytics"
        ? this.env.CODESPLASH_ANALYTICS_ENABLED !== "1"
        : this.env.CODESPLASH_OTLP_ENABLED !== "1"
    )
      return
    if (
      signal !== "analytics" &&
      !(this.env.CODESPLASH_OTLP_SIGNALS ?? "traces,metrics,logs").split(",").includes(signal)
    )
      return
    const raw =
      signal === "analytics" ? this.env.CODESPLASH_ANALYTICS_ENDPOINT : this.env.CODESPLASH_OTLP_ENDPOINT
    if (!raw) return
    try {
      const url = new URL(raw)
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !(
          url.protocol === "https:" ||
          (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        )
      )
        return
      if (signal !== "analytics") url.pathname = url.pathname.replace(/\/$/, "") + `/v1/${signal}`
      return url
    } catch {
      return
    }
  }
  record(record: DiagnosticRecord): void {
    if (this.#closed || !signals.some((signal) => this.#destination(signal))) return
    if (this.#queue.length >= 512) {
      this.dropped++
      return
    }
    this.#queue.push(record)
    if (!this.#timer) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined
        void this.flush()
      }, 1000)
      this.#timer.unref()
    }
  }
  async flush(): Promise<void> {
    if (this.#pending) {
      await this.#pending
      if (this.#queue.length) await this.flush()
      return
    }
    const records = this.#queue.splice(0)
    if (!records.length) return
    this.#pending = Promise.all(
      signals.map(async (signal) => {
        const url = this.#destination(signal)
        if (!url) return
        try {
          const response = await this.fetcher(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(this.env.CODESPLASH_OTLP_TOKEN && signal !== "analytics"
                ? { authorization: `Bearer ${this.env.CODESPLASH_OTLP_TOKEN}` }
                : {}),
            },
            body: JSON.stringify(otlpBody(signal, records)),
            redirect: "error",
            signal: AbortSignal.timeout(2000),
          })
          await response.body?.cancel()
          if (!response.ok) this.failed++
        } catch {
          this.failed++
        }
      }),
    ).then(() => {})
    try {
      await this.#pending
    } finally {
      this.#pending = undefined
    }
  }
  async close(): Promise<void> {
    this.#closed = true
    clearTimeout(this.#timer)
    await this.flush()
  }
}
