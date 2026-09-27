import { resolve } from "node:path"
import { configDirectory, configFilePath, dataDirectory, loadConfig } from "../core/config.ts"
import { object } from "../core/orchestration/automation.ts"
import { type ScheduleSpec, ScheduleStore, scheduleSpec } from "../core/orchestration/scheduler.ts"
import { bytes, digest } from "../core/session/files.ts"
import { sessionsRootDirectory } from "../core/sessions.ts"
import { readTrustDecision } from "../core/trust.ts"
import { createPermissionRuntime } from "../engines/codesplash/permissions.ts"
import { createAgentSession } from "../sdk/index.ts"
import { UsageError } from "./usage-error.ts"

const usage =
  "codesplash scheduler service install|start|stop|status|uninstall | list | create SPEC.json [--write] | import native|grok|claude SOURCE --budgets BUDGETS.json [--write] | enable ID --fingerprint HASH --apply --trust [--model ID] [--approve] | delete ID --apply | review OCCURRENCE --apply | worker --duration-ms N --apply --trust [--approve] [--model ID] | run ID --apply --trust [--approve] [--model ID]"
export function importSchedules(
  vendor: string,
  raw: unknown,
  budgets: unknown,
): { specs: ScheduleSpec[]; unsupported: string[] } {
  const b = object(budgets, ["limits", "maxOccurrences", "totalTokens", "expiresAfterMs"])
  const specs: ScheduleSpec[] = [],
    unsupported: string[] = []
  const entries =
    vendor === "native" ? (Array.isArray(raw) ? raw : [raw]) : (raw as { tasks?: unknown[] })?.tasks
  if (!Array.isArray(entries) || entries.length > 32)
    throw new Error("Schedule import requires at most 32 entries")
  for (let i = 0; i < entries.length; i++) {
    try {
      if (vendor === "native") {
        specs.push(scheduleSpec({ ...scheduleSpec(entries[i]), ...b }))
        continue
      }
      const v = object(
        entries[i],
        vendor === "grok"
          ? [
              "id",
              "interval_secs",
              "prompt",
              "recurring",
              "durable",
              "foreground",
              "created_at",
              "last_fired_at",
              "expires_at",
              "last_subagent_id",
              "iterations_since_fresh",
              "chain_reset_pending",
            ]
          : vendor === "claude"
            ? ["id", "cron", "prompt", "createdAt", "lastFiredAt", "recurring", "permanent"]
            : [],
      )
      if (
        v.recurring !== true ||
        v.foreground === true ||
        v.permanent === true ||
        typeof v.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,48}$/.test(v.id)
      )
        throw new Error(
          "Only bounded recurring prompt semantics map; unsupported owner/permanent/id settings",
        )
      if (vendor === "grok" && (!Number.isSafeInteger(v.interval_secs) || (v.interval_secs as number) < 60))
        throw new Error("Invalid Grok interval")
      specs.push(
        scheduleSpec({
          name: `${vendor}-${v.id}`,
          prompt: v.prompt,
          ...b,
          ...(vendor === "grok" ? { interval: `${v.interval_secs}s` } : { cron: v.cron }),
        }),
      )
    } catch (error) {
      unsupported.push(`Entry ${i + 1}: ${error instanceof Error ? error.message : "Unsupported schedule"}`)
    }
  }
  return { specs, unsupported }
}
export async function runSchedulerCommand(
  args: string[],
  options: { cwd?: string; dataRoot?: string; configPath?: string; output?: (text: string) => void } = {},
) {
  if (args[0] === "service")
    return (await import("./scheduler-service.ts")).runSchedulerService(args.slice(1), options)
  const cwd = options.cwd ?? process.cwd(),
    output = options.output ?? ((text) => process.stdout.write(text)),
    root = options.dataRoot ?? dataDirectory()
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    output(`${usage}\n`)
    return 0
  }
  const [action, ...rest] = args,
    store = new ScheduleStore(cwd, root)
  if (action === "list" && !rest.length) {
    output(`${JSON.stringify(store.read(), null, 2)}\n`)
    return 0
  }
  if (action === "create" || action === "import" || action === "delete" || action === "review") {
    const config = await loadConfig(options.configPath ?? configFilePath(configDirectory()), [], {
      cwd,
      workspaceTrusted: (await readTrustDecision(cwd, root))?.trusted === true,
      dataDir: root,
    })
    if (!config.history.enabled) throw new Error("Persistent scheduling disabled by history policy")
    const permissions = await createPermissionRuntime({
      cwd,
      workspaceTrusted: false,
      mode: config.permissions.mode,
      configRules: config.permissions,
      constraints: config.resolution?.constraints,
    })
    if (
      [
        "scheduler",
        action === "delete" || action === "review" ? "scheduler_delete" : "scheduler_create",
      ].some((name) => permissions.decide(name, undefined, false).kind === "deny")
    )
      throw new Error("Scheduling denied by policy")
    if (action === "delete" || action === "review") {
      if (rest.length !== 2 || rest[1] !== "--apply") throw new UsageError(usage)
      if (action === "delete") store.remove(rest[0]!)
      else store.review(rest[0]!)
      output(`${JSON.stringify(store.read(), null, 2)}\n`)
      return 0
    }
    let specs: ScheduleSpec[],
      unsupported: string[] = [],
      source: string
    const write = rest.at(-1) === "--write"
    if (write) rest.pop()
    if (action === "create") {
      if (rest.length !== 1) throw new UsageError(usage)
      source = bytes(resolve(rest[0]!), 65536).toString()
      specs = [scheduleSpec(JSON.parse(source))]
    } else {
      if (rest.length !== 4 || rest[2] !== "--budgets" || !["native", "grok", "claude"].includes(rest[0]!))
        throw new UsageError(usage)
      source = bytes(resolve(rest[1]!), 262144).toString()
      const translated = importSchedules(
        rest[0]!,
        JSON.parse(source),
        JSON.parse(bytes(resolve(rest[3]!), 4096).toString()),
      )
      specs = translated.specs
      unsupported = translated.unsupported
    }
    if (write && unsupported.length)
      throw new Error(`Resolve unsupported entries before import: ${unsupported.join("; ")}`)
    const created = write ? store.createMany(specs, "disabled CLI import", false) : undefined
    output(
      `${JSON.stringify({ sourceFingerprint: digest(source), inactive: true, specs, unsupported, created }, null, 2)}\n`,
    )
    return 0
  }
  if (!["enable", "worker", "run"].includes(action!)) throw new UsageError(usage)
  const id = action === "worker" ? undefined : rest.shift(),
    flags: Record<string, string | boolean> = {}
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!
    if (key in flags) throw new UsageError("Duplicate scheduler option")
    if (["--apply", "--trust", "--approve"].includes(key)) flags[key] = true
    else if (["--duration-ms", "--fingerprint", "--model", "--store"].includes(key) && rest[i + 1])
      flags[key] = rest[++i]!
    else throw new UsageError(usage)
  }
  if (!flags["--apply"] || !flags["--trust"] || (action !== "worker" && !id)) throw new UsageError(usage)
  const common = ["--apply", "--trust", "--approve", "--model", "--store"]
  const allowed = [
    ...common,
    ...(action === "worker" ? ["--duration-ms"] : action === "enable" ? ["--fingerprint"] : []),
  ]
  if (Object.keys(flags).some((key) => !allowed.includes(key))) throw new UsageError(usage)
  if (
    action === "worker" &&
    (!Number.isSafeInteger(Number(flags["--duration-ms"])) ||
      Number(flags["--duration-ms"]) < 1000 ||
      Number(flags["--duration-ms"]) > 3600000)
  )
    throw new UsageError("Worker duration must be 1 second–1 hour")
  const priorOccurrences = new Set(store.read().occurrences.map((o) => o.id))
  const abort = new AbortController(),
    cancel = () => abort.abort(new Error("Scheduler owner interrupted"))
  process.once("SIGTERM", cancel)
  process.once("SIGINT", cancel)
  const session = await createAgentSession({
    cwd,
    workspaceTrusted: true,
    trustDataDirectory: root,
    config: options.configPath ? { path: options.configPath } : undefined,
    model: flags["--model"] as string | undefined,
    persistence: { root: flags["--store"] ? resolve(String(flags["--store"])) : sessionsRootDirectory() },
    signal: abort.signal,
    respond: async () => ({ choice: flags["--approve"] ? "accept" : "decline" }),
  }).catch((error) => {
    process.removeListener("SIGTERM", cancel)
    process.removeListener("SIGINT", cancel)
    throw error
  })
  const unpack = (raw: unknown) => {
    const r = raw as { text: string; isError?: boolean }
    if (r.isError) throw new Error(r.text)
    return JSON.parse(r.text)
  }
  try {
    if (action === "enable")
      output(
        `${JSON.stringify(unpack(await session.schedules({ action: "enable", id: id!, fingerprint: String(flags["--fingerprint"] ?? "") })), null, 2)}\n`,
      )
    else {
      output(
        `${JSON.stringify(unpack(await session.schedules(action === "run" ? { action: "run", id: id! } : { action: "start", durationMs: Number(flags["--duration-ms"]) })))}\n`,
      )
      while (!abort.signal.aborted) {
        const state = unpack(await session.schedules({ action: "list" })) as { worker: boolean }
        if (!state.worker) break
        await new Promise((r) => setTimeout(r, 250))
      }
      if (!abort.signal.aborted) {
        const final = unpack(await session.schedules({ action: "list" })) as {
          error?: string
          occurrences: Array<{ id: string; status: string }>
        }
        output(`${JSON.stringify(final, null, 2)}\n`)
        if (
          final.error ||
          final.occurrences.some((o) => !priorOccurrences.has(o.id) && o.status !== "completed")
        )
          return 1
      }
    }
    return 0
  } finally {
    await session.close()
    process.removeListener("SIGTERM", cancel)
    process.removeListener("SIGINT", cancel)
  }
}
