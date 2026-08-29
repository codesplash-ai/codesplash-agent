import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChatMessage } from "../../../src/engines/codesplash/contracts.ts"
import { appendTranscriptMessages, loadTranscript } from "../../../src/engines/codesplash/transcript.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codesplash-transcript-"))
  temporaryDirectories.push(directory)
  return directory
}

function userMessage(text: string): ChatMessage {
  return { role: "user", content: [{ type: "text", text }] }
}

function assistantMessage(text: string): ChatMessage {
  return {
    role: "assistant",
    content: [
      { type: "thinking", text: `thinking about ${text}`, signature: "sig-1" },
      { type: "text", text },
    ],
  }
}

describe("transcript round-trip", () => {
  test("a missing file loads as an empty transcript", async () => {
    const dir = await temporaryDirectory()
    expect(await loadTranscript(join(dir, "absent", "transcript.jsonl"))).toEqual([])
  })

  test("appended messages load back verbatim, thinking blocks included", async () => {
    const dir = await temporaryDirectory()
    const path = join(dir, "transcript.jsonl")
    const first = [userMessage("hello"), assistantMessage("hi")]
    const second = [
      userMessage("again"),
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "call-1", name: "read_file", input: { path: "a.ts" } }],
      } satisfies ChatMessage,
      {
        role: "user",
        content: [{ type: "tool_result", toolCallId: "call-1", text: "contents" }],
      } satisfies ChatMessage,
    ]

    await appendTranscriptMessages(path, first)
    await appendTranscriptMessages(path, second)

    expect(await loadTranscript(path)).toEqual([...first, ...second])
  })

  test("append creates parent directories and writes one { v: 1, message } JSONL line per message", async () => {
    const dir = await temporaryDirectory()
    const path = join(dir, "nested", "deeper", "transcript.jsonl")
    await appendTranscriptMessages(path, [userMessage("one"), assistantMessage("two")])

    const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line.length > 0)
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      const parsed = JSON.parse(line) as { v: number; message: ChatMessage }
      expect(parsed.v).toBe(1)
      expect(["user", "assistant"]).toContain(parsed.message.role)
    }
  })

  test("appending zero messages writes nothing and creates no file", async () => {
    const dir = await temporaryDirectory()
    const path = join(dir, "transcript.jsonl")
    await appendTranscriptMessages(path, [])
    expect(await Bun.file(path).exists()).toBe(false)
  })
})

describe("transcript healing", () => {
  test("a torn final line is dropped on load without losing earlier messages", async () => {
    const dir = await temporaryDirectory()
    const path = join(dir, "transcript.jsonl")
    await appendTranscriptMessages(path, [userMessage("kept")])
    const torn = JSON.stringify({ v: 1, message: userMessage("torn") }).slice(0, 20)
    await writeFile(path, torn, { flag: "a" })

    expect(await loadTranscript(path)).toEqual([userMessage("kept")])
  })

  test("append after a torn final line truncates the torn bytes so the file stays valid", async () => {
    const dir = await temporaryDirectory()
    const path = join(dir, "transcript.jsonl")
    await appendTranscriptMessages(path, [userMessage("kept")])
    await writeFile(path, '{"v":1,"message":{"role":"us', { flag: "a" })

    await appendTranscriptMessages(path, [assistantMessage("after crash")])

    expect(await loadTranscript(path)).toEqual([userMessage("kept"), assistantMessage("after crash")])
    const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line.length > 0)
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  })

  test("a parseable final line that only lost its newline is terminated, not discarded", async () => {
    const dir = await temporaryDirectory()
    const path = join(dir, "transcript.jsonl")
    await writeFile(path, JSON.stringify({ v: 1, message: userMessage("unterminated") }))

    expect(await loadTranscript(path)).toEqual([userMessage("unterminated")])
    await appendTranscriptMessages(path, [assistantMessage("next")])
    expect(await loadTranscript(path)).toEqual([userMessage("unterminated"), assistantMessage("next")])
  })

  test("corrupt interior lines are skipped without discarding intact messages after them", async () => {
    const dir = await temporaryDirectory()
    const path = join(dir, "transcript.jsonl")
    await writeFile(
      path,
      [
        JSON.stringify({ v: 1, message: userMessage("one") }),
        "{ not json",
        JSON.stringify({ v: 2, message: userMessage("wrong version") }),
        JSON.stringify({ v: 1, message: { role: "narrator", content: [] } }),
        JSON.stringify({ v: 1, message: userMessage("two") }),
        "",
      ].join("\n"),
    )

    expect(await loadTranscript(path)).toEqual([userMessage("one"), userMessage("two")])
  })

  test("an empty file is a fresh transcript and appends cleanly", async () => {
    const dir = await temporaryDirectory()
    const path = join(dir, "transcript.jsonl")
    await writeFile(path, "")
    expect(await loadTranscript(path)).toEqual([])
    await appendTranscriptMessages(path, [userMessage("first")])
    expect(await loadTranscript(path)).toEqual([userMessage("first")])
  })
})
