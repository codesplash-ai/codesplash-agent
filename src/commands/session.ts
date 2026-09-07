import { realpathSync } from "node:fs"
import { dataDirectory } from "../core/config.ts"
import { type SessionQuery, SessionRepository, safeSessionText } from "../core/session/repository.ts"
import { projectIdFor, sessionsRootDirectory } from "../core/sessions.ts"
import { UsageError } from "./usage-error.ts"

export async function runSessionCommand(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; output?: (text: string) => void; repository?: SessionRepository } = {},
): Promise<number> {
  const output = options.output ?? ((text) => process.stdout.write(text))
  const repository =
    options.repository ?? new SessionRepository(sessionsRootDirectory(dataDirectory(options.env)))
  const query: SessionQuery = { archived: false },
    positional: string[] = []
  let apply = false,
    json = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === "--apply") apply = true
    else if (arg === "--json") json = true
    else if (arg === "--archived") query.archived = true
    else if (arg === "--all") query.archived = undefined
    else if (
      ["--path", "--project", "--engine", "--section", "--organization", "--limit", "--offset"].includes(arg)
    ) {
      const value = args[++i]
      if (!value || value.startsWith("--")) throw new UsageError(`${arg} requires a value`)
      if (arg === "--path") query.project = projectIdFor(realpathSync(value))
      else if (arg === "--project") query.project = value
      else if (arg === "--engine") {
        if (!["codesplash", "codex", "claude"].includes(value)) throw new UsageError("Unknown session engine")
        query.engine = value
      } else if (arg === "--section") query.section = value
      else if (arg === "--organization") query.organization = value
      else if (arg === "--limit") query.limit = Number(value)
      else query.offset = Number(value)
    } else if (arg.startsWith("--")) throw new UsageError(`Unknown session option ${arg}`)
    else positional.push(arg)
  }
  const [action = "list", id, ...rest] = positional
  const emit = (value: unknown) =>
    output(`${json ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`)
  if (action === "list" || action === "search") {
    if (action === "list" && id) throw new UsageError("session list takes no positional arguments")
    if (action === "search") {
      if (!id) throw new UsageError("session search requires text")
      query.query = [id, ...rest].join(" ")
    }
    const page = await repository.list(query)
    if (json) emit(page)
    else {
      for (const meta of page.sessions)
        output(
          `${meta.localSessionId}  ${meta.engine}  ${safeSessionText(meta.title ?? "Untitled session")}${meta.archived ? " [archived]" : ""}\n`,
        )
      output(`${page.total} sessions${page.next === undefined ? "" : `; next --offset ${page.next}`}\n`)
      for (const warning of page.warnings) output(`${warning}\n`)
    }
    return 0
  }
  if (action === "projects") {
    if (id) throw new UsageError("session projects takes no positional arguments")
    const projects = new Map<
      string,
      { id: string; path: string; sessions: number; organizations: string[] }
    >()
    for (const meta of await repository.all()) {
      const item = projects.get(meta.projectId) ?? {
        id: meta.projectId,
        path: meta.projectPath,
        sessions: 0,
        organizations: [],
      }
      item.sessions++
      if (meta.organization && !item.organizations.includes(meta.organization))
        item.organizations.push(meta.organization)
      projects.set(meta.projectId, item)
    }
    emit([...projects.values()])
    return 0
  }
  if (action === "reindex") {
    if (id) throw new UsageError("session reindex takes no positional arguments")
    if (!apply) {
      emit({
        action,
        sessions: (await repository.all()).length,
        apply: "Use --apply to rebuild the derived index",
      })
      return 0
    }
    const abort = new AbortController(),
      cancel = () => abort.abort(new Error("Session indexing cancelled; the previous index remains usable"))
    process.once("SIGINT", cancel)
    process.once("SIGTERM", cancel)
    try {
      emit(
        await repository.reindex({
          signal: abort.signal,
          onProgress:
            !json && process.stderr.isTTY
              ? (progress) => {
                  if (progress.completed % 100 === 0)
                    process.stderr.write(`Indexed ${progress.completed} sessions\n`)
                }
              : undefined,
        }),
      )
    } finally {
      process.removeListener("SIGINT", cancel)
      process.removeListener("SIGTERM", cancel)
    }
    return 0
  }

  if (["queue", "history", "stash"].includes(action)) {
    if (!id) throw new UsageError(`session ${action} requires a session id`)
    const { sessionInputCommand } = await import("./session-input.ts")
    emit(
      await sessionInputCommand(
        repository,
        await repository.resolve(id, query.project),
        action as "queue" | "history" | "stash",
        rest,
        apply,
      ),
    )
    return 0
  }

  if (!id)
    throw new UsageError(
      "session <show|rename|archive|unarchive|delete|move|section|migrate|compress|recover> requires a session id",
    )
  if (
    ![
      "show",
      "rename",
      "archive",
      "unarchive",
      "delete",
      "move",
      "section",
      "migrate",
      "compress",
      "recover",
    ].includes(action)
  )
    throw new UsageError(`Unknown session action ${action}`)
  const meta = await repository.resolve(id, query.project, action === "recover")
  if (action === "show") emit({ meta, recovery: repository.preview(meta, action) })
  else if (action === "rename") {
    if (!rest.length) throw new UsageError("session rename requires a title")
    emit(await repository.rename(meta, rest.join(" ")))
  } else if (action === "archive" || action === "unarchive") {
    if (rest.length) throw new UsageError(`${action} takes one session id`)
    emit(await repository.archive(meta, action === "archive"))
  } else if (action === "section") {
    const section = rest.join(" ") || query.section
    if (section === undefined) throw new UsageError("session section ID <section-name>")
    emit(await repository.move(meta, meta.organization ?? "", section, meta.position ?? 0))
  } else if (action === "move") {
    if (!rest.length || rest.length > 3)
      throw new UsageError("session move ID <organization> [section] [position]")
    emit(await repository.move(meta, rest[0] as string, rest[1] ?? query.section ?? "", Number(rest[2] ?? 0)))
  } else {
    if (rest.length) throw new UsageError(`${action} takes one session id`)
    const preview = repository.preview(meta, action)
    emit(
      apply
        ? await repository.maintenance(
            meta,
            action as "delete" | "migrate" | "compress" | "recover",
            preview.revision,
          )
        : { ...preview, apply: "Use --apply after reviewing this preview" },
    )
  }
  return 0
}
