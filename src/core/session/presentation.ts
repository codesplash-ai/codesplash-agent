import { join } from "node:path"
import type { SessionUsageSnapshot } from "../engine.ts"
import type { AgentEvent, EngineId } from "../events.ts"
import type { SessionMeta } from "../sessions.ts"
import { BranchStore } from "./branches.ts"
import type { SessionStateAccess } from "./control.ts"
import { digest, json } from "./files.ts"
import { outcomeCacheStatus } from "./outcome-log.ts"
import { observedUsage } from "./outcomes.ts"
import { safeSessionText } from "./repository.ts"
import { directoryScope, workingDirectory } from "./working-directory.ts"

export type PresentationRequest = {
  action: "info" | "recap" | "outcomes" | "rename"
  title?: string
  auto?: boolean
  generate?: boolean
  since?: number
}
export function presentationArguments(
  action: PresentationRequest["action"],
  args: string[],
): PresentationRequest {
  const request: PresentationRequest = { action },
    text: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string
    if (arg === "--auto") request.auto = true
    else if (arg === "--generate") request.generate = true
    else if (arg === "--since") {
      request.since = Number(args[++index])
      if (!Number.isSafeInteger(request.since) || request.since < -1)
        throw new Error("--since requires an event sequence")
    } else if (arg === "--json") continue
    else if (arg.startsWith("--")) throw new Error(`Unknown presentation option ${arg}`)
    else text.push(arg)
  }
  if (text.length) request.title = text.join(" ")
  if (action !== "rename" && (request.title || request.auto))
    throw new Error("Only rename accepts a title or --auto")
  if (request.generate && !["rename", "recap"].includes(action))
    throw new Error("Only rename and recap support --generate")
  if (
    action === "rename" &&
    (Number(!!request.title) + Number(!!request.auto) + Number(!!request.generate) !== 1 ||
      request.since !== undefined)
  )
    throw new Error("rename requires TEXT, --auto, or --generate")
  if (request.generate && request.since !== undefined)
    throw new Error("Generated recaps use the selected conversation; --since applies to local outcomes")
  if (action === "info" && request.since !== undefined) throw new Error("info does not accept --since")
  return request
}
export function automaticTitle(events: readonly AgentEvent[]): string {
  const event = [...events].reverse().find((e) => e.kind === "user.message" && e.payload.text.trim())
  return titleText(event?.kind === "user.message" ? event.payload.text : "Untitled session")
}
export function titleText(text: string): string {
  const title = safeSessionText(text).replace(/\s+/g, " ").trim().slice(0, 200)
  if (!title) throw new Error("A nonempty title is required")
  return title
}
/** Dedicated title/selected-context token: auxiliary usage/cache commits do not stale their own job. */
export function titleToken(state: SessionStateAccess, runtime = ""): string {
  const value = state.read().state,
    graph = new BranchStore(state).view()
  return digest(
    JSON.stringify([
      value.title,
      value.manualTitle,
      value.values.titleRevision,
      graph.head,
      graph.epoch,
      workingDirectory(value),
      runtime,
    ]),
  )
}
export function renameSession(
  state: SessionStateAccess,
  title: string,
  manual = true,
  expected?: string,
  runtime = "",
): string {
  state.assertOwned?.()
  if (expected !== undefined && titleToken(state, runtime) !== expected)
    throw new Error("Session title or context changed; generated title discarded")
  const value = titleText(title)
  state.update(state.read().revision, "session/rename", (record) => {
    record.title = value
    record.manualTitle = manual
    record.values.titleRevision = crypto.randomUUID()
  })
  return value
}
export function sessionInfo(options: {
  state: SessionStateAccess
  id: string
  engine: EngineId
  cwd: string
  nativeId?: string
  storageProject?: string
  model?: string
  title?: string
  usage?: SessionUsageSnapshot
  status?: string
  sequence?: number
  policy: {
    source: "live" | "recorded"
    sandbox?: string
    approval?: string
    permission?: string
    trusted?: boolean
    profile?: string
  }
  checkpointAvailability?: string
}) {
  const meta = options.state.directory
    ? json<SessionMeta>(join(options.state.directory, "meta.json"))
    : undefined
  const { state } = options,
    record = state.read(),
    graph = new BranchStore(state).view(),
    location = workingDirectory(record.state)
  const queue = record.state.values.inputQueue as
    | { items?: Array<{ status: string }>; paused?: boolean }
    | undefined
  const scope = directoryScope(record.state),
    checkpoints = record.state.values[scope ? `checkpoints:${scope}` : "checkpoints"] as
      | { steps?: unknown[]; restore?: unknown }
      | undefined
  const imported = record.state.values.imported as
    | {
        vendor?: string
        sourceSessionId?: string
        source?: { engine?: string; sessionId?: string }
        sha256?: string
      }
    | undefined
  const selected = graph.nodes.find((node) => node.id === graph.head)
  const clean = (value?: string) => (value === undefined ? undefined : safeSessionText(value).slice(0, 4096))
  return {
    id: clean(options.id),
    nativeId: clean(options.nativeId ?? meta?.nativeSessionId),
    engine: options.engine,
    title: clean(record.state.title ?? options.title ?? meta?.title ?? "Untitled session"),
    manualTitle: record.state.manualTitle ?? false,
    cwd: clean(location?.current ?? options.cwd),
    storageProject: clean(options.storageProject ?? meta?.projectId),
    effectiveProject: location?.projectId ?? meta?.effectiveProjectId ?? meta?.projectId,
    model: clean(options.model),
    persistence: state.durable ? "recorded" : "memory only",
    status: clean(options.status),
    policy: Object.fromEntries(
      Object.entries(options.policy).map(([key, value]) => [
        key,
        typeof value === "string" ? clean(value) : value,
      ]),
    ),
    branch: { head: graph.head, epoch: graph.epoch, boundaries: graph.nodes.length },
    recovery: {
      directoryPending: location?.pending ?? false,
      branchPending: !!(graph.switch || graph.providerFork),
      restorePending: !!checkpoints?.restore,
    },
    queue: {
      paused: queue?.paused ?? false,
      counts: (queue?.items ?? []).reduce<Record<string, number>>((counts, item) => {
        const key = [
          "queued",
          "admitted",
          "running",
          "completed",
          "cancelled",
          "failed",
          "blocked",
          "execution-uncertain",
        ].includes(item.status)
          ? item.status
          : "unknown"
        counts[key] = (counts[key] ?? 0) + 1
        return counts
      }, {}),
    },
    checkpoints: {
      count: checkpoints?.steps?.length ?? 0,
      availability:
        clean(options.checkpointAvailability) ??
        (state.durable ? "Inspect checkpoints for coverage" : "Requires recorded history"),
    },
    usage: {
      cumulative: observedUsage(options.usage ?? {}),
      inherited: observedUsage(selected?.inheritedUsage ?? graph.origin?.inheritedUsage ?? {}),
    },
    provenance: {
      fork: graph.origin
        ? { sessionId: clean(graph.origin.sessionId), nodeId: graph.origin.nodeId }
        : undefined,
      imported: imported
        ? {
            vendor: clean(imported.source?.engine ?? imported.vendor),
            sourceSessionId: clean(imported.source?.sessionId ?? imported.sourceSessionId),
            checksum: /^[a-f0-9]{64}$/.test(imported.sha256 ?? "") ? imported.sha256 : undefined,
          }
        : undefined,
    },
    outcomeCache: outcomeCacheStatus(state, options.sequence),
  }
}
export function awayRecap(
  previous: number,
  now: number,
  pendingApproval: boolean,
  before: number,
  current: number,
): boolean {
  return !pendingApproval && now - previous >= 5 * 60 * 1000 && current > before
}
