import { resolveConfigForWorkspace } from "../core/config/resolver.ts"
import { configDirectory, configFilePath, dataDirectory, loadConfig } from "../core/config.ts"
import { directoryCommand } from "../core/session/directory-command.ts"
import { digest } from "../core/session/files.ts"
import type { SessionRepository } from "../core/session/repository.ts"
import type { DirectoryRequest } from "../core/session/working-directory.ts"
import { destinationDirectory } from "../core/session/working-directory.ts"
import { SessionController } from "../core/session-controller.ts"
import { SessionRecorder } from "../core/session-recorder.ts"
import { readSessionEvents, SessionStore, transcriptPathFor } from "../core/sessions.ts"
import { readTrustDecision } from "../core/trust.ts"
import { CodesplashDriver } from "../engines/codesplash/engine.ts"

export async function sessionDirectoryCommand(
  repository: SessionRepository,
  args: string[],
  output: (text: string) => void,
  env = process.env,
) {
  const [action, id, ...rest] = args.filter((arg) => arg !== "--json")
  if (!id) throw new Error(`session ${action} requires a session ID`)
  const meta = await repository.resolve(id)
  if (action === "pwd") {
    if (rest.length) throw new Error("session pwd accepts only a session ID")
    output(
      `${JSON.stringify({ cwd: meta.projectPath, project: meta.effectiveProjectId ?? meta.projectId, storageProject: meta.projectId })}\n`,
    )
    return 0
  }
  if (meta.engine !== "codesplash")
    throw new Error(
      "This engine requires a new session or its owning CLI to select a different working directory",
    )
  // Serialize argv as literal shell-quote strings only to share the slash command's parser.
  const request = directoryCommand(rest.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" "))
  const handle = await new SessionStore(repository.root).open(meta.projectId, meta.localSessionId)
  handle.acquire()
  let controller: SessionController | undefined, recorder: SessionRecorder | undefined
  try {
    const cwd = destinationDirectory(meta.projectPath, request.path),
      trusted = (await readTrustDecision(cwd, dataDirectory(env)))?.trusted === true
    const config = await loadConfig(configFilePath(configDirectory(env)), [], { cwd: meta.projectPath, env })
    const destinationConfig = await resolveConfigForWorkspace(config, cwd, trusted)
    const revision = digest(
      JSON.stringify([handle.state.read().revision, cwd, trusted, destinationConfig.resolution?.generation]),
    )
    if (!request.apply) {
      output(
        `${JSON.stringify(
          {
            from: meta.projectPath,
            cwd,
            trusted,
            revision,
            context: request.context,
            applied: false,
            apply:
              "Choose --carry or --clear and pass --apply --revision REVISION; retained queue entries require editing",
          },
          null,
          2,
        )}\n`,
      )
      return 0
    }
    if (request.revision !== revision || !request.context)
      throw new Error("Apply requires the current directory preview revision and --carry or --clear")
    const history = await readSessionEvents(handle.directory)
    recorder = new SessionRecorder(handle)
    recorder.seedFromHistory(history.events)
    const usage = [...history.events].reverse().find((event) => event.kind === "usage.updated")
    const session = await new CodesplashDriver({ config }).openSession({
      resuming: true,
      cwd: meta.projectPath,
      localSessionId: meta.localSessionId,
      sessionState: handle.state,
      firstSequence: recorder.lastSequence + 1,
      initialUsage: usage?.kind === "usage.updated" ? usage.payload : undefined,
      nativeTranscriptPath: transcriptPathFor(handle),
      resumeQueuedInput: false,
      workspaceTrusted: (await readTrustDecision(meta.projectPath, dataDirectory(env)))?.trusted === true,
      trustDataDirectory: dataDirectory(env),
      policy: {
        sandbox: meta.sandbox === "read-only" ? "read-only" : "workspace-write",
        approvalPolicy: config.codex.approvalPolicy,
        permissionMode: meta.permissionMode === "plan" ? "plan" : "default",
      },
      flushSessionEvents: async () => {
        await recorder?.flush()
        if (recorder?.failure) throw recorder.failure
      },
    })
    controller = new SessionController(session, { onEvent: recorder.record })
    controller.start()
    // Opening recovers queue/base state under the same lease. Revalidate the reviewed destination
    // before taking its new runtime revision; no external writer can alter the session in between.
    const preview = await controller.changeDirectory({ path: cwd })
    if (preview.trusted !== trusted) throw new Error("Trust changed since preview")
    const apply: DirectoryRequest = { ...request, path: cwd, revision: preview.revision }
    output(`${JSON.stringify(await controller.changeDirectory(apply), null, 2)}\n`)
    return 0
  } finally {
    await controller?.close()
    await recorder?.close()
    handle.release()
  }
}
