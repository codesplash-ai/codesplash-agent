/** Offline public documentation package. Fixed source allowlist; no telemetry collection or upload. */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, posix, resolve } from "node:path"
import { brand } from "../src/core/distribution/brand.ts"
import { APP_VERSION } from "../src/version.ts"

const pages = [
  "README.md",
  "docs/server.md",
  "docs/integrations.md",
  "docs/observability-and-tools.md",
  "docs/distribution.md",
  "docs/termux.md",
  "docs/agent-roadmap-status.md",
  "docs/agent-carryovers.md",
  "docs/storage-platform-boundaries.md",
]
const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
const pageName = (page: string) => page.replaceAll("/", "-").replace(/\.md$/, ".html")
function linkTarget(target: string, page: string): string | undefined {
  if (/^https?:\/\//.test(target)) {
    const url = new URL(target)
    return url.username || url.password ? undefined : url.href
  }
  if (target.startsWith("#")) return target
  const [path, fragment] = target.split("#", 2)
  const local = posix.normalize(posix.join(posix.dirname(page), path!))
  return pages.includes(local) ? pageName(local) + (fragment ? `#${fragment}` : "") : undefined
}
function inline(source: string, page: string): string {
  const pattern = /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g
  let result = "",
    at = 0
  for (const match of source.matchAll(pattern)) {
    result += escapeHtml(source.slice(at, match.index))
    if (match[1] && match[2]) {
      let href: string | undefined
      try {
        href = linkTarget(match[2], page)
      } catch {}
      result += href
        ? `<a href="${escapeHtml(href)}" rel="noreferrer">${escapeHtml(match[1])}</a>`
        : escapeHtml(match[1])
    } else if (match[3]) result += `<code>${escapeHtml(match[3])}</code>`
    else result += `<strong>${escapeHtml(match[4]!)}</strong>`
    at = match.index! + match[0].length
  }
  return result + escapeHtml(source.slice(at))
}
/** Deliberately inert Markdown: escaped HTML, allowlisted local links, no scripts or remote assets. */
export function publicMarkdown(source: string, page: string): string {
  let code = false,
    html = "",
    list = "",
    table = false
  const lines = source.split("\n")
  const closeList = () => {
    if (list) {
      html += `</${list}>`
      list = ""
    }
  }
  const closeTable = () => {
    if (table) {
      html += "</tbody></table>"
      table = false
    }
  }
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split(/(?<!\\)\|/)
      .map((s) => s.trim().replaceAll("\\|", "|"))
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith("```")) {
      closeList()
      closeTable()
      html += code ? "</code></pre>" : "<pre><code>"
      code = !code
      continue
    }
    if (code) {
      html += `${escapeHtml(line)}\n`
      continue
    }
    if (line.startsWith("|") && (table || /^\|?\s*:?-{3,}/.test(lines[i + 1] ?? ""))) {
      closeList()
      if (!table) {
        html += `<table><thead><tr>${cells(line)
          .map((s) => `<th>${inline(s, page)}</th>`)
          .join("")}</tr></thead><tbody>`
        table = true
        i++
      } else
        html += `<tr>${cells(line)
          .map((s) => `<td>${inline(s, page)}</td>`)
          .join("")}</tr>`
      continue
    }
    closeTable()
    const bullet = /^\s*(?:[-*]|(\d+)\.) (.+)$/.exec(line)
    if (bullet) {
      const kind = bullet[1] ? "ol" : "ul"
      if (list !== kind) {
        closeList()
        html += `<${kind}>`
        list = kind
      }
      html += `<li>${inline(bullet[2]!, page)}</li>`
      continue
    }
    closeList()
    const heading = /^(#{1,6}) (.+)$/.exec(line)
    const anchor = heading?.[2]
      ?.toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, "")
      .replaceAll(" ", "-")
    html += heading
      ? `<h${heading[1]!.length} id="${escapeHtml(anchor!)}">${inline(heading[2]!, page)}</h${heading[1]!.length}>`
      : line
        ? `<p>${inline(line, page)}</p>`
        : ""
  }
  closeList()
  closeTable()
  return html + (code ? "</code></pre>" : "")
}
export function publicStats(value: unknown): Record<string, number> {
  if (!Array.isArray(value) || value.length > 10000) throw new Error("Expected stats --json rows")
  const totals: Record<string, number> = { sessions: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
  for (const row of value)
    for (const key of Object.keys(totals)) {
      const number = row?.[key]
      if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > 1e15)
        throw new Error("Invalid public stats aggregate")
      totals[key]! += number
    }
  return totals
}
export async function buildDocs(output: string, statsPath?: string): Promise<void> {
  if (brand.variant !== "public") throw new Error("Internal builds cannot generate the public docs package")
  await mkdir(output, { recursive: true })
  const links: string[] = []
  const shell = (title: string, content: string) =>
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'"><title>${escapeHtml(title)}</title><style>body{font:17px/1.6 system-ui;max-width:900px;margin:3rem auto;padding:0 1.5rem;color:#182539;background:#f7f9fc}h1,h2,h3{line-height:1.2}a{color:#175abc}pre{padding:1rem;background:#e8edf4;overflow:auto}nav{margin-bottom:2rem}p,td{overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #ccd4e0;padding:.5rem;text-align:left;vertical-align:top}code{background:#e8edf4}</style><nav><a href="index.html">${escapeHtml(brand.name)}</a> · ${APP_VERSION}</nav><main>${content}</main></html>`
  for (const page of pages) {
    const name = pageName(page)
    await writeFile(join(output, name), shell(page, publicMarkdown(await readFile(page, "utf8"), page)))
    links.push(`<li><a href="${name}">${escapeHtml(page)}</a></li>`)
  }
  if (statsPath) {
    const totals = publicStats(JSON.parse(await readFile(statsPath, "utf8")))
    await writeFile(
      join(output, "stats.html"),
      shell(
        "Published usage snapshot",
        `<h1>Published usage snapshot</h1><p>Operator-selected aggregate. This page collects no usage data.</p><dl>${Object.entries(
          totals,
        )
          .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`)
          .join("")}</dl>`,
      ),
    )
    links.push('<li><a href="stats.html">Published usage snapshot</a></li>')
  }
  await writeFile(
    join(output, "index.html"),
    shell(brand.name, `<h1>${escapeHtml(brand.name)}</h1><ul>${links.join("")}</ul>`),
  )
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify({ version: 1, release: APP_VERSION, pages, stats: Boolean(statsPath) }),
  )
}
if (import.meta.main) {
  const [output, stats, ...rest] = process.argv.slice(2)
  if (!output || rest.length)
    throw new Error("Usage: bun scripts/build-docs.ts OUTPUT_DIR [PUBLIC_STATS_JSON]")
  await buildDocs(resolve(output), stats)
}
