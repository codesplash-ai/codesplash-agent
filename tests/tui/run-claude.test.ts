import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listProjectSessions, projectIdFor, SessionStore } from "../../src/core/index.ts"
import { ClaudeDriver } from "../../src/engines/claude/index.ts"
import {
  claudeLaunchArgs,
  claudeStatusForExit,
  createClaudeSessionMeta,
  runClaudeHandoffSession,
} from "../../src/tui/run-claude.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

/** A stand-in `claude` binary that records its argv and exits with a fixed code. */
async function writeFakeClaude(
  directory: string,
  exitCode: number,
): Promise<{ binary: string; argsFile: string }> {
  const argsFile = join(directory, "args.txt")
  const binary = join(directory, "fake-claude")
  await writeFile(binary, `#!/bin/sh\necho "$@" >> "${argsFile}"\nexit ${exitCode}\n`)
  await chmod(binary, 0o755)
  return { binary, argsFile }
}

describe("claude launch surface", () => {
  test("builds only documented CLI flags for launch and resume", () => {
    expect(claudeLaunchArgs("uuid-1", false)).toEqual(["--session-id", "uuid-1"])
    expect(claudeLaunchArgs("uuid-1", true)).toEqual(["--resume", "uuid-1"])
  })

  test("maps exit codes to terminal session statuses", () => {
    expect(claudeStatusForExit(0)).toBe("closed")
    expect(claudeStatusForExit(1)).toBe("failed")
    expect(claudeStatusForExit(130)).toBe("failed")
  })

  test("creates launch metadata with no Codex policy fields and no event log", () => {
    const meta = createClaudeSessionMeta(
      { cwd: "/canonical/claude-project" },
      "uuid-9",
      "2026-08-16T00:00:00.000Z",
    )
    expect(meta.engine).toBe("claude")
    expect(meta.nativeSessionId).toBe("uuid-9")
    expect(meta.projectId).toBe(projectIdFor("/canonical/claude-project"))
    expect(meta.sandbox).toBeUndefined()
    expect(meta.approvalPolicy).toBeUndefined()
    expect(meta.lastSequence).toBe(-1)
  })

  test("records a launch, passes --session-id, and marks a clean exit closed", async () => {
    const root = await temporaryDirectory("codesplash-agent-claude-")
    const binDir = await temporaryDirectory("codesplash-agent-claude-bin-")
    const { binary, argsFile } = await writeFakeClaude(binDir, 0)
    const store = new SessionStore(root)
    const project = { cwd: root }

    const exitCode = await runClaudeHandoffSession({
      driver: new ClaudeDriver({ binary }),
      store,
      project,
    })
    expect(exitCode).toBe(0)

    const sessions = await listProjectSessions(projectIdFor(project.cwd), root)
    expect(sessions).toHaveLength(1)
    const meta = sessions[0]
    expect(meta?.engine).toBe("claude")
    expect(meta?.lastStatus).toBe("closed")
    expect(meta?.title).toBe("Claude Code session")

    const recordedArgs = (await readFile(argsFile, "utf8")).trim()
    expect(recordedArgs).toBe(`--session-id ${meta?.nativeSessionId}`)
    // Launch metadata only: the handoff never records terminal output.
    expect(
      await Bun.file(join(root, meta?.projectId ?? "", meta?.localSessionId ?? "", "events.jsonl")).exists(),
    ).toBe(false)
  })

  test("resumes with --resume against the stored native session ID", async () => {
    const root = await temporaryDirectory("codesplash-agent-claude-")
    const binDir = await temporaryDirectory("codesplash-agent-claude-bin-")
    const { binary, argsFile } = await writeFakeClaude(binDir, 0)
    const store = new SessionStore(root)
    const project = { cwd: root }
    const driver = new ClaudeDriver({ binary })

    await runClaudeHandoffSession({ driver, store, project })
    const [meta] = await listProjectSessions(projectIdFor(project.cwd), root)
    if (!meta) throw new Error("Expected a recorded Claude session")

    await runClaudeHandoffSession({ driver, store, project, resume: meta })

    const lines = (await readFile(argsFile, "utf8")).trim().split("\n")
    expect(lines).toEqual([`--session-id ${meta.nativeSessionId}`, `--resume ${meta.nativeSessionId}`])
    const [after] = await listProjectSessions(projectIdFor(project.cwd), root)
    expect(after?.lastStatus).toBe("closed")
    expect(after?.localSessionId).toBe(meta.localSessionId)
  })

  test("marks a non-zero exit failed and surfaces the exit code", async () => {
    const root = await temporaryDirectory("codesplash-agent-claude-")
    const binDir = await temporaryDirectory("codesplash-agent-claude-bin-")
    const { binary } = await writeFakeClaude(binDir, 3)
    const store = new SessionStore(root)
    const project = { cwd: root }

    const exitCode = await runClaudeHandoffSession({
      driver: new ClaudeDriver({ binary }),
      store,
      project,
    })
    expect(exitCode).toBe(3)

    const [meta] = await listProjectSessions(projectIdFor(project.cwd), root)
    expect(meta?.lastStatus).toBe("failed")
  })

  test("refuses to resume a session without a native session ID", async () => {
    const root = await temporaryDirectory("codesplash-agent-claude-")
    const store = new SessionStore(root)
    const project = { cwd: root }
    const meta = createClaudeSessionMeta(project, "uuid-x")

    expect(
      runClaudeHandoffSession({
        driver: new ClaudeDriver({ binary: "/nonexistent" }),
        store,
        project,
        resume: { ...meta, nativeSessionId: undefined },
      }),
    ).rejects.toThrow("no native session ID")
  })
})
