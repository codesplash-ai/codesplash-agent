import { resolve } from "node:path"
import { AutomationJournal, type AutomationRecord, limitsOf } from "../core/orchestration/automation.ts"
import { SessionRepository } from "../core/session/repository.ts"
import { SessionStore, sessionsRootDirectory } from "../core/sessions.ts"
import { createAgentSession } from "../sdk/index.ts"
import { UsageError } from "./usage-error.ts"

const usage =
  "codesplash automation inspect SESSION [--store ROOT] | goal OBJECTIVE --tokens N --timeout-ms N --rounds N --apply --trust [--approve] [--model ID] [--store ROOT] | workflow NAME --fingerprint HASH --apply --trust [--approve] [--model ID] [--store ROOT] | resume SESSION RECORD --apply --trust [--approve] [--review-usage] [--store ROOT]"
/** An explicit finite local owner. --approve authorizes requests for this invocation only. */
export async function runAutomationCommand(
  args: string[],
  options: { cwd?: string; output?: (text: string) => void } = {},
) {
  const output = options.output ?? ((text) => process.stdout.write(text)),
    cwd = options.cwd ?? process.cwd()
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    output(`${usage}\n`)
    return 0
  }
  const [action, value, ...rest] = args,
    flags: Record<string, string | boolean> = {}
  let recordId: string | undefined
  if (action === "resume") recordId = rest.shift()
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!
    if (key in flags) throw new UsageError("Duplicate automation option")
    if (["--apply", "--trust", "--approve", "--review-usage"].includes(key)) flags[key] = true
    else if (
      ["--store", "--model", "--fingerprint", "--tokens", "--timeout-ms", "--rounds"].includes(key) &&
      rest[i + 1]
    )
      flags[key] = rest[++i]!
    else throw new UsageError(usage)
  }
  if (!value) throw new UsageError(usage)
  const root = flags["--store"] ? resolve(flags["--store"] as string) : sessionsRootDirectory()
  if (action === "inspect") {
    if (Object.keys(flags).some((k) => k !== "--store")) throw new UsageError(usage)
    const repository = new SessionRepository(root),
      meta = await repository.resolve(value),
      handle = await new SessionStore(root).open(meta.projectId, meta.localSessionId)
    handle.acquire()
    try {
      output(
        `${JSON.stringify({ session: meta.localSessionId, records: new AutomationJournal(handle.state).list() }, null, 2)}\n`,
      )
    } finally {
      handle.release()
    }
    return 0
  }
  if (!["goal", "workflow", "resume"].includes(action!) || !flags["--apply"] || !flags["--trust"])
    throw new UsageError(usage)
  const common = ["--store", "--apply", "--trust", "--approve", "--model"]
  const allowed = [
    ...common,
    ...(action === "goal"
      ? ["--tokens", "--timeout-ms", "--rounds"]
      : action === "workflow"
        ? ["--fingerprint"]
        : ["--review-usage"]),
  ]
  if (Object.keys(flags).some((key) => !allowed.includes(key)) || (action === "resume" && !recordId))
    throw new UsageError(usage)
  if (action === "goal")
    limitsOf({
      tokens: Number(flags["--tokens"]),
      timeoutMs: Number(flags["--timeout-ms"]),
      rounds: Number(flags["--rounds"]),
    })
  const abort = new AbortController(),
    cancel = () => abort.abort(new Error("Automation owner interrupted"))
  process.once("SIGTERM", cancel)
  process.once("SIGINT", cancel)
  const session = await createAgentSession({
    cwd,
    workspaceTrusted: true,
    persistence: { root, ...(action === "resume" ? { resume: value } : {}) },
    model: flags["--model"] as string | undefined,
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
    let record: AutomationRecord
    if (action === "goal") {
      const limits = limitsOf({
        tokens: Number(flags["--tokens"]),
        timeoutMs: Number(flags["--timeout-ms"]),
        rounds: Number(flags["--rounds"]),
      })
      unpack(await session.goals({ action: "create", objective: value, limits }))
      record = unpack(await session.goals({ action: "start" }))
    } else if (action === "workflow")
      record = unpack(
        await session.workflows({
          action: "start",
          name: value,
          fingerprint: String(flags["--fingerprint"] ?? ""),
        }),
      )
    else {
      const goal = unpack(await session.goals({ action: "get" })) as AutomationRecord | null
      record =
        goal?.id === recordId
          ? unpack(await session.goals({ action: "resume", reviewUsage: flags["--review-usage"] === true }))
          : unpack(
              await session.workflows({
                action: "resume",
                id: recordId ?? "",
                reviewUsage: flags["--review-usage"] === true,
              }),
            )
    }
    output(`${JSON.stringify({ session: session.id, record: record.id, task: record.task })}\n`)
    while (!abort.signal.aborted) {
      const [page] = (await session.tasks({
        action: "wait",
        ids: [record.task!],
        all: true,
        timeoutMs: 1000,
      })) as Array<{ task: { status: string } }>
      if (!["queued", "running"].includes(page!.task.status)) break
    }
    const final =
      record.kind === "goal"
        ? unpack(await session.goals({ action: "get" }))
        : (unpack(await session.workflows({ action: "list" })) as AutomationRecord[]).find(
            (r) => r.id === record.id,
          )
    output(`${JSON.stringify(final, null, 2)}\n`)
    return final?.status === "complete" ? 0 : 1
  } finally {
    await session.close()
    process.removeListener("SIGTERM", cancel)
    process.removeListener("SIGINT", cancel)
  }
}
