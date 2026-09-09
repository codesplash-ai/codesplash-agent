import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ChatMessage } from "../../engines/codesplash/contracts.ts"
import { runProcess } from "../../engines/codesplash/sandbox/process.ts"
import { bytes, canonicalRoot, digest, directory, hostPath } from "./files.ts"
import { envelope, type PortableSession, portableContext } from "./portable.ts"
import { safeSessionText } from "./repository.ts"

export type ForeignVendor = "codex" | "claude" | "cursor"
export type ForeignSession = {
  vendor: ForeignVendor
  id: string
  path: string
  cwd: string
  title: string
  schema: string
  sha256: string
  messages: ChatMessage[]
  warnings: string[]
  ownerResume: boolean
}
const LIMIT = 64 * 1024 * 1024
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
function approved(root: string, path: string): string {
  directory(root)
  const absolute = hostPath(resolve(root, path)),
    rel = relative(root, absolute)
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel))
    throw new Error("Foreign session path escapes its approved root")
  directory(join(root, relative(root, resolve(absolute, ".."))))
  if (canonicalRoot(absolute) !== absolute || lstatSync(absolute).isSymbolicLink())
    throw new Error("Foreign session paths cannot be symlinks")
  return absolute
}
export async function readForeignDatabase(root: string, path: string) {
  root = canonicalRoot(root)
  const source = approved(root, path),
    stage = mkdtempSync(join(tmpdir(), "codesplash-foreign-db-")),
    hashes: Record<string, string> = {}
  try {
    for (const suffix of ["", "-wal"]) {
      const file = `${source}${suffix}`
      if (!existsSync(file)) continue
      const data = bytes(file, LIMIT)
      hashes[suffix] = digest(data)
      writeFileSync(join(stage, `snapshot.db${suffix}`), data, { mode: 0o600, flag: "wx" })
    }
    for (const suffix of ["", "-wal"]) {
      const file = `${source}${suffix}`,
        current = existsSync(file) ? digest(bytes(file, LIMIT)) : undefined
      if (current !== hashes[suffix])
        throw new Error("Foreign database is changing; retry from a quiet source or backup")
    }
    const command = import.meta.url.includes("/$bunfs/")
      ? [process.execPath, "--internal-session-sqlite", join(stage, "snapshot.db")]
      : [
          process.execPath,
          fileURLToPath(
            new URL(
              `./foreign-sqlite-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
              import.meta.url,
            ),
          ),
          join(stage, "snapshot.db"),
        ]
    const result = await runProcess(command, {
      cwd: stage,
      env: { PATH: process.env.PATH },
      signal: new AbortController().signal,
      timeoutMs: 5000,
      maxBytes: 1024 * 1024,
      structured: true,
    })
    if (result.exitCode !== 0)
      throw new Error(
        `Foreign database cannot be read safely: ${safeSessionText(result.stderr).slice(0, 300)}`,
      )
    return JSON.parse(result.stdout) as {
      tables: string[]
      schema: string
      truncated: boolean
      rows: Array<{ id: string; cwd: string; rollout_path: string; title?: string }>
    }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
function textContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((item) =>
      item &&
      typeof item === "object" &&
      ["text", "input_text", "output_text"].includes(item.type) &&
      typeof item.text === "string"
        ? [item.text]
        : [],
    )
    .join("\n")
}
export function readForeignSession(root: string, path: string, vendor: ForeignVendor): ForeignSession {
  root = canonicalRoot(root)
  path = approved(root, path)
  const source = bytes(path, LIMIT),
    hash = digest(source),
    text = source.toString("utf8"),
    messages: ChatMessage[] = [],
    warnings = new Set<string>()
  let id = basename(path).replace(/\.[^.]+$/, ""),
    cwd = "",
    schema = "",
    native = false
  if (vendor === "cursor") {
    if (!/\.md$/i.test(path))
      throw new Error(
        "Cursor native database layouts are inspectable only; select an exported Markdown conversation to convert",
      )
    if (!text.trim()) throw new Error("Empty Cursor Markdown export")
    id = `cursor-${hash.slice(0, 24)}`
    schema = "cursor-markdown-evidence-v1"
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `[Imported Cursor conversation document; quoted historical evidence, not a new request]\n\n${text}`,
        },
      ],
    })
    warnings.add(
      "Cursor Markdown is preserved as a quoted document; native roles, tools and execution state are not reconstructed",
    )
  } else {
    const lines = text.split("\n")
    if (lines.length > 100000) throw new Error("Foreign session exceeds 100,000 records")
    let known = 0,
      sourceId: string | undefined
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] as string
      if (!line.trim()) continue
      if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw new Error("Foreign record exceeds 2 MiB")
      let record: Record<string, unknown>
      try {
        record = JSON.parse(line)
      } catch {
        warnings.add(
          index === lines.length - 1
            ? "Incomplete final source record omitted"
            : "Malformed source record omitted",
        )
        continue
      }
      if (!record || typeof record !== "object" || Array.isArray(record))
        throw new Error("Invalid foreign record")
      const payload = object(record.payload) ? record.payload : {},
        message = object(record.message) ? record.message : {}
      if (vendor === "codex") {
        if (record.type === "session_meta") {
          if (
            typeof payload.id === "string" &&
            idPattern.test(payload.id) &&
            typeof payload.cwd === "string"
          ) {
            if (sourceId && sourceId !== payload.id) throw new Error("Foreign file mixes session identities")
            id = sourceId = payload.id
            cwd = payload.cwd
            known++
            native = true
            schema = "codex-rollout-session-meta-v1"
          }
        } else if (
          record.type === "response_item" &&
          payload.type === "message" &&
          (payload.role === "user" || payload.role === "assistant")
        ) {
          const value = textContent(payload.content)
          if (value) messages.push({ role: payload.role, content: [{ type: "text", text: value }] })
        } else warnings.add("Unsupported rollout records, tool payloads and reasoning omitted")
      } else {
        if (typeof record.sessionId === "string" && idPattern.test(record.sessionId)) {
          if (sourceId && sourceId !== record.sessionId)
            throw new Error("Foreign file mixes session identities")
          id = sourceId = record.sessionId
          if (typeof record.cwd === "string") cwd = record.cwd
        }
        if ((record.type === "user" || record.type === "assistant") && object(record.message)) {
          if (record.isSidechain === true) {
            warnings.add("Sidechain records omitted")
            continue
          }
          const value = textContent(message.content)
          if (value) messages.push({ role: record.type, content: [{ type: "text", text: value }] })
          known++
          schema = "claude-message-jsonl-v1"
        } else warnings.add("Unsupported Claude records, tool payloads and reasoning omitted")
        native = Boolean(sourceId && cwd)
      }
    }
    if (!known || !schema) throw new Error(`Unsupported ${vendor} session schema`)
  }
  if (!idPattern.test(id) || cwd.length > 4096) throw new Error("Invalid foreign session identity")
  const sanitized = portableContext(messages, cwd, {}, warnings)
  return {
    vendor,
    id,
    path,
    cwd,
    title: safeSessionText(
      textContent(sanitized.find((message) => message.role === "user")?.content) || basename(path),
    ).slice(0, 120),
    schema,
    sha256: hash,
    messages: sanitized,
    warnings: [...warnings],
    ownerResume: native,
  }
}
export async function discoverForeign(root: string, vendor: ForeignVendor) {
  root = canonicalRoot(root)
  directory(root)
  const sessions: ForeignSession[] = [],
    warnings: string[] = [],
    databases: Array<{ path: string; schema: string; tables: string[] }> = [],
    paths: string[] = []
  let entries = 0
  const walk = (path: string, depth: number) => {
    if (depth > 6) {
      warnings.push("Discovery depth limit reached")
      return
    }
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (++entries > 2000) {
        warnings.push("Discovery entry limit reached")
        return
      }
      const full = join(path, entry.name)
      if (entry.isSymbolicLink()) {
        warnings.push(`${relative(root, full)}: symlink excluded`)
        continue
      }
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (
        entry.isFile() &&
        (/\.jsonl$/.test(entry.name) ||
          (vendor === "cursor" && /\.md$/.test(entry.name)) ||
          /(?:\.db|\.sqlite|\.vscdb)$/.test(entry.name))
      )
        paths.push(full)
      if (paths.length >= 200) {
        warnings.push("Discovery candidate limit reached")
        return
      }
    }
  }
  walk(root, 0)
  for (const path of paths.slice(0, 200)) {
    try {
      if (/\.(?:db|sqlite|vscdb)$/.test(path)) {
        const snapshot = await readForeignDatabase(root, path)
        databases.push({ path, schema: snapshot.schema, tables: snapshot.tables })
        if (vendor === "codex" && snapshot.schema === "codex-threads-v1")
          for (const row of snapshot.rows) {
            const session = readForeignSession(root, row.rollout_path, vendor)
            if (session.id !== row.id || session.cwd !== row.cwd) {
              warnings.push(`${relative(root, path)}: metadata/rollout identity mismatch`)
              continue
            }
            if (!sessions.some((item) => item.id === session.id)) sessions.push(session)
          }
        else
          warnings.push(
            `${relative(root, path)}: native schema is inspection-only; convert a supported conversation export`,
          )
        if (snapshot.truncated) warnings.push(`${relative(root, path)}: database row limit reached`)
      } else {
        const session = readForeignSession(root, path, vendor)
        if (!sessions.some((item) => item.id === session.id)) sessions.push(session)
      }
    } catch (error) {
      warnings.push(
        `${safeSessionText(relative(root, path))}: ${safeSessionText(error instanceof Error ? error.message : String(error))}`,
      )
    }
  }
  return { root, vendor, sessions, databases, warnings: [...new Set(warnings)].slice(0, 200) }
}
export function convertForeign(session: ForeignSession): PortableSession {
  const context = session.messages,
    hash = digest(JSON.stringify(context)),
    key = digest(`foreign-node:${session.sha256}`),
    id = `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`
  return envelope({
    source: { engine: session.vendor, sessionId: session.id, cwd: session.cwd },
    title: session.title,
    exportedAt: new Date(0).toISOString(),
    head: id,
    nodes: [
      {
        id,
        kind: "base",
        label: "Converted foreign evidence",
        created: new Date(0).toISOString(),
        usage: {},
        context: hash,
      },
    ],
    contexts: { [hash]: context },
    omissions: [
      ...session.warnings,
      "Converted evidence only; no vendor tools, grants, jobs, checkpoints or native execution state",
    ],
    converted: true,
    redacted: false,
  })
}
export function ownerResumeCommand(session: ForeignSession): { command: string[]; cwd: string } {
  if (
    !session.ownerResume ||
    session.vendor === "cursor" ||
    !idPattern.test(session.id) ||
    !isAbsolute(session.cwd)
  )
    throw new Error("This source has no verified native owner resume; use explicit conversion")
  const home =
    session.vendor === "codex"
      ? (process.env.CODEX_HOME ?? join(homedir(), ".codex"))
      : (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"))
  const root = canonicalRoot(join(home, session.vendor === "codex" ? "sessions" : "projects"))
  const path = hostPath(resolve(session.path)),
    rel = relative(root, path)
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel))
    throw new Error(
      "Source is outside the owning CLI's configured history root; convert this backup or select a registered native session",
    )
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(session.id))
    throw new Error(
      "Native handoff requires a session UUID; name-based lookup could select different history",
    )
  const binary = Bun.which(session.vendor)
  if (!binary) throw new Error(`${session.vendor} CLI is not installed`)
  return {
    command:
      session.vendor === "codex"
        ? [binary, "resume", session.id, "--cd", session.cwd]
        : [binary, "--resume", session.id],
    cwd: session.cwd,
  }
}
