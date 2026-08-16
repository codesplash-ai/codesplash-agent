import { describe, expect, test } from "bun:test"
import type { SessionMeta } from "../../src/core/index.ts"
import {
  displaySessionStatus,
  formatRelativeTime,
  isResumableSession,
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

  test("sessions of either engine resume when they carry a native session ID", () => {
    expect(isResumableSession(makeMeta())).toBe(true)
    expect(isResumableSession(makeMeta({ nativeSessionId: undefined }))).toBe(false)
    expect(isResumableSession(makeMeta({ engine: "claude", sandbox: undefined }))).toBe(true)
    expect(
      isResumableSession(makeMeta({ engine: "claude", sandbox: undefined, nativeSessionId: undefined })),
    ).toBe(false)
  })
})
