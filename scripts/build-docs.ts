/** Offline public documentation package. Fixed source allowlist; no telemetry collection or upload. */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { brand } from "../src/core/distribution/brand.ts"
import { APP_VERSION } from "../src/version.ts"

const pages = [
  "README.md",
  "docs/server.md",
  "docs/integrations.md",
  "docs/observability-and-tools.md",
  "docs/distribution.md",
  "docs/termux.md",
]
const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
function markdown(source: string): string {
  let code = false,
    html = ""
  for (const line of source.split("\n")) {
    if (line.startsWith("```")) {
      html += code ? "</code></pre>" : "<pre><code>"
      code = !code
      continue
    }
    if (code) {
      html += `${escapeHtml(line)}\n`
      continue
    }
    const heading = /^(#{1,6}) (.+)$/.exec(line)
    html += heading
      ? `<h${heading[1]!.length}>${escapeHtml(heading[2]!)}</h${heading[1]!.length}>`
      : line
        ? `<p>${escapeHtml(line)}</p>`
        : ""
  }
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
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'"><title>${escapeHtml(title)}</title><style>body{font:17px/1.6 system-ui;max-width:900px;margin:3rem auto;padding:0 1.5rem;color:#182539;background:#f7f9fc}h1,h2,h3{line-height:1.2}a{color:#175abc}pre{padding:1rem;background:#e8edf4;overflow:auto}nav{margin-bottom:2rem}p{overflow-wrap:anywhere}</style><nav><a href="index.html">${escapeHtml(brand.name)}</a> · ${APP_VERSION}</nav><main>${content}</main></html>`
  for (const page of pages) {
    const name = page.replaceAll("/", "-").replace(/\.md$/, ".html")
    await writeFile(join(output, name), shell(page, markdown(await readFile(page, "utf8"))))
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
