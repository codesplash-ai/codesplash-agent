import type { TaskRequest } from "./contracts.ts"
export function taskCommand(source: string): TaskRequest {
  const text = source.trim(),
    [action = "list", id, a, b, ...rest] = text ? text.split(/\s+/) : []
  if (action === "stdin") {
    const match = /^stdin\s+(\S+)\s+([\s\S]+)$/.exec(text)
    if (!match?.[1] || !match[2]) throw new Error('Usage: /tasks stdin ID "text\\n"')
    const input: unknown = match[2].startsWith('"') ? JSON.parse(match[2]) : match[2]
    if (typeof input !== "string") throw new Error("Terminal input must be text")
    return { action, id: match[1], text: input }
  }
  if (action === "list" && !id) return { action }
  if (action === "background" && !id) return { action }
  if (["kill", "forget"].includes(action) && id && !a) return { action: action as "kill" | "forget", id }
  if (action === "output" && id && !b) return { action, id, cursor: a === undefined ? undefined : Number(a) }
  if (action === "resize" && id && a && b && !rest.length)
    return { action, id, cols: Number(a), rows: Number(b) }
  if (action === "wait" && ["any", "all"].includes(id ?? "") && a)
    return { action, ids: [a, ...(b ? [b] : []), ...rest], all: id === "all", timeoutMs: 1000 }
  throw new Error(
    "Usage: /tasks [list | output ID [CURSOR] | stdin ID TEXT | resize ID COLS ROWS | kill ID | wait any|all IDS | forget ID | background]",
  )
}
