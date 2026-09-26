import { renderMermaidASCII } from "beautiful-mermaid"

const symbols: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  theta: "θ",
  lambda: "λ",
  mu: "μ",
  pi: "π",
  sigma: "σ",
  phi: "φ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Sigma: "Σ",
  Omega: "Ω",
  sum: "∑",
  prod: "∏",
  int: "∫",
  infty: "∞",
  partial: "∂",
  nabla: "∇",
  times: "×",
  cdot: "·",
  pm: "±",
  leq: "≤",
  geq: "≥",
  neq: "≠",
  approx: "≈",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  in: "∈",
  notin: "∉",
  forall: "∀",
  exists: "∃",
  cup: "∪",
  cap: "∩",
  ldots: "…",
  dots: "…",
  quad: "  ",
  qquad: "    ",
  left: "",
  right: "",
}
const superscripts = Object.fromEntries(
  [..."0123456789+-=()n"].map((c, i) => [c, [..."⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿ"][i]]),
)
const subscripts = Object.fromEntries([..."0123456789+-=()"].map((c, i) => [c, [..."₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎"][i]]))

/** Bounded, non-evaluating math notation; unknown commands stay visible. */
export function terminalMath(source: string): string {
  if (source.length > 4096) return source
  let index = 0
  const group = (depth: number): string => {
    if (depth > 16) throw new Error("Math nesting exceeds 16")
    if (source[index] !== "{") return source[index++] ?? ""
    index++
    const value = read(depth + 1, true)
    if (source[index] !== "}") throw new Error("Unclosed math group")
    index++
    return value
  }
  const read = (depth: number, grouped = false): string => {
    let result = ""
    while (index < source.length) {
      const ch = source[index]!
      if (grouped && ch === "}") break
      if (ch === "{") {
        result += group(depth)
        continue
      }
      index++
      if (ch === "\\") {
        const match = /^[a-zA-Z]+/.exec(source.slice(index))
        if (!match) {
          result += source[index++] ?? "\\"
          continue
        }
        const name = match[0]
        index += name.length
        if (name === "frac") {
          const a = group(depth),
            b = group(depth)
          result += `(${a})/(${b})`
        } else if (name === "sqrt") result += `√(${group(depth)})`
        else if (["text", "mathrm", "mathbf", "mathit", "operatorname"].includes(name)) result += group(depth)
        else result += symbols[name] ?? `\\${name}`
      } else if (ch === "^" || ch === "_") {
        const value = group(depth),
          map = ch === "^" ? superscripts : subscripts
        result += [...value].every((c) => map[c]) ? [...value].map((c) => map[c]).join("") : `${ch}(${value})`
      } else result += ch
    }
    return result
  }
  try {
    return read(0)
  } catch {
    return source
  }
}

export function terminalMarkdown(source: string): string {
  if (source.length > 256 * 1024) return source
  // Transform complete fenced blocks; never reinterpret ordinary code as math.
  return source
    .split(/(```[^\n]*\n[\s\S]*?```)/g)
    .map((part) => {
      const fence = /^```(mermaid|latex|math)\s*\n([\s\S]*?)```$/.exec(part)
      if (fence) {
        const body = fence[2]!
        if (fence[1] !== "mermaid") return `\`\`\`text\n${terminalMath(body)}\n\`\`\``
        if (
          body.length > 4096 ||
          body.split(/[\n;]/).length > 48 ||
          (body.match(/--|->|==/g)?.length ?? 0) > 48
        )
          return part
        try {
          const normalized = body.replace(/^\s*(graph|flowchart)\s+(TD|TB|BT|LR|RL)\s*;/, "$1 $2\n")
          const rendered = renderMermaidASCII(normalized, { colorMode: "none", paddingX: 2, paddingY: 1 })
          if (rendered.length > 32768 || rendered.split("\n").length > 160) return part
          return `\`\`\`text\n${rendered}\n\`\`\``
        } catch {
          return part
        }
      }
      if (part.startsWith("```")) return part
      return part
        .split(/(`+[^`]*`+)/g)
        .map((span) =>
          span.startsWith("`")
            ? span
            : span.replace(/\$\$([\s\S]*?)\$\$|\$([^$\n]*[\\^_][^$\n]*)\$/g, (_all, block, inline) =>
                terminalMath(block ?? inline),
              ),
        )
        .join("")
    })
    .join("")
}
