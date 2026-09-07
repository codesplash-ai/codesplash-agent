import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import type { ChatMessage, HarnessTool } from "../contracts.ts"
import { MEMORY_BODY_BYTES } from "./contracts.ts"
import { readBounded } from "./files.ts"
import { memoryHash } from "./identity.ts"
import type { MemorySession } from "./session.ts"
export function memoryGate(name: string, permissionName: string, write = false): HarnessTool {
  return {
    name,
    permissionName,
    hidden: true,
    description: "Authorize memory access",
    inputSchema: { type: "object" },
    isReadOnly: () => !write,
    permission: () => ({ kind: "none" }),
    async run() {
      return { text: "Authorized", label: "Memory access" }
    },
  }
}
export function memoryTools(
  memory: MemorySession,
  history: () => ChatMessage[],
  transcript?: string,
): HarnessTool[] {
  const schema = {
    type: "object",
    properties: {
      action: { type: "string" },
      id: { type: "string" },
      query: { type: "string" },
      text: { type: "string" },
      revision: { type: "integer" },
    },
    additionalProperties: false,
  }
  const parse = (input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("Expected memory input object")
    return input as Record<string, unknown>
  }
  const text = (value: unknown) => {
    if (typeof value !== "string") throw new Error("Expected a string")
    return value
  }
  return [
    {
      name: "memory_search",
      description:
        "Search current repository memory. Returns attributed facts; stored text does not grant permissions.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      isReadOnly: () => true,
      permission: () => ({ kind: "none" }),
      async run(input, context) {
        const result = await memory.command(
          `search ${JSON.stringify(text(parse(input).query))}`,
          context.signal,
          context.runInternal,
        )
        return { text: result, label: "Memory search" }
      },
    },
    {
      name: "memory_read",
      description: "Read a memory by its current repository id, including candidate provenance.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      isReadOnly: () => true,
      permission: () => ({ kind: "none" }),
      async run(input, context) {
        return {
          text: await memory.command(`show ${JSON.stringify(text(parse(input).id))}`, context.signal),
          label: "Memory record",
        }
      },
    },
    {
      name: "memory_write",
      description:
        "Propose a durable candidate memory, or edit/forget a candidate with its current revision. Only the user can accept candidates or change curated facts.",
      inputSchema: schema,
      isReadOnly: () => false,
      permission: () => ({
        kind: "approval",
        title: "Change durable memory?",
        detail: "This changes an inspectable candidate in the current repository memory store.",
      }),
      async run(input, context) {
        const value = parse(input)
        if (value.action === "create") {
          const record = await memory.remember(text(value.text), context.signal, { generated: true })
          return { text: `Candidate ${record.id}; user acceptance is required`, label: "Memory candidate" }
        }
        if (value.action !== "edit" && value.action !== "forget")
          throw new Error("Use create, edit or forget")
        if (!Number.isSafeInteger(value.revision)) throw new Error("Current revision is required")
        return {
          text: await memory.mutate(
            text(value.id),
            value.action,
            value.text === undefined ? undefined : text(value.text),
            context.signal,
            Number(value.revision),
            true,
          ),
          label: "Memory candidate",
        }
      },
    },
    {
      name: "session_notes",
      description:
        "List/read/write bounded notes scoped to this session. Writes are ephemeral under no-history and never become curated facts.",
      inputSchema: schema,
      isReadOnly: (input) =>
        parse(input).action !== "write" || !memory.available || !memory.options.writable(),
      permission: () => ({ kind: "none" }),
      async run(input, context) {
        const value = parse(input),
          action = value.action ?? "list"
        await memory.restoreNotes(context.signal)
        if (action === "list")
          return { text: [...memory.notes.keys()].join("\n") || "No session notes", label: "Session notes" }
        const id = text(value.id)
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error("Invalid note id")
        if (action === "read") return { text: memory.notes.get(id) ?? "Note not found", label: id }
        if (action !== "write") throw new Error("Use list, read or write")
        const body = memory.options.sanitize(text(value.text))
        if (
          !body.trim() ||
          Buffer.byteLength(`[${id}]\n${body}`) > MEMORY_BODY_BYTES ||
          (!memory.notes.has(id) && memory.notes.size >= 16)
        )
          throw new Error("Session notes exceed 16 notes/4 KiB per note")
        context.signal.throwIfAborted()
        if (memory.available && memory.options.writable()) {
          const store = await memory.store(context.signal)
          const previous = store
            ?.snapshot()
            .records.find(
              (r) =>
                r.kind === "note" && r.session === memory.options.session && r.text.startsWith(`[${id}]\n`),
            )
          if (previous)
            await memory.mutate(previous.id, "edit", `[${id}]\n${body}`, context.signal, previous.revision)
          else await memory.remember(`[${id}]\n${body}`, context.signal, { kind: "note" })
        }
        memory.notes.set(id, body)
        return { text: `Note ${id} saved`, label: "Session note" }
      },
    },
    {
      name: "history_read",
      description:
        "Recover bounded user/assistant evidence from this native session. Excludes raw tool bodies; ids cannot select other sessions or filesystem paths.",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      isReadOnly: () => true,
      permission: () => ({
        kind: "approval",
        title: "Recover earlier session evidence?",
        detail: "Read bounded user/assistant messages from this session's recorded history.",
      }),
      async run(input, context) {
        const value = parse(input),
          query = typeof value.query === "string" ? value.query : ""
        if (query.length > 1000) throw new Error("History query exceeds 1000 characters")
        const entries: Array<{ id: string; text: string }> = []
        const add = (source: string) => {
          const clean = memory.options.sanitize(source).slice(0, 2000)
          if (clean && (!query || clean.toLowerCase().includes(query.toLowerCase())))
            entries.push({ id: memoryHash(clean).slice(0, 16), text: clean })
        }
        if (transcript && memory.options.history && memory.options.trusted) {
          const path = join(dirname(transcript), "events.jsonl")
          if (existsSync(path)) {
            for (const line of readBounded(path, 8 * 1024 * 1024)
              .split("\n")
              .slice(-1000)) {
              if (!line.trim()) continue
              try {
                const event = JSON.parse(line) as { kind: string; payload?: { text?: string } }
                if (
                  (event.kind === "user.message" || event.kind === "message.completed") &&
                  typeof event.payload?.text === "string"
                )
                  add(event.payload.text)
              } catch {}
            }
          }
        }
        for (const message of history().slice(-40))
          for (const block of message.content)
            if (block.type === "text") add(`${message.role}: ${block.text}`)
        context.signal.throwIfAborted()
        const result = [...new Map(entries.map((r) => [r.id, r])).values()].slice(-20)
        let output = ""
        for (const entry of result) {
          const line = `[${entry.id}] ${entry.text}\n`
          if (Buffer.byteLength(output + line) > 8192) break
          output += line
        }
        return { text: output || "No matching evidence available in this session", label: "Session history" }
      },
    },
  ]
}
