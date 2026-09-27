import { isAbsolute, resolve } from "node:path"
import type { UserInput } from "./engine.ts"
import { SessionRepository } from "./session/repository.ts"
import { projectIdFor } from "./sessions.ts"

export type LaunchSelection = { resume?: string; search?: string; continue?: boolean }
export async function selectLaunchSession(
  cwd: string,
  selection: LaunchSelection,
  repository = new SessionRepository(),
) {
  const project = projectIdFor(cwd)
  if (selection.resume) {
    const meta = await repository.resolve(selection.resume, project)
    if (meta.engine !== "codesplash" || meta.archived)
      throw new Error("Launch resume requires an active CodeSplash session in this project")
    return meta
  }
  const page = await repository.list({
    project,
    engine: "codesplash",
    archived: false,
    query: selection.search,
    limit: selection.continue ? 1 : 2,
  })
  if (page.sessions.length !== 1)
    throw new Error(
      page.sessions.length
        ? "Ambiguous session search; use an exact session id"
        : "No matching session in this project",
    )
  return page.sessions[0]
}
export function launchInput(
  cwd: string,
  text: string | undefined,
  files: string[] = [],
): UserInput | undefined {
  if ((text?.length ?? 0) > 1024 * 1024 || files.length > 32)
    throw new Error("Launch input exceeds 1 MiB or 32 attachments")
  if (!text?.trim() && !files.length) return undefined
  const images: string[] = [],
    documents: string[] = []
  for (const path of files) {
    if (!path || path.includes("\0")) throw new Error("Invalid launch attachment path")
    const target = isAbsolute(path) ? path : resolve(cwd, path)
    ;(/\.(png|jpe?g|gif|webp)$/i.test(path) ? images : documents).push(target)
  }
  return { text: text ?? "Review the attached files.", images, files: documents }
}
export async function readLaunchPipe(source: AsyncIterable<string | Uint8Array>): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of source) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > 1024 * 1024) throw new Error("Piped prompt exceeds 1 MiB")
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString("utf8")
}
