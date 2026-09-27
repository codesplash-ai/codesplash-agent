import { existsSync } from "node:fs"
import { join } from "node:path"
import { logBytes } from "./compression.ts"
import { control } from "./control.ts"
import { digest, directory } from "./files.ts"
import { safeSessionText } from "./repository.ts"

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
type Child = { id: string; task: string; parent?: string; agent: string; directory: string }
/** Traverse only identities declared in the parent's checked journal, never arbitrary supplied paths. */
export function recordedChildren(root: string, rootId: string): Child[] {
  const result: Child[] = [],
    seen = new Set<string>()
  const visit = (path: string, parent?: string) => {
    directory(path)
    const records = control(path).state.values.children ?? []
    if (!Array.isArray(records) || records.length > 128) throw new Error("Invalid child journal")
    const local = new Set<string>()
    for (const raw of records) {
      const identity = raw?.identity
      if (
        !identity ||
        typeof identity.id !== "string" ||
        !uuid.test(identity.id) ||
        identity.root !== rootId ||
        typeof raw.task !== "string" ||
        !uuid.test(raw.task) ||
        typeof identity.agent !== "string" ||
        identity.agent.length > 256
      )
        throw new Error("Invalid child identity")
      // A resumed child has several task records; display its latest task only.
      if (local.has(identity.id)) {
        result.find((r) => r.id === identity.id)!.task = raw.task
        continue
      }
      if (seen.has(identity.id) || seen.size >= 128)
        throw new Error("Duplicate child or traversal limit exceeded")
      local.add(identity.id)
      seen.add(identity.id)
      const child = {
        id: identity.id,
        task: raw.task,
        parent,
        agent: safeSessionText(identity.agent),
        directory: join(path, "children", identity.id),
      }
      result.push(child)
      if (existsSync(child.directory)) visit(child.directory, child.id)
    }
  }
  visit(root)
  return result
}
export function childTranscript(child: Child, offset = 0, limit = 50, expected?: string) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Transcript offset must be nonnegative and limit between 1 and 100")
  const source = logBytes(join(child.directory, "transcript.jsonl")),
    fingerprint = digest(source)
  if (expected !== undefined && expected !== fingerprint)
    throw new Error("Child transcript changed; restart pagination")
  const rows: { message: number; role: string; kind: string; chunk: number; text: string }[] = []
  let message = 0,
    total = 0,
    skipped = 0
  for (const line of source.toString().split("\n")) {
    if (!line.trim()) continue
    let parsed: { v?: number; message?: { role?: string; content?: unknown[] } }
    try {
      parsed = JSON.parse(line)
    } catch {
      skipped++
      continue
    }
    const m = parsed?.message
    if (parsed?.v !== 1 || !m || !["user", "assistant"].includes(m.role ?? "") || !Array.isArray(m.content)) {
      skipped++
      continue
    }
    for (const raw of m.content) {
      const block = raw as Record<string, unknown>
      if (!block || typeof block !== "object") continue
      let text: string
      if (block.type === "text" || block.type === "tool_result")
        text = typeof block.text === "string" ? block.text : ""
      else if (block.type === "tool_call")
        text = JSON.stringify({ id: block.id, name: block.name, input: block.input })
      else if (["image", "document"].includes(String(block.type))) text = `[${block.type} attachment omitted]`
      else continue // Provider-private reasoning/signatures and unknown blocks are never exposed.
      text = safeSessionText(text)
      for (let at = 0, chunk = 0; at < text.length; at += 16384, chunk++) {
        if (total >= offset && rows.length < limit)
          rows.push({
            message,
            role: m.role!,
            kind: String(block.type),
            chunk,
            text: text.slice(at, at + 16384),
          })
        total++
      }
    }
    message++
  }
  return {
    id: child.id,
    task: child.task,
    fingerprint,
    rows,
    total,
    skipped,
    next: offset + rows.length < total ? offset + rows.length : undefined,
  }
}
