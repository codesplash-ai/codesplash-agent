import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, saveConfig } from "../../../src/core/config.ts"
import type { HookEvent, HookResult } from "../../../src/core/hooks.ts"
import { type AgentEvent, defaultConfig, type EngineSession } from "../../../src/core/index.ts"
import { BranchStore } from "../../../src/core/session/branches.ts"
import { MemorySessionState } from "../../../src/core/session/control.ts"
import { SessionRepository } from "../../../src/core/session/repository.ts"
import { workingDirectory } from "../../../src/core/session/working-directory.ts"
import { SessionController } from "../../../src/core/session-controller.ts"
import { projectIdFor, SessionStore, transcriptPathFor } from "../../../src/core/sessions.ts"
import { writeTrustDecision } from "../../../src/core/trust.ts"
import type { ProviderRequest } from "../../../src/engines/codesplash/contracts.ts"
import {
  CodesplashDriver,
  type PermissionRuntimeFactoryOptions,
} from "../../../src/engines/codesplash/engine.ts"
import { validateHookConfig } from "../../../src/engines/codesplash/hooks/config.ts"
import { reviewHook, trustHook } from "../../../src/engines/codesplash/hooks/trust.ts"
import { createPermissionRuntime } from "../../../src/engines/codesplash/permissions.ts"
import { createProfile } from "../../../src/engines/codesplash/sandbox/profile.ts"
import { appendTranscriptMessages, loadTranscript } from "../../../src/engines/codesplash/transcript.ts"

test("hook gates precede directory and branch publication; resume and retirement do not replay lifecycle", async () => {
  const seen: HookEvent[] = []
  let block = true
  const f = await fixture(false, false, (event) => {
    seen.push(event)
    return event.name === "cwd.before" && block
      ? { version: 1, decision: "deny", reason: "fixture gate" }
      : { version: 1 }
  })
  try {
    const original = await f.controller.changeDirectory({ path: f.to })
    expect(seen.map((event) => event.name)).toEqual(["session.start"])
    await expect(
      f.controller.changeDirectory({
        path: f.to,
        context: "clear",
        apply: true,
        revision: original.revision,
      }),
    ).rejects.toThrow("fixture gate")
    expect(f.session.directoryStatus?.().cwd).toBe(f.from)
    block = false
    const current = await f.controller.changeDirectory({ path: f.to })
    await f.controller.changeDirectory({
      path: f.to,
      context: "clear",
      apply: true,
      revision: current.revision,
    })
    expect(f.session.directoryStatus?.().cwd).toBe(f.to)
    expect(seen.filter((event) => event.name === "session.start")).toHaveLength(1)
    expect(seen.filter((event) => event.name === "session.end")).toHaveLength(0)
    expect(seen.find((event) => event.name === "cwd.after")?.fields.cwd).toBe(f.to)
    const branches = new BranchStore(f.state)
    const first = branches.view().head
    if (!first) throw new Error("missing branch fixture")
    branches.capture({
      kind: "turn",
      label: "second",
      messages: [{ role: "user", content: [{ type: "text", text: "second" }] }],
      eventSequence: 1,
      usage: {},
    })
    const preview = await f.session.sessionRecovery?.({ action: "rewind", node: first })
    expect(seen.filter((event) => event.name === "branch.before")).toHaveLength(0)
    if (!preview || !("revision" in preview.data) || typeof preview.data.revision !== "string")
      throw new Error("missing preview")
    await f.session.sessionRecovery?.({
      action: "rewind",
      node: first,
      apply: true,
      revision: preview.data.revision,
    })
    expect(branches.view().head).toBe(first)
    expect(seen.filter((event) => event.name === "branch.before")).toHaveLength(1)
    expect(seen.filter((event) => event.name === "branch.after")).toHaveLength(1)
    await f.reopen()
    expect(seen.filter((event) => event.name === "session.resume")).toHaveLength(1)
    expect(seen.filter((event) => event.name === "session.start")).toHaveLength(1)
  } finally {
    await f.close()
  }
})

async function fixture(durable = false, layered = false, hook?: (event: HookEvent) => HookResult) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codesplash-cwd-"))),
    from = join(root, "old"),
    to = join(root, "new")
  mkdirSync(from)
  mkdirSync(to)
  let config = structuredClone(defaultConfig)
  config.providers = [
    {
      id: "cwd-fixture",
      protocol: "anthropic",
      baseUrl: "http://127.0.0.1:1",
      displayName: "Fixture",
      keyEnvVar: "CWD_UNUSED",
      requiresKey: false,
      models: [
        {
          id: "cwd-model",
          displayName: "Fixture",
          contextWindow: 100000,
          maxOutputTokens: 1024,
          isDefault: true,
          supportsReasoning: false,
        },
      ],
    },
  ]
  if (layered) {
    const path = join(root, "config.toml")
    await saveConfig(config, path)
    config = await loadConfig(path, [], {
      cwd: from,
      env: {},
      dataDir: join(root, "data"),
      workspaceTrusted: false,
    })
  }
  const requests: ProviderRequest[] = [],
    permissions: PermissionRuntimeFactoryOptions[] = [],
    events: AgentEvent[] = []
  let fail = false,
    releasePreparation: (() => void) | undefined,
    startedPreparation: (() => void) | undefined
  const store = new SessionStore(join(root, "sessions")),
    now = new Date().toISOString()
  const handle = durable
    ? await store.create({
        schemaVersion: 2,
        engine: "codesplash",
        localSessionId: crypto.randomUUID(),
        projectId: projectIdFor(from),
        projectPath: from,
        createdAt: now,
        updatedAt: now,
        lastStatus: "closed",
        lastSequence: -1,
      })
    : undefined
  handle?.acquire()
  const state = handle?.state ?? new MemorySessionState()
  if (hook) {
    config.hooks = validateHookConfig({
      handlers: {
        fixture: {
          kind: "command",
          command: "/bin/cat",
          enabled: true,
          events: [
            "session.start",
            "session.resume",
            "session.end",
            "cwd.before",
            "cwd.after",
            "branch.before",
            "branch.after",
            "config.before",
            "config.after",
          ],
          share: ["transition", "cwd"],
        },
      },
    })
    for (const cwd of [from, to]) {
      const review = await reviewHook(config, "fixture", cwd)
      trustHook(join(root, "data"), review, review.fingerprint)
    }
  }
  const driver = new CodesplashDriver({
    config,
    permissions: async (options) => {
      permissions.push(options)
      return createPermissionRuntime(options)
    },
    providers: {
      "cwd-fixture": {
        id: "anthropic",
        models: [],
        stream(request) {
          requests.push(structuredClone(request))
          return (async function* () {
            yield { type: "text_delta", text: "done" } as const
            yield { type: "done", stopReason: "end_turn" } as const
          })()
        },
      },
    },
    sandbox: async (options) => {
      if (options.cwd === to && fail) throw new Error("Injected sandbox preparation failure")
      if (options.cwd === to && startedPreparation) {
        startedPreparation()
        await new Promise<void>((resolve) => {
          releasePreparation = resolve
        })
      }
      return {
        profile: createProfile(options.cwd, "read-only", config.sandbox),
        executeFixed: async (_argv: string[], input: string) => ({
          kind: "success" as const,
          exitCode: 0,
          stdout: JSON.stringify(hook?.(JSON.parse(input)) ?? { version: 1 }),
          stderr: "",
        }),
        runTool: async () => {
          throw new Error("Unexpected tool")
        },
        execute: async () => {
          throw new Error("Unexpected process")
        },
        validateGrant: (grant) => grant,
        grant: () => {},
        endTurn: () => {},
        close: async () => {},
        sanitize: (text) => text,
      }
    },
  })
  let session: EngineSession = await driver.openSession({
    cwd: from,
    sessionState: state,
    localSessionId: handle?.meta.localSessionId ?? "ephemeral",
    nativeTranscriptPath: handle ? transcriptPathFor(handle) : undefined,
    model: "cwd-model",
    workspaceTrusted: false,
    trustDataDirectory: join(root, "data"),
    permissionOverrides: { allow: ["read_file(*)"] },
    permissionGrantsPath: join(root, "old-grants.toml"),
    resumeQueuedInput: false,
  })
  let controller = new SessionController(session, { onEvent: (event) => events.push(event) })
  controller.start()
  return {
    root,
    from,
    to,
    state,
    handle,
    store,
    requests,
    permissions,
    events,
    get session() {
      return session
    },
    get controller() {
      return controller
    },
    fail(value: boolean) {
      fail = value
    },
    slow() {
      return new Promise<void>((resolve) => {
        startedPreparation = resolve
      })
    },
    release() {
      releasePreparation?.()
    },
    async reopen() {
      await controller.close()
      session = await driver.openSession({
        resuming: true,
        cwd: from,
        sessionState: state,
        localSessionId: session.localSessionId,
        nativeTranscriptPath: handle ? transcriptPathFor(handle) : undefined,
        model: "cwd-model",
        workspaceTrusted: true,
        trustDataDirectory: join(root, "data"),
        firstSequence: Math.max(...events.map((event) => event.sequence)) + 1,
      })
      controller = new SessionController(session, { onEvent: (event) => events.push(event) })
      controller.start()
    },
    async close() {
      await controller.close()
      handle?.release()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
async function turn(session: EngineSession, text: string) {
  const receipt = await session.submit!({ text })
  session.inputQueue!.resume()
  for (
    let attempt = 0;
    attempt < 400 &&
    session.inputQueue!.snapshot().items.find((item) => item.id === receipt.id)?.status !== "completed";
    attempt++
  )
    await Bun.sleep(5)
  expect(session.inputQueue!.snapshot().items.find((item) => item.id === receipt.id)?.status).toBe(
    "completed",
  )
}
test("directory preparation failure preserves old runtime; success revokes grants, holds queued paths and routes bound methods/events", async () => {
  const f = await fixture()
  try {
    await turn(f.session, "original context")
    f.session.inputQueue!.pause()
    writeFileSync(join(f.from, "file.txt"), "old")
    writeFileSync(join(f.to, "file.txt"), "new")
    const queued = await f.session.submit!({ text: "read this", files: ["file.txt"] })
    const boundStatus = f.session.directoryStatus!.bind(f.session)
    const preview = await f.controller.changeDirectory({ path: f.to })
    f.fail(true)
    await expect(
      f.controller.changeDirectory({ path: f.to, context: "carry", apply: true, revision: preview.revision }),
    ).rejects.toThrow("preparation failure")
    expect(boundStatus().cwd).toBe(f.from)
    expect(f.state.read().state.values.workingDirectory).toBeUndefined()
    expect(f.session.inputQueue!.snapshot().items.find((item) => item.id === queued!.id)?.status).toBe(
      "queued",
    )
    f.fail(false)
    const changed = await f.controller.changeDirectory({
      path: f.to,
      context: "carry",
      apply: true,
      revision: preview.revision,
    })
    expect(changed.applied).toBe(true)
    expect(boundStatus()).toEqual({ cwd: f.to, trusted: false })
    expect(f.permissions.at(-1)?.overrides).toBeUndefined()
    expect(f.permissions.at(-1)?.grantsPath).toBeUndefined()
    expect(f.controller.state.inputQueue?.paused).toBe(true)
    f.session.inputQueue!.resume()
    expect(f.session.inputQueue!.snapshot().items.find((item) => item.id === queued!.id)?.status).toBe(
      "blocked",
    )
    expect(() => f.session.inputQueue!.retry(queued!.id, f.session.inputQueue!.snapshot().revision)).toThrow(
      "edit",
    )
    expect(f.session.inputQueue!.history().some((item) => item.input.text === "original context")).toBe(false)
    await turn(f.session, "next context")
    expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain("original context")
    expect(JSON.stringify(f.requests.at(-1)?.system)).toContain(f.to)
    const exported = await f.session.exportHistory!({ all: true })
    expect(exported.payload.nodes.length).toBeGreaterThan(2)
    const tree = new BranchStore(f.state).view()
    await expect(f.controller.sessionRecovery({ action: "rewind", node: tree.nodes[0]!.id })).rejects.toThrow(
      "different working directory",
    )
    expect(f.events.map((event) => event.sequence)).toEqual(
      [...new Set(f.events.map((event) => event.sequence))].sort((a, b) => a - b),
    )
  } finally {
    await f.close()
  }
})
test("recorded directory change keeps storage identity and repairs interrupted transcript publication before resume", async () => {
  const f = await fixture(true)
  try {
    await turn(f.session, "old secret context")
    const preview = await f.controller.changeDirectory({ path: f.to })
    await f.controller.changeDirectory({
      path: f.to,
      context: "clear",
      apply: true,
      revision: preview.revision,
    })
    const repository = new SessionRepository(f.store.root),
      meta = await repository.resolve(f.session.localSessionId, projectIdFor(f.to))
    expect(meta.projectId).toBe(projectIdFor(f.from))
    expect(meta.projectPath).toBe(f.to)
    expect(await f.store.list(projectIdFor(f.from))).toHaveLength(0)
    expect(await f.store.list(projectIdFor(f.to))).toHaveLength(1)
    expect((await f.controller.sessionRecovery({ action: "checkpoints" })).data).toMatchObject({ steps: [] })
    f.state.update(f.state.read().revision, "fixture/interrupted-publication", (state) => {
      workingDirectory(state)!.pending = true
    })
    await appendTranscriptMessages(transcriptPathFor(f.handle!), [
      { role: "user", content: [{ type: "text", text: "old uncommitted transcript" }] },
    ])
    await expect(f.session.exportHistory!({})).resolves.toBeDefined()
    await f.reopen()
    expect(f.session.directoryStatus!().cwd).toBe(f.to)
    expect(await loadTranscript(transcriptPathFor(f.handle!))).toEqual([])
    expect(workingDirectory(f.state.read().state)?.pending).toBe(false)
    await turn(f.session, "new request")
    expect(JSON.stringify(f.requests.at(-1)?.messages)).not.toContain("old secret context")
  } finally {
    await f.close()
  }
})
test("directory preparation rejects source changes and preserves the previous usable runtime", async () => {
  const f = await fixture(false, true)
  try {
    await writeTrustDecision(f.to, true, join(f.root, "data"))
    mkdirSync(join(f.to, ".codesplash"))
    const path = join(f.to, ".codesplash", "config.toml")
    writeFileSync(path, 'theme="dark"')
    const preview = await f.controller.changeDirectory({ path: f.to }),
      started = f.slow()
    const changing = f.controller.changeDirectory({
      path: f.to,
      context: "clear",
      apply: true,
      revision: preview.revision,
    })
    const settled = changing.then(
      () => undefined,
      (error: unknown) => error,
    )
    await started
    writeFileSync(path, 'theme="light"')
    f.release()
    expect(String(await settled)).toContain("configuration")
    expect(f.session.directoryStatus?.().cwd).toBe(f.from)
    await turn(f.session, "still usable")
    expect(f.requests.length).toBeGreaterThan(0)
  } finally {
    f.release()
    await f.close()
  }
})

test("directory preparation fences concurrent queue edits and close settles the transition", async () => {
  const f = await fixture()
  try {
    const preview = await f.controller.changeDirectory({ path: f.to }),
      started = f.slow()
    const changing = f.controller.changeDirectory({
      path: f.to,
      context: "clear",
      apply: true,
      revision: preview.revision,
    })
    await started
    expect(() => f.session.inputQueue!.submit({ text: "race" })).toThrow("transition")
    await expect(f.session.submit!({ text: "race" })).rejects.toThrow("transition")
    const closing = f.controller.close()
    f.release()
    await changing
    await closing
    expect(workingDirectory(f.state.read().state)?.current).toBe(f.to)
  } finally {
    f.release()
    await f.close()
  }
})

test("directory preview fences trust changes and returning restores the original checkpoint scope", async () => {
  const f = await fixture()
  try {
    const data = join(f.root, "data")
    await writeTrustDecision(f.to, true, data)
    const reviewed = await f.controller.changeDirectory({ path: f.to })
    expect(reviewed.trusted).toBe(true)
    await writeTrustDecision(f.to, false, data)
    await expect(
      f.controller.changeDirectory({
        path: f.to,
        context: "clear",
        apply: true,
        revision: reviewed.revision,
      }),
    ).rejects.toThrow("stale")
    expect(f.session.directoryStatus?.().cwd).toBe(f.from)
    await writeTrustDecision(f.to, true, data)
    const current = await f.controller.changeDirectory({ path: f.to })
    await f.controller.changeDirectory({
      path: f.to,
      context: "clear",
      apply: true,
      revision: current.revision,
    })
    expect(f.session.directoryStatus?.().trusted).toBe(true)
    expect(f.session.permissionRules?.().some((rule) => rule.source === "cli")).toBe(false)
    const { directoryScope } = await import("../../../src/core/session/working-directory.ts")
    expect(directoryScope(f.state.read().state)).toBeDefined()
    const back = await f.controller.changeDirectory({ path: f.from })
    await f.controller.changeDirectory({
      path: f.from,
      context: "clear",
      apply: true,
      revision: back.revision,
    })
    expect(f.session.directoryStatus?.().trusted).toBe(false)
    expect(directoryScope(f.state.read().state)).toBeUndefined()
  } finally {
    await f.close()
  }
})
