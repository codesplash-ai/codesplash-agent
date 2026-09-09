import { resolve } from "node:path"
import { BranchStore } from "../core/session/branches.ts"
import {
  type ExportOptions,
  exportPortable,
  importPortable,
  readPortable,
  renderPortable,
  writePortable,
} from "../core/session/portable.ts"
import type { SessionRepository } from "../core/session/repository.ts"
import { SessionStore } from "../core/sessions.ts"

export function exportArguments(args: string[], cwd = process.cwd()) {
  const options: ExportOptions = {}
  let format: "json" | "markdown" | "html" = "json",
    path: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--all") options.all = true
    else if (arg === "--redact") options.redact = true
    else if (arg === "--images") options.images = true
    else if (arg === "--format") {
      const value = args[++i]
      if (value !== "json" && value !== "markdown" && value !== "html")
        throw new Error("Export formats: json, markdown, html")
      format = value
    } else if (arg === "--output" && args[i + 1]) path = resolve(cwd, args[++i] as string)
    else throw new Error(`Unknown export option ${arg}`)
  }
  return { options, format, path }
}
export async function sessionPortableCommand(
  repository: SessionRepository,
  args: string[],
  output: (text: string) => void,
): Promise<number> {
  const [action, id, ...rest] = args
  if (!id)
    throw new Error(
      "Use session export ID [--format json|markdown|html] [--output FILE] [--all] [--redact] [--images], or session import FILE --path DIR [--apply]",
    )
  if (action === "export") {
    const { options, format, path } = exportArguments(rest),
      meta = await repository.resolve(id),
      handle = await new SessionStore(repository.root).open(meta.projectId, meta.localSessionId)
    handle.acquire()
    try {
      const bundle = await exportPortable(new BranchStore(handle.state), meta, options),
        source = renderPortable(bundle, format)
      if (path) {
        writePortable(path, source)
        output(`${JSON.stringify({ path, sha256: bundle.sha256, omissions: bundle.payload.omissions })}\n`)
      } else output(source)
    } finally {
      handle.release()
    }
    return 0
  }
  let cwd = process.cwd(),
    apply = false,
    expected: string | undefined
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--path" && rest[i + 1]) cwd = resolve(rest[++i] as string)
    else if (rest[i] === "--apply") apply = true
    else if (rest[i] === "--sha256" && rest[i + 1]) expected = rest[++i]
    else if (rest[i] !== "--json") throw new Error(`Unknown portable import option ${rest[i]}`)
  }
  const bundle = readPortable(resolve(id))
  if (expected && expected !== bundle.sha256) throw new Error("Import content changed since preview")
  output(`${JSON.stringify(await importPortable(repository.root, bundle, cwd, apply), null, 2)}\n`)
  return 0
}
