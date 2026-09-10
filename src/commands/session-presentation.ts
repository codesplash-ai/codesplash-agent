import { join } from "node:path"
import { configDirectory, configFilePath, dataDirectory, loadConfig } from "../core/config.ts"
import { control, type SessionStateAccess } from "../core/session/control.ts"
import { owner } from "../core/session/files.ts"
import { outcomeCacheStatus, persistOutcomes } from "../core/session/outcome-log.ts"
import { localRecap, projectOutcomes } from "../core/session/outcomes.ts"
import {
  automaticTitle,
  presentationArguments,
  renameSession,
  sessionInfo,
} from "../core/session/presentation.ts"
import type { SessionRepository } from "../core/session/repository.ts"
import { SessionController } from "../core/session-controller.ts"
import { SessionRecorder } from "../core/session-recorder.ts"
import { readSessionEvents, SessionStore, transcriptPathFor } from "../core/sessions.ts"
import { readTrustDecision } from "../core/trust.ts"
import { CodesplashDriver } from "../engines/codesplash/engine.ts"

export async function sessionPresentationCommand(
  repository: SessionRepository,
  args: string[],
  output: (text: string) => void,
  env = process.env,
): Promise<number> {
  const [action, id, ...rest] = args
  if (!id) throw new Error(`session ${action} requires a session ID`)
  const repair = rest.includes("--repair"),
    apply = rest.includes("--apply")
  if ((repair || apply) && (action !== "outcomes" || !repair || !apply))
    throw new Error("Outcome repair requires outcomes ID --repair --apply")
  const request = presentationArguments(
    action as "info" | "recap" | "outcomes" | "rename",
    rest.filter((arg) => arg !== "--repair" && arg !== "--apply"),
  )
  const meta = await repository.resolve(id),
    directory = repository.path(meta),
    history = await readSessionEvents(directory),
    outcomes = projectOutcomes(history.events)
  const active = !!owner(join(directory, "writer.lease"))
  const emit = (value: unknown) =>
    output(
      `${typeof value === "string" && !rest.includes("--json") ? value : JSON.stringify(value, null, rest.includes("--json") ? undefined : 2)}\n`,
    )
  const state: SessionStateAccess = {
    durable: true,
    directory,
    read: () => control(directory),
    update: () => {
      throw new Error("Read-only session inspection")
    },
  }
  if (request.action === "info") {
    const status = [...history.events]
      .reverse()
      .find((event) => event.kind === "session.status" && event.payload.model)
    emit({
      ...sessionInfo({
        state,
        id: meta.localSessionId,
        nativeId: meta.nativeSessionId,
        storageProject: meta.projectId,
        engine: meta.engine,
        cwd: meta.projectPath,
        title: meta.title,
        model: status?.kind === "session.status" ? status.payload.model : undefined,
        usage: outcomes.cumulativeUsage,
        status: meta.lastStatus,
        sequence: outcomes.cursor,
        policy: {
          source: "recorded",
          sandbox: meta.sandbox,
          approval: meta.approvalPolicy,
          permission: meta.permissionMode,
        },
      }),
      eventRecovery: { skippedLines: history.skippedLineCount, tornTail: history.truncatedLineRecovered },
    })
  } else if (request.action === "outcomes" && !repair)
    emit({
      cursor: outcomes.cursor,
      dropped: outcomes.dropped,
      cache: outcomeCacheStatus(state, outcomes.cursor),
      rows: outcomes.rows
        .filter((row) => row.lastSequence > (request.since ?? -1))
        .map((row) => (!active && row.status === "running" ? { ...row, status: "uncertain" } : row)),
    })
  else if (request.action === "recap" && !request.generate) emit(localRecap(outcomes, request.since, active))
  else {
    const handle = await new SessionStore(repository.root).open(meta.projectId, meta.localSessionId)
    handle.acquire()
    let controller: SessionController | undefined, recorder: SessionRecorder | undefined
    try {
      if (repair) {
        const rebuilt = projectOutcomes((await readSessionEvents(directory)).events)
        persistOutcomes(handle.state, rebuilt)
        emit({ cache: outcomeCacheStatus(handle.state, rebuilt.cursor), cursor: rebuilt.cursor })
      } else if (!request.generate)
        emit(
          renameSession(
            handle.state,
            request.auto
              ? automaticTitle((await readSessionEvents(directory)).events)
              : (request.title ?? ""),
            !request.auto,
          ),
        )
      else {
        if (meta.engine !== "codesplash")
          throw new Error(
            "This engine has no bounded no-tool generation contract; use a local recap or --auto title",
          )
        const current = handle.meta
        const history = await readSessionEvents(directory)
        const outcomes = projectOutcomes(history.events)
        const config = await loadConfig(configFilePath(configDirectory(env)))
        const latestModel = [...history.events]
          .reverse()
          .find((e) => e.kind === "session.status" && e.payload.model)
        recorder = new SessionRecorder(handle)
        recorder.seedFromHistory(history.events)
        const session = await new CodesplashDriver({ config }).openSession({
          cwd: current.projectPath,
          localSessionId: meta.localSessionId,
          sessionState: handle.state,
          firstSequence: recorder.lastSequence + 1,
          initialUsage: outcomes.cumulativeUsage,
          nativeTranscriptPath: transcriptPathFor(handle),
          resumeQueuedInput: false,
          workspaceTrusted:
            (await readTrustDecision(current.projectPath, dataDirectory(env)))?.trusted === true,
          trustDataDirectory: dataDirectory(env),
          model: latestModel?.kind === "session.status" ? latestModel.payload.model : undefined,
          policy: {
            sandbox: current.sandbox ?? "workspace-write",
            approvalPolicy: current.approvalPolicy ?? "on-request",
            permissionMode: "plan",
          },
          flushSessionEvents: async () => {
            await recorder?.flush()
            if (recorder?.failure) throw recorder.failure
          },
        })
        controller = new SessionController(session, { onEvent: recorder.record })
        controller.start()
        emit(await controller.sessionPresentation(request))
      }
    } finally {
      try {
        await controller?.close()
      } finally {
        try {
          await recorder?.close()
        } finally {
          handle.release()
        }
      }
    }
  }
  return 0
}
