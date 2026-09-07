import { RESOURCE_NAME } from "./contracts.ts"

/** Intentionally small YAML subset; unsupported structures fail instead of acquiring meaning. */
export function frontmatter(source: string): { fields: Record<string, string | boolean>; body: string } {
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) return { fields: {}, body: source }
  const lines = source.split(/\r?\n/)
  const end = lines.indexOf("---", 1)
  if (end < 0) throw new Error("Unterminated resource frontmatter")
  const fields: Record<string, string | boolean> = {}
  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? ""
    if (!line.trim() || line.trimStart().startsWith("#")) continue
    const match = /^([a-zA-Z][a-zA-Z0-9-]*):\s*(.*?)\s*$/.exec(line)
    if (!match?.[1]) throw new Error("Only flat scalar resource frontmatter is supported")
    const key = match[1]
    if (Object.hasOwn(fields, key)) throw new Error(`Duplicate frontmatter field: ${key}`)
    let value = match[2] ?? ""
    const plainBoolean = value === "true" || value === "false"
    if (value === "|" || value === ">") {
      const folded = value === ">"
      const parts: string[] = []
      while (i + 1 < end && /^(?:\s+|$)/.test(lines[i + 1] ?? "")) parts.push((lines[++i] ?? "").trim())
      value = parts.join(folded ? " " : "\n")
    } else if (/^[[\]{&*!>]/.test(value)) throw new Error(`Unsupported frontmatter value: ${key}`)
    else if (value.startsWith('"')) {
      try {
        value = JSON.parse(value) as string
      } catch {
        throw new Error(`Invalid quoted frontmatter: ${key}`)
      }
    } else if (value.startsWith("'")) {
      if (value.length < 2 || !value.endsWith("'")) throw new Error(`Invalid quoted frontmatter: ${key}`)
      value = value.slice(1, -1).replaceAll("''", "'")
    }
    fields[key] = plainBoolean ? value === "true" : value
  }
  return { fields, body: lines.slice(end + 1).join("\n") }
}

export function commandArgs(source: string): string[] {
  const args: string[] = []
  let value = "",
    quote = "",
    started = false
  for (let i = 0; i < source.length; i++) {
    const char = source[i] ?? ""
    if (char === "\\" && quote !== "'") {
      if (++i >= source.length) throw new Error("Trailing argument escape")
      value += source[i]
      started = true
    } else if (quote) {
      if (char === quote) quote = ""
      else value += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) args.push(value)
      value = ""
      started = false
    } else {
      value += char
      started = true
    }
  }
  if (quote) throw new Error("Unterminated argument quote")
  if (started) args.push(value)
  return args
}

export function substitute(source: string, args: string[]): string {
  return source.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_, fallback: string, defaultValue: string, start: string, length: string, simple: string) => {
      if (fallback)
        return (
          (fallback === "@" || fallback === "ARGUMENTS" ? args.join(" ") : args[Number(fallback) - 1]) ||
          defaultValue
        )
      if (start)
        return args
          .slice(
            Math.max(0, Number(start) - 1),
            length ? Math.max(0, Number(start) - 1) + Number(length) : undefined,
          )
          .join(" ")
      return simple === "@" || simple === "ARGUMENTS" ? args.join(" ") : (args[Number(simple) - 1] ?? "")
    },
  )
}

export function mentions(source: string): string[] {
  const paths: string[] = []
  for (const match of source.matchAll(/(?:^|\s)@(?:"((?:\\.|[^"\\])+)"|([^\s"`]+))/g)) {
    const value = match[1] ? (JSON.parse(`"${match[1]}"`) as string) : match[2]
    if (value) paths.push(value)
  }
  return [...new Set(paths)]
}

export function fuzzyFiles(query: string, paths: string[]): string[] {
  const needle = query.toLowerCase()
  return paths
    .map((path) => {
      const hay = path.toLowerCase()
      let position = 0,
        score = hay.startsWith(needle)
          ? 1000
          : hay.split("/").some((part) => part.startsWith(needle))
            ? 500
            : 0
      for (const char of needle) {
        const at = hay.indexOf(char, position)
        if (at < 0) return { path, score: -Infinity }
        score -= at - position
        position = at + 1
      }
      return { path, score: score - path.length / 1000 }
    })
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 20)
    .map((item) => item.path)
}

export function skillScaffold(name: string): string {
  if (!RESOURCE_NAME.test(name))
    throw new Error("Skill names must be 1–64 lowercase letters, digits or hyphens")
  return `---\nname: ${name}\ndescription: Guidance for ${name.replaceAll("-", " ")} tasks.\ndisable-model-invocation: true\n---\n\n# ${name}\n\nDescribe when to use this skill, the steps to follow, and how to verify the result.\n`
}
