import { childTranscript, recordedChildren } from "../core/session/children.ts"
import type { SessionRepository } from "../core/session/repository.ts"

export async function sessionChildrenCommand(
  repository: SessionRepository,
  args: string[],
  output: (text: string) => void,
) {
  const [session, ...rest] = args
  if (!session)
    throw new Error(
      "Use session children SESSION [CHILD_OR_TASK] [--offset N] [--limit N] [--fingerprint HASH]",
    )
  const meta = await repository.resolve(session)
  if (meta.engine !== "codesplash") throw new Error("Child transcripts require a native session")
  let id: string | undefined,
    offset = 0,
    limit = 50,
    fingerprint: string | undefined
  const seen = new Set<string>()
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (["--offset", "--limit", "--fingerprint"].includes(arg)) {
      if (seen.has(arg) || !rest[i + 1]) throw new Error("Missing or duplicate transcript option")
      seen.add(arg)
      const value = rest[++i]!
      if (arg === "--offset") offset = Number(value)
      else if (arg === "--limit") limit = Number(value)
      else fingerprint = value
    } else if (!id && !arg.startsWith("-")) id = arg
    else throw new Error("Unknown child transcript option")
  }
  if (!id && seen.size) throw new Error("Pagination requires a child identity")
  const children = recordedChildren(repository.path(meta), meta.localSessionId)
  if (!id)
    output(
      `${JSON.stringify(
        children.map(({ directory: _, ...child }) => child),
        null,
        2,
      )}\n`,
    )
  else {
    const child = children.find((c) => c.id === id || c.task === id)
    if (!child) throw new Error("Unknown child identity; list session children first")
    output(`${JSON.stringify(childTranscript(child, offset, limit, fingerprint), null, 2)}\n`)
  }
  return 0
}
