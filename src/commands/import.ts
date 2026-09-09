import { createHash } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { writeResources } from "../engines/codesplash/inputs/authoring.ts"
import { resourceCandidate, resourceMetadata } from "../engines/codesplash/inputs/catalog.ts"
import { resourcePaths, safeRead } from "../engines/codesplash/inputs/io.ts"
import { frontmatter } from "../engines/codesplash/inputs/syntax.ts"

export type ImportPreview = {
  vendor: "claude" | "cursor"
  source: string
  destination: string
  files: Array<{ source: string; path: string; sha256: string; text: string }>
  unsupported: string[]
  sourceHashes: Record<string, string>
}
export async function previewImport(
  vendor: "claude" | "cursor",
  source: string,
  destination: string,
): Promise<ImportPreview> {
  if ((await lstat(source)).isSymbolicLink()) throw new Error("Import source cannot be a symlink")
  source = await realpath(source)
  const preview: ImportPreview = {
    vendor,
    source,
    destination: await realpath(destination),
    files: [],
    unsupported: [],
    sourceHashes: {},
  }
  const paths = await resourcePaths(source)
  const rules: Array<{ path: string; text: string }> = []
  for (const path of paths) {
    const normalized = vendor === "claude" && /^(commands|skills)\//.test(path) ? `.claude/${path}` : path
    const candidate = resourceCandidate(normalized, false, {
      claudeRules: true,
      claudeCommands: true,
      claudeSkills: true,
      cursorRules: true,
    })
    if (!candidate || (candidate.source !== vendor && !(vendor === "claude" && path === "CLAUDE.md")))
      continue
    const text = await safeRead(source, path)
    preview.sourceHashes[path] = createHash("sha256").update(text).digest("hex")
    const metadata = resourceMetadata(candidate, text)
    if (!metadata) {
      preview.unsupported.push(`${path}: conditional rule (only alwaysApply rules can be imported)`)
      continue
    }
    if (/^\s*@include\s/m.test(text)) {
      preview.unsupported.push(`${path}: relative imports need manual relocation`)
      continue
    }
    if (metadata.fork) {
      preview.unsupported.push(`${path}: forked execution requires M7`)
      continue
    }
    if (candidate.kind === "rule") {
      rules.push({ path, text: frontmatter(text).body })
      continue
    }
    preview.files.push({
      source: path,
      path:
        candidate.kind === "skill"
          ? `.codesplash/skills/${candidate.name}/SKILL.md`
          : `.codesplash/commands/${candidate.name}.md`,
      text,
      sha256: createHash("sha256").update(text).digest("hex"),
    })
  }
  if (rules.length) {
    const text = rules.map((r) => `<!-- Imported from ${r.path} -->\n${r.text}`).join("\n\n")
    if (Buffer.byteLength(text) > 24 * 1024)
      throw new Error("Imported rules exceed the 24 KiB AGENTS.md limit")
    preview.files.push({
      source: rules.map((r) => r.path).join(", "),
      path: "AGENTS.md",
      text,
      sha256: createHash("sha256").update(text).digest("hex"),
    })
  }
  // Only key names are reported; credential and settings values never enter the preview.
  for (const path of vendor === "claude"
    ? ["settings.json", ".claude/settings.json", ".claude/settings.local.json", ".mcp.json"]
    : [".cursor/mcp.json", "mcp.json", "settings.json"]) {
    const info = await lstat(resolve(source, path)).catch(() => undefined)
    if (!info) continue
    const text = await safeRead(source, path)
    try {
      const value: unknown = JSON.parse(text)
      const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : []
      preview.unsupported.push(
        `${path}: ${keys.map((k) => (/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(k) ? k : "[nonstandard key]")).join(", ") || "settings document"}`,
      )
    } catch {
      preview.unsupported.push(`${path}: invalid settings document`)
    }
  }
  preview.unsupported.push(
    "Authentication, sessions/history, settings behavior and MCP execution are not migrated.",
  )
  return preview
}

export async function applyImport(preview: ImportPreview): Promise<void> {
  if (!preview.files.length) throw new Error("No supported resources to import")
  const { files, ...details } = preview
  await writeResources(preview.destination, [
    ...files,
    {
      path: `.codesplash/import-${preview.vendor}.json`,
      text: `${JSON.stringify({ ...details, files: files.map(({ text: _text, ...file }) => file) }, null, 2)}\n`,
    },
  ])
}

export async function runImportCommand(
  args: string[],
  output: (text: string) => void = (text) => process.stdout.write(text),
): Promise<number> {
  if (args[0] === "settings")
    return (await import("./import-settings.ts")).runSettingsImport(args.slice(1), output)
  if (args[0] === "sessions") {
    const { SessionRepository } = await import("../core/session/repository.ts")
    const { sessionForeignCommand } = await import("./session-foreign.ts")
    const [vendor, root, file, ...flags] = args.slice(1)
    if (vendor === "codesplash" && root)
      return (await import("./session-portable.ts")).sessionPortableCommand(
        new SessionRepository(),
        ["import", root, ...args.slice(3)],
        output,
      )
    return sessionForeignCommand(
      new SessionRepository(),
      file && !file.startsWith("--")
        ? ["convert", vendor ?? "", root ?? "", file, ...flags]
        : ["list", vendor ?? "", root ?? "", ...args.slice(3)],
      output,
    )
  }
  const [vendor, source, ...flags] = args
  if ((vendor !== "claude" && vendor !== "cursor") || !source)
    throw new Error("Usage: codesplash import <claude|cursor> <source-dir> [--apply] [--destination DIR]")
  let destination = process.cwd(),
    apply = false
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--apply") apply = true
    else if (flags[i] === "--destination" && flags[i + 1]) destination = resolve(flags[++i] ?? "")
    else throw new Error(`Unknown import option: ${flags[i]}`)
  }
  const preview = await previewImport(vendor, resolve(source), destination)
  output(
    `${apply ? "Import" : "Preview"} ${vendor}: ${preview.source} → ${preview.destination}\n${preview.files.map((f) => `${f.source} → ${f.path} (sha256 ${f.sha256})`).join("\n")}\nUnsupported: ${preview.unsupported.join("\n")}\n`,
  )
  if (apply) {
    await applyImport(preview)
    output("Imported resources. Workspace trust and read permissions still apply.\n")
  } else output("Use --apply to write these resources; existing files are never overwritten.\n")
  return 0
}
