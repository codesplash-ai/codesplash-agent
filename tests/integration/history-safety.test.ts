import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { AppViewState } from "../../src/core/index.ts"
import {
  projectIdFor,
  SessionController,
  SessionRecorder,
  SessionStore,
  sessionsRootDirectory,
} from "../../src/core/index.ts"
import { CodexDriver } from "../../src/engines/codex/driver.ts"

const fixture = new URL("../fixtures/fake-codex-app-server.ts", import.meta.url)

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

function createDriver(): CodexDriver {
  return new CodexDriver({
    command: [process.execPath, fileURLToPath(fixture)],
    shutdownTimeoutMs: 100,
  })
}

function waitFor(
  controller: SessionController,
  predicate: (state: AppViewState) => boolean,
  timeoutMs = 5000,
): Promise<AppViewState> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error("Timed out waiting for expected view state"))
    }, timeoutMs)
    const unsubscribe = controller.subscribe((state) => {
      if (!predicate(state)) return
      clearTimeout(timeout)
      unsubscribe()
      resolve(state)
    })
  })
}

describe("history safety (exit gate 3)", () => {
  test("a crashed child's credential-shaped stderr never reaches disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "codesplash-agent-safety-"))
    temporaryDirectories.push(root)
    const store = new SessionStore(root)
    const projectPath = "/canonical/safety-project"
    const now = new Date().toISOString()

    const handle = await store.create({
      schemaVersion: 1,
      engine: "codex",
      localSessionId: "safety-session",
      projectPath,
      projectId: projectIdFor(projectPath),
      createdAt: now,
      updatedAt: now,
      lastStatus: "starting",
      lastSequence: -1,
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
    })
    const recorder = new SessionRecorder(handle)
    const session = await createDriver().openSession({
      cwd: process.cwd(),
      localSessionId: "safety-session",
    })
    const controller = new SessionController(session, { onEvent: recorder.record })
    controller.start()

    await waitFor(controller, (state) => state.sessionStatus === "ready")
    // The fake prints "Authorization: Bearer fake-secret-token-value" to stderr, then dies.
    await controller.send({ text: "crash" })
    await waitFor(controller, (state) => state.error !== undefined)

    await controller.close()
    await recorder.close()
    expect(recorder.failure).toBeUndefined()

    const eventsSource = await readFile(handle.eventsPath, "utf8")
    const metaSource = await readFile(join(handle.directory, "meta.json"), "utf8")

    for (const source of [eventsSource, metaSource]) {
      expect(source).not.toContain("fake-secret-token-value")
      expect(source).not.toContain("Bearer fake-secret")
    }
    expect(eventsSource).toContain("[REDACTED]")

    for (const line of eventsSource.split("\n").filter((entry) => entry.length > 0)) {
      expect(collectKeys(JSON.parse(line))).not.toContain("raw")
    }
  }, 15000)

  test("a session driven without a recorder creates nothing under the data directory", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "codesplash-agent-nohistory-"))
    temporaryDirectories.push(dataDir)

    // --no-history means the recorder is never constructed; the engine and controller
    // run exactly as usual and only the tap is absent.
    const session = await createDriver().openSession({
      cwd: process.cwd(),
      localSessionId: "no-history-session",
    })
    const controller = new SessionController(session)
    controller.start()

    await waitFor(controller, (state) => state.sessionStatus === "ready")
    await controller.send({ text: "stream" })
    await waitFor(controller, (state) => state.turnStatus === "completed")
    await controller.close()

    expect(await readdir(dataDir)).toEqual([])
    expect(await Bun.file(join(sessionsRootDirectory(dataDir), "anything")).exists()).toBe(false)
  })
})

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (typeof value !== "object" || value === null) return keys
  for (const [key, child] of Object.entries(value)) {
    keys.push(key)
    collectKeys(child, keys)
  }
  return keys
}
