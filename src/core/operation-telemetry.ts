/** Classify literal commands locally; return only fixed categories, never argv, paths or URLs. */
import { parse } from "shell-quote"
import { diagnosticContext } from "./diagnostics.ts"

import { type OperationKind, operationKinds } from "./operation-kinds.ts"
export function classifyCommand(command: string): OperationKind[] {
  if (command.length > 64 * 1024 || /[$`]/.test(command) || command.includes("\0")) return []
  const found = new Set<OperationKind>()
  try {
    let words: string[] = []
    for (const token of parse(command)) {
      if (typeof token === "string") words.push(token)
      else if ("op" in token && [";", "&&", "||", "|", "&"].includes(token.op)) {
        for (const kind of classifyInvocation(words)) found.add(kind)
        words = []
      } else return [] // Dynamic globs/redirections/comments are intentionally not inferred.
    }
    for (const kind of classifyInvocation(words)) found.add(kind)
  } catch {
    return []
  }
  return [...found]
}
export function recordToolOperation(name: string, input: unknown): void {
  const log = diagnosticContext.getStore()
  if (!log) return
  if (name === "grep") log.record("index.ripgrep", { count: 1 })
  if (name !== "bash" || !input || typeof input !== "object") return
  const command = (input as { command?: unknown }).command
  if (typeof command === "string") for (const kind of classifyCommand(command)) log.record(kind, { count: 1 })
}

export function classifyInvocation(words: readonly string[]): OperationKind[] {
  const found = new Set<OperationKind>()
  let n = 0
  if (["command", "env"].includes(words[n] ?? "")) n++
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[n] ?? "")) n++
  const executable = (words[n++] ?? "")
    .split(/[\\/]/)
    .at(-1)!
    .replace(/\.exe$/i, "")
  if (executable === "git") {
    while (["-C", "-c", "--git-dir", "--work-tree"].includes(words[n] ?? "")) n += 2
    while (/^--(?:git-dir|work-tree)=/.test(words[n] ?? "")) n++
    const kind = `git.${words[n]}`
    if ((operationKinds as readonly string[]).includes(kind)) found.add(kind as OperationKind)
  } else if (
    ((executable === "gh" && words[n] === "pr") || (executable === "glab" && words[n] === "mr")) &&
    words[n + 1] === "create"
  )
    found.add("git.pr-create")
  const indexing: Record<string, OperationKind> = {
    rg: "index.ripgrep",
    "tree-sitter": "index.tree-sitter",
    "ast-grep": "index.ast-grep",
    "zoekt-query": "index.zoekt",
    src: "index.sourcegraph",
    semgrep: "index.semgrep",
  }
  if (indexing[executable]) found.add(indexing[executable])
  return [...found]
}
