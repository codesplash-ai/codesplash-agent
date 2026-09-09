import { join } from "node:path"
import { configDirectory, configFilePath, dataDirectory, loadConfig } from "../core/config.ts"
import { BranchStore } from "../core/session/branches.ts"
import { InputQueue } from "../core/session/input-queue.ts"
import type { RecoveryRequest, RecoveryResult } from "../core/session/recovery-contract.ts"
import type { SessionRepository } from "../core/session/repository.ts"
import { directoryScope } from "../core/session/working-directory.ts"
import { SessionController } from "../core/session-controller.ts"
import { SessionRecorder } from "../core/session-recorder.ts"
import { readSessionEvents, type SessionMeta, SessionStore } from "../core/sessions.ts"
import { readTrustDecision } from "../core/trust.ts"
import { createPermissionRuntime } from "../engines/codesplash/permissions.ts"
import { NativeRecovery } from "../engines/codesplash/recovery.ts"
import { contains, createProfile, physicalPath } from "../engines/codesplash/sandbox/profile.ts"
import { NativeSandbox } from "../engines/codesplash/sandbox/runtime.ts"
import { loadTranscript } from "../engines/codesplash/transcript.ts"
import { CodexDriver } from "../engines/codex/driver.ts"

export async function sessionRecoveryCommand(
  repository: SessionRepository,
  meta: SessionMeta,
  request: RecoveryRequest,
  apply: boolean,
  env = process.env,
): Promise<RecoveryResult> {
  const handle = await new SessionStore(repository.root).open(meta.projectId, meta.localSessionId)
  // A second writer cannot change a live engine's selected context or file journal.
  handle.acquire()
  let runtime: NativeSandbox | undefined
  try {
    const branches = new BranchStore(handle.state)
    if (request.action === "tree") return { title: "Session branches", data: branches.view() }
    if (request.action === "fork" && !apply)
      return {
        title: "Independent fork preview",
        data: { node: branches.node(request.node), apply: "Use --apply to create an independent session" },
      }
    if (meta.engine === "claude") throw new Error("Use Claude's own terminal session controls")
    const config = await loadConfig(configFilePath(configDirectory(env))),
      cwd = physicalPath(meta.projectPath),
      trusted = (await readTrustDecision(cwd, dataDirectory(env)))?.trusted === true
    if (meta.engine === "codex") {
      if (!trusted) throw new Error("Provider session recovery requires current workspace trust")
      const recorder = new SessionRecorder(handle)
      const history = await readSessionEvents(handle.directory)
      recorder.seedFromHistory(history.events)
      const session = await new CodexDriver().openSession({
        cwd,
        localSessionId: meta.localSessionId,
        nativeSessionId: meta.nativeSessionId,
        firstSequence: recorder.lastSequence + 1,
        knownTurnIds: recorder.knownTurnIds,
        sessionState: handle.state,
        resumeQueuedInput: false,
        policy: { sandbox: config.codex.sandbox, approvalPolicy: config.codex.approvalPolicy },
        workspaceTrusted: trusted,
        flushSessionEvents: async () => {
          await recorder.flush()
          if (recorder.failure) throw recorder.failure
        },
      })
      const controller = new SessionController(session, { onEvent: recorder.record })
      controller.start()
      try {
        return await controller.sessionRecovery(request)
      } finally {
        await controller.close()
        await recorder.close()
      }
    }
    const permissions = await createPermissionRuntime({
      cwd,
      workspaceTrusted: trusted,
      mode: config.permissions.mode,
      configRules: config.permissions,
    })
    runtime = new NativeSandbox(
      createProfile(cwd, meta.sandbox ?? config.codex.sandbox, config.sandbox, [repository.root]),
    )
    const profile = runtime.profile,
      transcript = join(handle.directory, "transcript.jsonl")
    let messages = await loadTranscript(transcript)
    const queue = new InputQueue({ state: handle.state, cwd, recover: false })
    const recovery = new NativeRecovery(
      handle.state,
      {
        cwd,
        scope: directoryScope(handle.state.read().state),
        trusted: () => trusted,
        writable: () => profile.mode === "workspace-write" && permissions.mode !== "plan",
        readable: (path) =>
          contains(cwd, path) &&
          !profile.deniedReadPaths.some((root) => contains(root, path)) &&
          !["ask", "deny"].includes(permissions.decide("read_file", { paths: [path] }, true).kind),
        writablePath: (path) =>
          contains(cwd, path) &&
          !profile.protectedPaths.some((root) => contains(root, path)) &&
          !["ask", "deny"].includes(permissions.decide("write_file", { paths: [path] }, false).kind),
        protectedPaths: profile.protectedPaths,
        sanitize: runtime.sanitize.bind(runtime),
      },
      {
        transcript,
        history: () => messages,
        replace: (value) => {
          messages = value
        },
        usage: () => ({}),
        notes: () => ({}),
        selectNotes: () => {},
        sequence: () => meta.lastSequence,
        startSequence: () => 0,
        reset: () => {},
        pause: () => queue.pause(),
        flush: async () => {},
        notice: () => {},
      },
    )
    return await recovery.execute(request)
  } finally {
    await runtime?.close()
    handle.release()
  }
}
