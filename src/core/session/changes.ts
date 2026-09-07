import { existsSync, readdirSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { atomic, component, directory, hostPath, json } from "./files.ts"
export type SessionChange = { file: string; project: string; session: string }
/** Durable invalidation precedes canonical writes; the writer lease protects reindex cleanup. */
export function invalidateSession(path: string): void {
  path = hostPath(path)
  const project = component(basename(dirname(path))),
    session = component(basename(path))
  atomic(
    join(dirname(dirname(path)), ".changes", `${crypto.randomUUID()}.json`),
    JSON.stringify({ version: 1, project, session }),
  )
}
export function sessionChanges(root: string): SessionChange[] {
  const path = join(root, ".changes")
  if (!existsSync(path)) return []
  directory(path)
  const files = readdirSync(path)
  if (files.length > 50_000)
    throw new Error("Session change backlog exceeds 50,000 records; rebuild the index")
  return files
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      component(file)
      const value = json<{ version: number; project: string; session: string }>(join(path, file), 4096)
      if (value.version !== 1) throw new Error("Invalid session change record")
      return { file: join(path, file), project: component(value.project), session: component(value.session) }
    })
}
