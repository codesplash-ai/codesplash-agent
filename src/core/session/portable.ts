import { closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import type { ChatMessage, ContentBlock } from "../../engines/codesplash/contracts.ts"
import { writeTranscriptSnapshot } from "../../engines/codesplash/transcript.ts"
import { createAgentEvent } from "../events.ts"
import { redactSensitiveText } from "../redaction.ts"
import {
  projectIdFor,
  readSessionEvents,
  readSessionMeta,
  type SessionMeta,
  SessionStore,
} from "../sessions.ts"
import { type BranchNode, BranchStore, validNativeContext } from "./branches.ts"
import { invalidateSession } from "./changes.ts"
import { control } from "./control.ts"
import { bytes, canonicalRoot, digest, directory, lease } from "./files.ts"
import { inheritedUsage } from "./fork.ts"
import { SafeParent } from "./secure-path.ts"

const LIMIT = 64 * 1024 * 1024
const HASH = /^[a-f0-9]{64}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
export type PortableNode = Pick<BranchNode, "id" | "parent" | "label" | "created" | "kind" | "usage"> & {
  context: string
}
export type PortablePayload = {
  source: { engine: "codesplash" | "codex" | "claude" | "cursor"; sessionId: string; cwd: string }
  title: string
  exportedAt: string
  head: string
  nodes: PortableNode[]
  contexts: Record<string, ChatMessage[]>
  omissions: string[]
  converted: boolean
  redacted: boolean
}
export type PortableSession = {
  format: "codesplash-session"
  version: 1
  sha256: string
  payload: PortablePayload
}
export type ExportOptions = { all?: boolean; redact?: boolean; images?: boolean }

function cleaner(cwd: string, share: boolean, priorDirectories: readonly string[] = []) {
  const paths = [...new Set([cwd, ...priorDirectories])]
    .filter((path) => path.length > 1)
    .sort((a, b) => b.length - a.length)
  const pattern = paths.length
    ? new RegExp(paths.map((path) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
    : undefined
  return (text: string): string => {
    let result = redactSensitiveText(text)
    // Retain newlines/tabs, but terminal controls cannot become executable display content.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: remove unsafe display controls
    result = result.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
    if (share) {
      if (pattern) result = result.replace(pattern, "[workspace]")
      for (const [path, replacement] of [
        [cwd, "[workspace]"],
        [homedir(), "[home]"],
      ])
        if (path && path.length > 1) result = result.split(path).join(replacement as string)
      result = result.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
      result = result.replace(/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s"'<>]+/g, "[private-path]")
    }
    return result
  }
}
function cleanValue(value: unknown, clean: (text: string) => string, depth = 0): unknown {
  if (depth > 24) throw new Error("Portable tool input nesting exceeds 24 levels")
  if (typeof value === "string") return clean(value)
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
    return value
  if (Array.isArray(value)) return value.map((item) => cleanValue(item, clean, depth + 1))
  if (!value || typeof value !== "object") throw new Error("Portable tool inputs must be JSON values")
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /(?:password|secret|api.?key|access.?token|refresh.?token|authorization|cookie)/i.test(key)
        ? "[REDACTED]"
        : cleanValue(item, clean, depth + 1),
    ]),
  )
}
function imageBytes(block: Extract<ContentBlock, { type: "image" }>): number {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(block.base64Data) ||
    block.base64Data.length > 12 * 1024 * 1024
  )
    throw new Error("Invalid portable image encoding")
  const value = Buffer.from(block.base64Data, "base64")
  const type = value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : value[0] === 255 && value[1] === 216 && value[2] === 255
      ? "image/jpeg"
      : ["GIF87a", "GIF89a"].includes(value.subarray(0, 6).toString())
        ? "image/gif"
        : value.subarray(0, 4).toString() === "RIFF" && value.subarray(8, 12).toString() === "WEBP"
          ? "image/webp"
          : undefined
  if (!type || type !== block.mediaType || value.length > 8 * 1024 * 1024)
    throw new Error("Portable image signature/MIME/size mismatch")
  return value.length
}
export function portableContext(
  messages: ChatMessage[],
  cwd: string,
  options: ExportOptions,
  omissions: Set<string>,
  priorDirectories: readonly string[] = [],
): ChatMessage[] {
  if (!validNativeContext(messages)) throw new Error("Only complete provider exchanges can be exported")
  const clean = cleaner(cwd, Boolean(options.redact), priorDirectories)
  let images = 0
  return messages.map((message) => ({
    role: message.role,
    content: message.content.flatMap((block): ContentBlock[] => {
      switch (block.type) {
        case "thinking":
        case "redacted_thinking":
        case "provider_item":
          omissions.add("Provider reasoning, signatures and opaque thinking blocks omitted")
          return []
        case "text":
          return [{ type: "text", text: clean(block.text) }]
        case "tool_call":
          return [
            { type: "tool_call", id: block.id, name: block.name, input: cleanValue(block.input, clean) },
          ]
        case "tool_result":
          return [
            {
              type: "tool_result",
              toolCallId: block.toolCallId,
              text: clean(block.text),
              ...(block.isError === undefined ? {} : { isError: block.isError }),
            },
          ]
        case "image":
          if (!options.images || options.redact) {
            omissions.add("Images omitted; external attachment paths were not read")
            return [{ type: "text", text: "[Image omitted from portable history]" }]
          }
          images += imageBytes(block)
          if (images > 16 * 1024 * 1024) throw new Error("Embedded images exceed 16 MiB")
          return [{ type: "image", mediaType: block.mediaType, base64Data: block.base64Data }]
      }
      throw new Error("Unsupported portable block")
    }),
  }))
}
export function envelope(payload: PortablePayload): PortableSession {
  const result: PortableSession = {
    format: "codesplash-session",
    version: 1,
    sha256: digest(JSON.stringify(payload)),
    payload,
  }
  if (Buffer.byteLength(JSON.stringify(result)) > LIMIT) throw new Error("Portable session exceeds 64 MiB")
  return result
}

export async function exportPortable(
  branches: BranchStore,
  meta: SessionMeta,
  options: ExportOptions = {},
): Promise<PortableSession> {
  if (branches.state.directory) meta = (await readSessionMeta(branches.state.directory)) ?? meta
  const view = branches.view(),
    priorDirectories = view.nodes.flatMap((node) => (node.cwd ? [node.cwd] : [])),
    clean = cleaner(meta.projectPath, Boolean(options.redact), priorDirectories),
    omissions = new Set<string>([
      "Permissions, trust, input queues, jobs, repository memory and file checkpoints are not portable",
      "External tool-output files are not included",
    ]),
    contexts: PortablePayload["contexts"] = {},
    nodes: PortableNode[] = []
  let selected = options.all ? view.nodes : view.head ? branches.ancestry() : []
  const evidence = branches.state.directory ? (await readSessionEvents(branches.state.directory)).events : []
  let converted = meta.engine !== "codesplash"
  if (!selected.length) {
    selected = [
      {
        id: crypto.randomUUID(),
        kind: "base",
        label: "Converted visible history",
        created: meta.createdAt,
        usage: {},
        eventSequence: meta.lastSequence,
      },
    ]
    converted = true
  }
  for (const node of selected) {
    let messages: ChatMessage[]
    if (node.context) messages = branches.context(node.id)
    else {
      if (!branches.state.directory)
        throw new Error("This provider's ephemeral session has no retained visible evidence to export")
      const ancestry = view.nodes.length ? branches.ancestry(node.id) : [node]
      messages = evidence
        .filter((event) =>
          ancestry.some(
            (boundary) =>
              event.sequence >= (boundary.eventStart ?? 0) &&
              event.sequence <= boundary.eventSequence &&
              (!boundary.evidenceTurnIds ||
                (!!event.native?.turnId && boundary.evidenceTurnIds.includes(event.native.turnId))),
          ),
        )
        .flatMap((event): ChatMessage[] =>
          event.kind === "user.message"
            ? [{ role: "user", content: [{ type: "text", text: event.payload.text }] }]
            : event.kind === "message.completed" && event.payload.text
              ? [{ role: "assistant", content: [{ type: "text", text: event.payload.text }] }]
              : [],
        )
      omissions.add("Visible evidence converted to native conversation text; vendor state is unavailable")
      converted = true
    }
    const context = portableContext(messages, meta.projectPath, options, omissions, priorDirectories),
      hash = digest(JSON.stringify(context))
    contexts[hash] = context
    nodes.push({
      id: node.id,
      parent: node.parent,
      kind: node.kind,
      created: node.created,
      label: clean(node.label),
      usage: inheritedUsage(node.inheritedUsage ?? view.origin?.inheritedUsage ?? {}, node.usage),
      context: hash,
    })
  }
  if (branches.view().revision !== view.revision)
    throw new Error("Session changed while exporting; retry from a settled boundary")
  const payload: PortablePayload = {
    source: {
      engine: meta.engine,
      sessionId: meta.localSessionId,
      cwd: options.redact ? "[workspace]" : clean(meta.projectPath),
    },
    title: clean(meta.title ?? "Imported session"),
    exportedAt: new Date().toISOString(),
    head: view.head ?? (nodes.at(-1) as PortableNode).id,
    nodes,
    contexts,
    omissions: [...omissions],
    converted,
    redacted: Boolean(options.redact),
  }
  return validatePortable(envelope(payload))
}

/** Validate before copying any untrusted field into canonical state. Extra authority is rejected. */
export function validatePortable(value: unknown): PortableSession {
  if (!value || typeof value !== "object" || Buffer.byteLength(JSON.stringify(value)) > LIMIT)
    throw new Error("Invalid or oversized portable session")
  const bundle = value as PortableSession,
    p = bundle.payload
  if (
    bundle.format !== "codesplash-session" ||
    bundle.version !== 1 ||
    !p ||
    !HASH.test(bundle.sha256) ||
    digest(JSON.stringify(p)) !== bundle.sha256
  )
    throw new Error("Unsupported portable format or checksum mismatch")
  if (
    !p.source ||
    !["codesplash", "codex", "claude", "cursor"].includes(p.source.engine) ||
    typeof p.source.sessionId !== "string" ||
    !/^[a-zA-Z0-9._-]{1,256}$/.test(p.source.sessionId) ||
    typeof p.source.cwd !== "string" ||
    p.source.cwd.length > 4096 ||
    typeof p.title !== "string" ||
    p.title.length > 200 ||
    !Number.isFinite(Date.parse(p.exportedAt)) ||
    typeof p.converted !== "boolean" ||
    typeof p.redacted !== "boolean" ||
    !Array.isArray(p.nodes) ||
    !p.nodes.length ||
    p.nodes.length > 1000 ||
    !p.contexts ||
    typeof p.contexts !== "object" ||
    Array.isArray(p.contexts) ||
    !Array.isArray(p.omissions) ||
    p.omissions.length > 100 ||
    p.omissions.some((item) => typeof item !== "string" || item.length > 1000) ||
    Object.keys(p).some(
      (key) =>
        ![
          "source",
          "title",
          "exportedAt",
          "head",
          "nodes",
          "contexts",
          "omissions",
          "converted",
          "redacted",
        ].includes(key),
    )
  )
    throw new Error("Invalid portable metadata")
  const ids = new Set<string>(),
    refs = new Set<string>()
  for (const node of p.nodes) {
    if (
      !node ||
      !UUID.test(node.id) ||
      ids.has(node.id) ||
      (node.parent !== undefined && !ids.has(node.parent)) ||
      !["base", "turn", "before-compaction", "compaction", "fork"].includes(node.kind) ||
      !HASH.test(node.context) ||
      typeof node.label !== "string" ||
      node.label.length > 200 ||
      !Number.isFinite(Date.parse(node.created)) ||
      !node.usage ||
      typeof node.usage !== "object" ||
      Array.isArray(node.usage) ||
      Object.entries(node.usage).some(
        ([key, value]) =>
          ![
            "inputTokens",
            "outputTokens",
            "cachedInputTokens",
            "estimatedCostUsd",
            "hasUnpricedUsage",
            "embeddingInputTokens",
          ].includes(key) ||
          (key === "hasUnpricedUsage"
            ? typeof value !== "boolean"
            : typeof value !== "number" || !Number.isFinite(value) || value < 0),
      )
    )
      throw new Error("Invalid portable branch node")
    ids.add(node.id)
    refs.add(node.context)
  }
  if (!ids.has(p.head) || Object.keys(p.contexts).length !== refs.size)
    throw new Error("Invalid portable head or context references")
  let totalImages = 0
  for (const [hash, messages] of Object.entries(p.contexts)) {
    if (!refs.has(hash) || digest(JSON.stringify(messages)) !== hash || !validNativeContext(messages))
      throw new Error("Invalid portable context or checksum")
    for (const message of messages)
      for (const block of message.content) {
        if (block.type === "image") totalImages += imageBytes(block)
        if (block.type === "tool_call") cleanValue(block.input, (value) => value)
      }
  }
  if (totalImages > 16 * 1024 * 1024) throw new Error("Portable images exceed 16 MiB")
  return bundle
}
export function readPortable(path: string): PortableSession {
  return validatePortable(JSON.parse(bytes(path, LIMIT).toString()))
}
export function renderPortable(bundle: PortableSession, format: "json" | "markdown" | "html"): string {
  validatePortable(bundle)
  const bounded = (text: string) => {
    if (Buffer.byteLength(text) > LIMIT)
      throw new Error("Rendered export exceeds 64 MiB; select fewer branches or use compact JSON")
    return text
  }
  if (format === "json") return bounded(`${JSON.stringify(bundle, null, 2)}\n`)
  const p = bundle.payload,
    lines = [
      `# ${p.title}`,
      "",
      `Source: ${p.source.engine} · ${p.converted ? "converted evidence" : "sanitized native history"}`,
      "",
      ...p.omissions.map((value) => `- ${value}`),
    ]
  const rendered = new Set<string>()
  for (const node of p.nodes) {
    lines.push(
      "",
      `## ${node.id === p.head ? "Selected: " : ""}${node.label}`,
      `Boundary ${node.id}; parent ${node.parent ?? "root"}`,
      "",
    )
    if (rendered.has(node.context)) {
      lines.push(`Context ${node.context} is printed at an earlier boundary.`)
      continue
    }
    rendered.add(node.context)
    for (const message of p.contexts[node.context] ?? []) {
      lines.push(`### ${message.role}`, "")
      for (const block of message.content)
        lines.push(
          block.type === "text"
            ? block.text
            : block.type === "tool_result"
              ? `[Historical tool result ${block.toolCallId}]\n${block.text}`
              : block.type === "tool_call"
                ? `[Historical tool ${block.name}: ${JSON.stringify(block.input)}]`
                : "[Image omitted from reading format]",
        )
      lines.push("")
    }
  }
  const text = bounded(lines.join("\n"))
  if (format === "markdown") {
    let length = 3
    for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1)
    const fence = "`".repeat(length)
    return bounded(`# Session export\n\n${fence}text\n${text}\n${fence}\n`)
  }
  const escapeHtml = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
  return bounded(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width"><title>${escapeHtml(p.title)}</title><style>body{max-width:90ch;margin:3rem auto;padding:0 1rem;font:16px/1.6 system-ui;background:#fafafa;color:#171717}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><body><pre>${escapeHtml(text)}</pre></body></html>\n`,
  )
}
export function writePortable(path: string, source: string): void {
  const root = canonicalRoot(dirname(path))
  if (
    [...root.split("/"), basename(path)].some((part) =>
      [".git", ".codex", ".claude", ".agents", ".codesplash"].includes(part),
    )
  )
    throw new Error("Export destination cannot be a Git or harness control path")
  const parent = SafeParent.open(root, basename(path))
  if (!parent) throw new Error("Export parent does not exist")
  try {
    parent.write(parent.file, Buffer.from(source), 0o600)
    parent.sync()
  } finally {
    parent.close()
  }
}

export function importIdentity(bundle: PortableSession, cwd: string): string {
  const hash = digest(`codesplash-portable-v1\0${bundle.sha256}\0${canonicalRoot(cwd)}`)
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}
export async function importPortable(root: string, bundle: PortableSession, cwd: string, apply = false) {
  validatePortable(bundle)
  cwd = canonicalRoot(cwd)
  directory(cwd)
  if (!statSync(cwd).isDirectory()) throw new Error("Import destination must be an existing directory")
  const id = importIdentity(bundle, cwd),
    projectId = projectIdFor(cwd),
    target = join(root, projectId, id)
  const cleanPreview = cleaner(bundle.payload.source.cwd, bundle.payload.redacted)
  if (!apply)
    return {
      source: {
        engine: bundle.payload.source.engine,
        sessionId: bundle.payload.source.sessionId,
        cwd: cleanPreview(bundle.payload.source.cwd),
      },
      title: cleanPreview(bundle.payload.title),
      branches: bundle.payload.nodes.length,
      omissions: bundle.payload.omissions.map(cleanPreview),
      converted: bundle.payload.converted,
      destination: cwd,
      localSessionId: id,
      duplicate: existsSync(target),
      sha256: bundle.sha256,
      apply: "Use --apply after reviewing this sanitized native-history import",
    }
  directory(join(root, ".imports"), true)
  const release = lease(join(root, ".imports")),
    stage = join(root, ".import-staging", crypto.randomUUID())
  try {
    if (existsSync(target)) {
      if (
        (control(target).state.values.imported as { sha256?: string } | undefined)?.sha256 !== bundle.sha256
      )
        throw new Error("Import identity collision")
      return { duplicate: true, meta: await readSessionMeta(target) }
    }
    const now = new Date().toISOString(),
      clean = cleaner(bundle.payload.source.cwd, bundle.payload.redacted)
    const meta: SessionMeta = {
      schemaVersion: 2,
      engine: "codesplash",
      localSessionId: id,
      nativeSessionId: id,
      projectId,
      projectPath: cwd,
      title: clean(bundle.payload.title).slice(0, 200),
      createdAt: now,
      updatedAt: now,
      lastStatus: "closed",
      lastSequence: -1,
    }
    const handle = await new SessionStore(stage).create(meta)
    handle.acquire()
    try {
      const branches = new BranchStore(handle.state),
        remap = new Map<string, string>(),
        messagesByNode = new Map<string, ChatMessage[]>()
      let sequence = 0
      for (const node of bundle.payload.nodes) {
        const messages = portableContext(
          bundle.payload.contexts[node.context] as ChatMessage[],
          bundle.payload.source.cwd,
          { images: true, redact: bundle.payload.redacted },
          new Set(),
        )
        messagesByNode.set(node.id, messages)
        const parentMessages = node.parent ? (messagesByNode.get(node.parent) ?? []) : []
        let common = 0
        while (
          common < messages.length &&
          common < parentMessages.length &&
          JSON.stringify(messages[common]) === JSON.stringify(parentMessages[common])
        )
          common++
        const start = sequence,
          lines: string[] = []
        for (const message of messages.slice(common)) {
          const text = message.content
            .flatMap((block) =>
              block.type === "text"
                ? [block.text]
                : block.type === "tool_result"
                  ? [`[Historical tool result] ${block.text}`]
                  : [],
            )
            .join("\n")
          if (!text) continue
          const event = createAgentEvent(
            { engine: "codesplash", localSessionId: id, sequence: sequence++ },
            message.role === "user"
              ? { kind: "user.message", payload: { id: crypto.randomUUID(), text } }
              : { kind: "message.completed", payload: { id: crypto.randomUUID(), text } },
          )
          lines.push(JSON.stringify(event))
        }
        await handle.appendEventLines(lines)
        const created = branches.capture({
          kind: node.kind,
          parent: node.parent ? remap.get(node.parent) : undefined,
          label: clean(node.label),
          messages,
          eventStart: start,
          eventSequence: sequence - 1,
          usage: {},
          inheritedUsage: node.usage,
          cwd,
        })
        remap.set(node.id, created.id)
      }
      const head = remap.get(bundle.payload.head) as string
      if (branches.view().head !== head) {
        branches.prepareSwitch(head, branches.view().revision)
        branches.finishSwitch()
      }
      await writeTranscriptSnapshot(join(handle.directory, "transcript.jsonl"), branches.context(head))
      handle.state.update(handle.state.read().revision, "portable/import", (state) => {
        state.values.imported = {
          version: 1,
          sha256: bundle.sha256,
          source: {
            engine: bundle.payload.source.engine,
            sessionId: bundle.payload.source.sessionId,
            cwd: clean(bundle.payload.source.cwd),
          },
          converted: bundle.payload.converted,
          omissions: bundle.payload.omissions.map(clean),
          inheritedUsage: bundle.payload.nodes.find((node) => node.id === bundle.payload.head)?.usage ?? {},
        }
      })
      await handle.updateMeta({ lastSequence: sequence - 1, lastStatus: "closed" })
      directory(dirname(target), true)
      handle.release()
      invalidateSession(target)
      renameSync(handle.directory, target)
      const fd = openSync(dirname(target), "r")
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      return { duplicate: false, meta: await readSessionMeta(target) }
    } finally {
      handle.release()
    }
  } finally {
    release()
    rmSync(stage, { recursive: true, force: true })
  }
}
