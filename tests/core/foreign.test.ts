import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  convertForeign,
  discoverForeign,
  ownerResumeCommand,
  readForeignDatabase,
  readForeignSession,
} from "../../src/core/session/foreign.ts"
import { validatePortable } from "../../src/core/session/portable.ts"

const makeRoot = () => mkdtempSync(join(tmpdir(), "foreign-test-"))
function rollout(root: string, id = "native-session") {
  const path = join(root, "rollout.jsonl")
  writeFileSync(
    path,
    [
      { type: "session_meta", payload: { id, cwd: root, cli_version: "0.147.0" } },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "question" }] },
      },
      {
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  )
  return path
}
test("Codex live-WAL discovery reads private snapshots without changing source DB/WAL/SHM bytes", async () => {
  const root = makeRoot(),
    path = join(root, "state_5.sqlite"),
    db = new Database(path)
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE threads(id TEXT, cwd TEXT, rollout_path TEXT, title TEXT)")
    const log = rollout(root)
    db.query("INSERT INTO threads VALUES (?, ?, ?, ?)").run("native-session", root, log, "Example")
    const snapshots = ["", "-wal", "-shm"]
      .filter((suffix) => existsSync(path + suffix))
      .map((suffix) => [suffix, readFileSync(path + suffix)] as const)
    const inspected = await readForeignDatabase(root, path)
    expect(inspected.schema).toBe("codex-threads-v1")
    expect(inspected.rows[0]?.id).toBe("native-session")
    const found = await discoverForeign(root, "codex")
    expect(found.sessions).toHaveLength(1)
    expect(found.sessions[0]?.messages).toHaveLength(2)
    expect(found.sessions[0]?.ownerResume).toBe(true)
    for (const [suffix, source] of snapshots) expect(readFileSync(path + suffix)).toEqual(source)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
test("foreign readers reject traversal/symlinks and preserve malformed source records", async () => {
  const root = makeRoot(),
    approved = join(root, "approved")
  mkdirSync(approved)
  try {
    const outside = rollout(root)
    expect(() => readForeignSession(approved, outside, "codex")).toThrow("escapes")
    symlinkSync(outside, join(approved, "alias.jsonl"))
    expect(() => readForeignSession(approved, "alias.jsonl", "codex")).toThrow("symlink")
    const path = rollout(approved)
    writeFileSync(path, readFileSync(path, "utf8") + '{"type":')
    const before = readFileSync(path)
    expect(readForeignSession(approved, path, "codex").warnings).toContain(
      "Incomplete final source record omitted",
    )
    expect(readFileSync(path)).toEqual(before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test("Claude message logs and Cursor Markdown convert only supported historical evidence", () => {
  const root = makeRoot()
  try {
    writeFileSync(
      join(root, "claude.jsonl"),
      [
        { type: "user", sessionId: "claude-id", cwd: root, message: { content: "prompt" } },
        {
          type: "assistant",
          sessionId: "claude-id",
          message: {
            content: [
              { type: "thinking", thinking: "private" },
              { type: "text", text: "answer" },
            ],
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    )
    const claude = readForeignSession(root, "claude.jsonl", "claude")
    expect(claude.messages).toHaveLength(2)
    expect(JSON.stringify(claude.messages)).not.toContain("private")
    expect(claude.ownerResume).toBe(true)
    expect(() => ownerResumeCommand(claude)).toThrow("configured history root")
    const content =
      "# Cursor chat\n\n**User**\nquestion\n\n**Cursor**\nanswer\n```\n**User**\nnot a role\n```"
    writeFileSync(join(root, "cursor.md"), content)
    const cursor = readForeignSession(root, "cursor.md", "cursor")
    expect(cursor.ownerResume).toBe(false)
    expect(cursor.messages).toHaveLength(1)
    expect(JSON.stringify(cursor.messages)).toContain("not a role")
    expect(validatePortable(convertForeign(cursor)).payload.converted).toBe(true)
    expect(convertForeign(cursor).sha256).toBe(convertForeign(cursor).sha256)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
