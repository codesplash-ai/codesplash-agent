import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "@opentui/react"
import type { SessionMeta } from "../../src/core/index.ts"
import { SessionRepository } from "../../src/core/session/repository.ts"
import { SessionStore } from "../../src/core/sessions.ts"
import { CODESPLASH_CAPABILITIES } from "../../src/engines/codesplash/index.ts"
import { brandThemes } from "../../src/tui/brand.ts"
import {
  displaySessionStatus,
  formatRelativeTime,
  isResumableSession,
  SessionPickerApp,
  sandboxBadge,
} from "../../src/tui/session-picker.tsx"

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    schemaVersion: 1,
    engine: "codex",
    localSessionId: "local-1",
    nativeSessionId: "thread-1",
    projectPath: "/p",
    projectId: "abc",
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    lastStatus: "closed",
    lastSequence: 10,
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    ...overrides,
  }
}

describe("session picker", () => {
  test("shows sessions that never closed as interrupted but keeps terminal statuses", () => {
    expect(displaySessionStatus(makeMeta({ lastStatus: "running" }))).toBe("interrupted")
    expect(displaySessionStatus(makeMeta({ lastStatus: "waiting" }))).toBe("interrupted")
    expect(displaySessionStatus(makeMeta({ lastStatus: "starting" }))).toBe("interrupted")
    expect(displaySessionStatus(makeMeta({ lastStatus: "closed" }))).toBe("closed")
    expect(displaySessionStatus(makeMeta({ lastStatus: "failed" }))).toBe("failed")
  })

  test("formats relative timestamps for picker rows", () => {
    const now = new Date("2026-08-16T12:00:00.000Z")
    expect(formatRelativeTime("2026-08-16T11:59:30.000Z", now)).toBe("just now")
    expect(formatRelativeTime("2026-08-16T11:15:00.000Z", now)).toBe("45m ago")
    expect(formatRelativeTime("2026-08-16T03:00:00.000Z", now)).toBe("9h ago")
    expect(formatRelativeTime("2026-08-13T12:00:00.000Z", now)).toBe("3d ago")
    expect(formatRelativeTime("2026-05-01T12:00:00.000Z", now)).toBe("2026-05-01")
    expect(formatRelativeTime("garbage", now)).toBe("unknown")
  })

  test("labels dangerous sessions loudly and plain modes plainly", () => {
    expect(sandboxBadge(makeMeta({ sandbox: "danger-full-access" }))).toBe("FULL ACCESS")
    expect(sandboxBadge(makeMeta({ sandbox: "read-only" }))).toBe("read-only")
    expect(sandboxBadge(makeMeta())).toBe("workspace-write")
    expect(sandboxBadge(makeMeta({ engine: "claude", sandbox: undefined }))).toBe("official CLI")
  })

  test("codex and claude sessions resume when they carry a native session ID", () => {
    expect(isResumableSession(makeMeta())).toBe(true)
    expect(isResumableSession(makeMeta({ nativeSessionId: undefined }))).toBe(false)
    expect(isResumableSession(makeMeta({ engine: "claude", sandbox: undefined }))).toBe(true)
    expect(
      isResumableSession(makeMeta({ engine: "claude", sandbox: undefined, nativeSessionId: undefined })),
    ).toBe(false)
  })

  test("codesplash rows follow the engine resume capability, not the native session ID", () => {
    // CodeSplash resumes from the transcript in the session store, not a provider thread: a row
    // is resumable exactly when CODESPLASH_CAPABILITIES.resume says so, and the recorded
    // nativeSessionId (=== localSessionId) neither enables nor blocks it.
    expect(isResumableSession(makeMeta({ engine: "codesplash", nativeSessionId: "local-1" }))).toBe(
      CODESPLASH_CAPABILITIES.resume,
    )
    expect(isResumableSession(makeMeta({ engine: "codesplash", nativeSessionId: undefined }))).toBe(
      CODESPLASH_CAPABILITIES.resume,
    )
    expect(displaySessionStatus(makeMeta({ engine: "codesplash", lastStatus: "running" }))).toBe(
      "interrupted",
    )
    expect(sandboxBadge(makeMeta({ engine: "codesplash" }))).toBe("workspace-write")
  })
})

test("picker search, rename, archive and delete use persisted repository state", async () => {
  const root = await mkdtemp(join(tmpdir(), "m5-picker-")),
    repository = new SessionRepository(root)
  const meta = makeMeta({ schemaVersion: 2, title: "Original title" })
  await new SessionStore(root).create(meta)
  const setup = await createTestRenderer({ width: 120, height: 30 })
  const render = createRoot(setup.renderer)
  const settle = async () => {
    await setup.flush()
    await Bun.sleep(25)
    await setup.flush()
  }
  try {
    render.render(
      <SessionPickerApp
        sessions={[meta]}
        repository={repository}
        palette={brandThemes.dark}
        onAction={() => {}}
      />,
    )
    await settle()
    setup.mockInput.pressArrow("down")
    await settle()
    setup.mockInput.pressKey("r")
    await settle()
    await setup.mockInput.typeText("Renamed title")
    await settle()
    setup.mockInput.pressEnter()
    await settle()
    expect((await repository.resolve(meta.localSessionId)).title).toBe("Renamed title")
    setup.mockInput.pressKey("/")
    await settle()
    await setup.mockInput.typeText("Renamed")
    await settle()
    setup.mockInput.pressEnter()
    await settle()
    setup.mockInput.pressArrow("down")
    await settle()
    setup.mockInput.pressKey("h")
    await settle()
    expect((await repository.resolve(meta.localSessionId)).archived).toBe(true)
    setup.mockInput.pressKey("a")
    await settle()
    setup.mockInput.pressArrow("down")
    await settle()
    setup.mockInput.pressKey("d")
    await settle()
    setup.mockInput.pressEnter()
    await settle()
    expect(await repository.all()).toHaveLength(1)
    await setup.mockInput.typeText("delete")
    await settle()
    setup.mockInput.pressEnter()
    await settle()
    expect(await repository.all()).toHaveLength(0)
  } finally {
    render.unmount()
    setup.renderer.destroy()
    await rm(root, { recursive: true, force: true })
  }
})
