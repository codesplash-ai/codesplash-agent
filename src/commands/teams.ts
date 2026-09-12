import { resolve } from "node:path"
import { queryPeerEndpoint } from "../core/orchestration/peer-socket.ts"
import { type TeamDashboard, type TeamRecord, TeamStore, teamSpec } from "../core/orchestration/teams.ts"
import { bytes } from "../core/session/files.ts"
import { SessionRepository, safeSessionText } from "../core/session/repository.ts"
import { SessionStore, sessionsRootDirectory } from "../core/sessions.ts"
import { createAgentSession } from "../sdk/index.ts"
import { UsageError } from "./usage-error.ts"

const usage =
  "codesplash teams run SPEC.json --apply --trust [--approve] [--panes] [--duration-ms N] [--model ID] [--store ROOT] | inspect SESSION [--store ROOT] | view ENDPOINT TEAM"
const unpack = (raw: unknown) => {
  const v = raw as { text: string; isError?: boolean }
  if (v.isError) throw new Error(v.text)
  return JSON.parse(v.text)
}
export async function runTeamsCommand(args: string[]) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    process.stdout.write(`${usage}\n`)
    return 0
  }
  const [action, value, ...rest] = args
  if (action === "view") {
    if (!value || rest.length !== 1) throw new UsageError(usage)
    const end = Date.now() + 3600000
    while (Date.now() < end) {
      const view = await queryPeerEndpoint(value, rest[0]!)
      const text = safeSessionText(JSON.stringify(view, null, 2))
      await new Promise<void>((accept, reject) => {
        const timer = setTimeout(() => {
          process.stdout.destroy()
          reject(new Error("Pane output stalled"))
        }, 5000)
        process.stdout.write(
          `${process.stdout.isTTY ? "\x1b[2J\x1b[H" : ""}Team live view — inclusive member usage\n${text}\n`,
          (e) => {
            clearTimeout(timer)
            e ? reject(e) : accept()
          },
        )
      })
      await Bun.sleep(500)
    }
    return 0
  }
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!
    if (key in flags) throw new UsageError("Duplicate team option")
    if (["--apply", "--trust", "--approve", "--panes"].includes(key)) flags[key] = true
    else if (["--duration-ms", "--model", "--store"].includes(key) && rest[i + 1]) flags[key] = rest[++i]!
    else throw new UsageError(usage)
  }
  const root = flags["--store"] ? resolve(String(flags["--store"])) : sessionsRootDirectory()
  if (!value) throw new UsageError(usage)
  if (action === "inspect") {
    if (Object.keys(flags).some((k) => k !== "--store")) throw new UsageError(usage)
    const meta = await new SessionRepository(root).resolve(value),
      handle = await new SessionStore(root).open(meta.projectId, meta.localSessionId)
    handle.acquire()
    try {
      process.stdout.write(`${JSON.stringify(new TeamStore(handle.state).read(), null, 2)}\n`)
    } finally {
      handle.release()
    }
    return 0
  }
  if (action !== "run" || !flags["--apply"] || !flags["--trust"]) throw new UsageError(usage)
  const spec = teamSpec(JSON.parse(bytes(resolve(value), 65536).toString())),
    duration = Number(flags["--duration-ms"] ?? 120000)
  if (!Number.isSafeInteger(duration) || duration < 1000 || duration > 3600000)
    throw new UsageError("Team owner duration must be 1000–3600000 ms")
  const abort = new AbortController(),
    stop = () => abort.abort()
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
  const expires = setTimeout(stop, duration)
  let session: Awaited<ReturnType<typeof createAgentSession>> | undefined
  try {
    session = await createAgentSession({
      cwd: process.cwd(),
      workspaceTrusted: true,
      persistence: { root },
      model: flags["--model"] as string | undefined,
      signal: abort.signal,
      respond: async () => ({ choice: flags["--approve"] ? "accept" : "decline" }),
    })
    const team = unpack(await session.teams({ action: "create", spec })) as TeamRecord
    process.stdout.write(`${JSON.stringify({ session: session.id, team: team.id })}\n`)
    if (flags["--panes"])
      process.stdout.write(
        `${JSON.stringify(unpack(await session.teams({ action: "panes", team: team.id })))}\n`,
      )
    for (const member of team.members)
      unpack(await session.teams({ action: "dispatch", team: team.id, member: member.name }))
    let view: TeamDashboard
    do {
      view = unpack(await session.teams({ action: "list" }))
      if (!view.teams[0]?.members.some((m) => ["running", "queued"].includes(m.task?.status ?? ""))) break
      await Bun.sleep(100)
    } while (!abort.signal.aborted)
    process.stdout.write(`${JSON.stringify(view, null, 2)}\n`)
    return abort.signal.aborted ||
      view.teams.some((t) => t.members.some((m) => m.task?.status !== "completed"))
      ? 1
      : 0
  } finally {
    clearTimeout(expires)
    process.off("SIGTERM", stop)
    process.off("SIGINT", stop)
    await session?.close()
  }
}
