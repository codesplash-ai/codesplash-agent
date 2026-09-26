export type ShellStructure = {
  valid: boolean
  heredocs: number
  substitutions: number
  maximumDepth: number
  reason?: string
}
/** Structural inspection complements the permission tokenizer; it never grants execution.
 * Recognizes quoted heredoc bodies as data and bounds nesting before recursive policy analysis.
 */
export function shellStructure(command: string): ShellStructure {
  const out: ShellStructure = { valid: true, heredocs: 0, substitutions: 0, maximumDepth: 0 }
  const fail = (reason: string) => ({ ...out, valid: false, reason })
  if (command.length > 65536 || command.includes("\0")) return fail("size-or-nul")
  let quote = "",
    depth = 0
  const pending: { word: string; tabs: boolean }[] = []
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!,
      next = command[i + 1]
    if (quote === "'") {
      if (c === "'") quote = ""
      continue
    }
    if (c === "\\") {
      i++
      continue
    }
    if (c === "'" && !quote) {
      quote = "'"
      continue
    }
    if (c === '"') {
      quote = quote === '"' ? "" : '"'
      continue
    }
    if (c === "`" || (c === "$" && next === "(")) out.substitutions++
    if (!quote && c === "#" && (i === 0 || /\s/.test(command[i - 1]!))) {
      const end = command.indexOf("\n", i)
      if (end < 0) break
      i = end - 1
      continue
    }
    if (!quote && c === "<" && next === "<") {
      const match =
        /^<<(-?)[ \t]*(?:'([a-zA-Z_][a-zA-Z0-9_]*)'|"([a-zA-Z_][a-zA-Z0-9_]*)"|([a-zA-Z_][a-zA-Z0-9_]*))/.exec(
          command.slice(i),
        )
      if (!match) return fail("unsupported-heredoc")
      if (pending.length >= 16) return fail("heredoc-limit")
      pending.push({ word: match[2] ?? match[3] ?? match[4]!, tabs: match[1] === "-" })
      out.heredocs++
      i += match[0].length - 1
      continue
    }
    if (!quote && c === "\n" && pending.length) {
      for (const here of pending) {
        let closed = false
        while (i < command.length) {
          const start = i + 1,
            end = command.indexOf("\n", start),
            line = command.slice(start, end < 0 ? undefined : end)
          i = end < 0 ? command.length : end
          if ((here.tabs ? line.replace(/^\t+/, "") : line) === here.word) {
            closed = true
            break
          }
        }
        if (!closed) return fail("unterminated-heredoc")
      }
      pending.length = 0
      continue
    }
    if (!quote && c === "(") {
      depth++
      out.maximumDepth = Math.max(depth, out.maximumDepth)
      if (depth > 16) return fail("nesting-limit")
    }
    if (!quote && c === ")" && --depth < 0) return fail("unbalanced-parenthesis")
  }
  return quote || depth || pending.length ? fail("unterminated-structure") : out
}
