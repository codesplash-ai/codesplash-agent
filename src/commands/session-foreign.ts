import { resolve } from "node:path"
import {
  convertForeign,
  discoverForeign,
  type ForeignVendor,
  ownerResumeCommand,
  readForeignSession,
} from "../core/session/foreign.ts"
import { importPortable } from "../core/session/portable.ts"
import type { SessionRepository } from "../core/session/repository.ts"
import { runTerminalHandoff } from "../engines/claude/terminal-handoff.ts"

export async function sessionForeignCommand(
  repository: SessionRepository,
  args: string[],
  output: (text: string) => void,
  allowHandoff = true,
): Promise<number> {
  const [action, vendor, root, ...rest] = args
  if (
    !root ||
    !["codex", "claude", "cursor"].includes(vendor ?? "") ||
    !["list", "show", "convert", "resume"].includes(action ?? "")
  )
    throw new Error(
      "Use session foreign <list|show|convert|resume> <codex|claude|cursor> ROOT [FILE] [--path DESTINATION] [--apply]",
    )
  const positional: string[] = []
  let cwd = process.cwd(),
    apply = false,
    sha: string | undefined
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--path" && rest[i + 1]) cwd = resolve(rest[++i] as string)
    else if (rest[i] === "--apply") apply = true
    else if (rest[i] === "--sha256" && rest[i + 1]) sha = rest[++i]
    else if (rest[i] === "--json") continue
    else if (rest[i]?.startsWith("--")) throw new Error(`Unknown foreign-session option ${rest[i]}`)
    else positional.push(rest[i] as string)
  }
  const emit = (value: unknown) => output(`${JSON.stringify(value, null, 2)}\n`)
  if (action === "list") {
    if (positional.length) throw new Error("Foreign list takes a root only")
    const result = await discoverForeign(resolve(root), vendor as ForeignVendor)
    emit({ ...result, sessions: result.sessions.map(({ messages: _messages, ...session }) => session) })
    return 0
  }
  if (positional.length !== 1) throw new Error("Select exactly one source FILE beneath ROOT")
  const session = readForeignSession(resolve(root), positional[0] as string, vendor as ForeignVendor)
  if (sha && sha !== session.sha256) throw new Error("Foreign source changed since preview")
  if (action === "show") emit(session)
  else if (action === "convert")
    emit(await importPortable(repository.root, convertForeign(session), cwd, apply))
  else {
    const launch = ownerResumeCommand(session)
    emit({
      ...launch,
      source: session.path,
      apply: "Use --apply to hand off to the owning CLI; its own configuration and permissions will apply",
    })
    if (apply) {
      if (!allowHandoff)
        throw new Error("Resume through the session foreign CLI command after leaving the live session")
      return (await runTerminalHandoff(launch)).exitCode
    }
  }
  return 0
}
