import { closeSync, existsSync, fsyncSync, openSync, readdirSync, renameSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { writeTranscriptSnapshot } from "../../engines/codesplash/transcript.ts"
import {
  projectIdFor,
  readSessionEvents,
  readSessionMeta,
  type SessionMeta,
  SessionStore,
} from "../sessions.ts"
import { BranchStore } from "./branches.ts"
import { invalidateSession } from "./changes.ts"
import { atomic, bytes, component, directory } from "./files.ts"
import { workingDirectory } from "./working-directory.ts"

/** Publish a complete independent local fork; staging is invisible to repository queries. */
export async function forkLocalSession(
  branches: BranchStore,
  nodeId?: string,
  nativeThreadId?: string,
): Promise<SessionMeta> {
  const source = branches.state.directory
  if (!source || !branches.state.durable || !branches.state.assertOwned)
    throw new Error("A durable independent fork requires recorded session history")
  branches.state.assertOwned()
  const node = branches.node(nodeId),
    parent = await readSessionMeta(source)
  if (!parent) throw new Error("Source session no longer exists")
  if (parent.engine === "claude")
    throw new Error("Claude terminal handoff does not support native session forks")
  if (parent.engine === "codex" && !nativeThreadId)
    throw new Error("Codex forks require a confirmed provider thread/fork response")
  const root = dirname(dirname(source)),
    id = crypto.randomUUID(),
    stage = join(root, ".fork-staging", id)
  const now = new Date().toISOString()
  const location = workingDirectory(branches.state.read().state)
  const cwd = node.cwd ?? location?.original ?? parent.projectPath
  const meta: SessionMeta = {
    ...parent,
    projectPath: cwd,
    projectId: location ? projectIdFor(cwd) : parent.projectId,
    effectiveProjectId: undefined,
    schemaVersion: 2,
    localSessionId: id,
    nativeSessionId: parent.engine === "codesplash" ? id : nativeThreadId,
    title: `${parent.title ?? "Session"} (fork)`.slice(0, 200),
    createdAt: now,
    updatedAt: now,
    lastStatus: "closed",
    lastSequence: -1,
    archived: false,
    permissionMode: undefined,
  }
  const handle = await new SessionStore(stage).create(meta)
  handle.acquire()
  try {
    const messages = parent.engine === "codesplash" ? branches.context(node.id) : undefined
    if (messages) await writeTranscriptSnapshot(join(handle.directory, "transcript.jsonl"), messages)
    const { events } = await readSessionEvents(source)
    if (node.eventSequence >= 0 && !events.some((event) => event.sequence === node.eventSequence))
      throw new Error("Selected event evidence is not durable; flush or recover the source before forking")
    const inherited = events
      .filter(
        (event) =>
          branches
            .ancestry(node.id)
            .some(
              (boundary) =>
                event.sequence >= (boundary.eventStart ?? 0) &&
                event.sequence <= boundary.eventSequence &&
                (!boundary.evidenceTurnIds ||
                  (!!event.native?.turnId && boundary.evidenceTurnIds.includes(event.native.turnId))),
            ) &&
          !["usage.updated", "request.opened", "request.resolved", "session.status", "error"].includes(
            event.kind,
          ),
      )
      .map((event, sequence) => ({
        ...event,
        localSessionId: id,
        sequence,
        native: { ...event.native, threadId: meta.nativeSessionId },
      }))
    await handle.appendEventLines(inherited.map((event) => JSON.stringify(event)))
    await handle.updateMeta({ lastSequence: inherited.length - 1, lastStatus: "closed" })
    const child = new BranchStore(handle.state)
    child.capture({
      kind: "fork",
      cwd,
      label: node.label,
      messages,
      threadId: meta.nativeSessionId,
      turnId: node.turnId,
      eventSequence: inherited.length - 1,
      eventStart: 0,
      usage: {},
      notes: node.notes,
      origin: {
        sessionId: parent.localSessionId,
        nodeId: node.id,
        inheritedUsage: inheritedUsage(
          node.inheritedUsage ?? branches.view().origin?.inheritedUsage ?? {},
          node.usage,
        ),
      },
    })
    // Retained tool output ids are local opaque references. Preserve bounded files, never symlinks.
    let total = 0,
      count = 0
    for (const folder of ["tool-outputs", "tool-output"]) {
      const outputs = join(source, folder)
      if (!existsSync(outputs)) continue
      directory(outputs)
      for (const name of readdirSync(outputs)) {
        if (++count > 512) throw new Error("Fork retained output file limit exceeded")
        component(name)
        const content = bytes(join(outputs, name), 16 * 1024 * 1024)
        total += content.length
        if (total > 64 * 1024 * 1024) throw new Error("Fork retained output exceeds 64 MiB")
        atomic(join(handle.directory, folder, name), content)
      }
    }
    const targetParent = join(root, meta.projectId),
      target = join(targetParent, id)
    directory(targetParent, true)
    if (existsSync(target)) throw new Error("Fork id collision")
    handle.release()
    invalidateSession(target)
    renameSync(handle.directory, target)
    const fd = openSync(targetParent, "r")
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return (await readSessionMeta(target)) as SessionMeta
  } finally {
    handle.release()
    // Only this operation's UUID staging directory is removed; published content lives elsewhere.
    rmSync(stage, { recursive: true, force: true })
  }
}

export function inheritedUsage(
  parent: import("../engine.ts").SessionUsageSnapshot,
  local: import("../engine.ts").SessionUsageSnapshot,
) {
  const result: Record<string, number | boolean> = { ...parent }
  for (const [key, value] of Object.entries(local)) {
    if (typeof value === "boolean") result[key] = Boolean(result[key]) || value
    else if (typeof value === "number") result[key] = Number(result[key] ?? 0) + value
  }
  return result
}
