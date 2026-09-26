import { isAbsolute, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
/** OSC 8 payloads are built from paths, never model-supplied terminal control sequences. */
export function fileHyperlink(
  label: string,
  cwd: string,
  path: string,
  line = 1,
  editor: "file" | "vscode" = "file",
) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal control sequences cannot enter links
  if (/[\u0000-\u001f\u007f]/.test(label + path) || !Number.isSafeInteger(line) || line < 1)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: remove executable terminal controls
    return label.replace(/[\u0000-\u001f\u007f]/g, "")
  const target = resolve(cwd, path),
    within = relative(cwd, target)
  if (isAbsolute(within) || within === ".." || within.startsWith("../")) return label
  const url = pathToFileURL(target)
  const destination = editor === "vscode" ? `vscode://file${url.pathname}:${line}` : `${url.href}#L${line}`
  return `\u001b]8;;${destination}\u001b\\${label}\u001b]8;;\u001b\\`
}
export function linkFileCitations(text: string, cwd: string, editor: "file" | "vscode" = "file") {
  return text.replace(
    /(?<![\w/])((?:[\w.-]+\/)*[\w.-]+\.[a-zA-Z0-9]+):(\d+)(?::\d+)?/g,
    (label, path, line) => fileHyperlink(label, cwd, path, Number(line), editor),
  )
}

/** Markdown links let OpenTUI emit OSC 8 without accepting model-supplied escape sequences. */
export function markdownFileCitations(text: string, cwd: string) {
  return text
    .split(/(```[\s\S]*?```|\[[^\]]*\]\([^)]*\))/g)
    .map((part) => {
      if (part.startsWith("```") || part.startsWith("[")) return part
      return part.replace(
        /`?((?:[\w.-]+\/)*[\w.-]+\.[a-zA-Z0-9]+):(\d+)(?::\d+)?`?/g,
        (label, path, line) => {
          const target = resolve(cwd, path),
            inside = relative(cwd, target)
          if (inside === ".." || inside.startsWith("../") || isAbsolute(inside) || Number(line) < 1)
            return label
          return `[${label.replaceAll("`", "")}](<${pathToFileURL(target).href}#L${line}>)`
        },
      )
    })
    .join("")
}
