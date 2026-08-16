/**
 * Claude Code launches through the official CLI's real-terminal handoff. The app stores
 * only launch metadata and a session ID it supplies itself via documented flags
 * (`--session-id`, `--resume`); it never reads `~/.claude` and never records PTY output.
 */
import type { AgentConfig, AppOptions, ProjectPreflight, SessionMeta, SessionStatus } from "../core/index.ts"
import {
  deferSignalExit,
  effectiveHistoryEnabled,
  listProjectSessions,
  projectIdFor,
  SessionStore,
} from "../core/index.ts"
import { ClaudeDriver } from "../engines/claude/index.ts"
import { renderSessionPicker } from "./session-picker.tsx"

/** Documented-flag argument list for a launch that the app can later resume. */
export function claudeLaunchArgs(nativeSessionId: string, resume: boolean): string[] {
  return resume ? ["--resume", nativeSessionId] : ["--session-id", nativeSessionId]
}

export function claudeStatusForExit(exitCode: number): SessionStatus {
  return exitCode === 0 ? "closed" : "failed"
}

export function createClaudeSessionMeta(
  project: Pick<ProjectPreflight, "cwd">,
  nativeSessionId: string,
  now = new Date().toISOString(),
): SessionMeta {
  return {
    schemaVersion: 1,
    engine: "claude",
    localSessionId: crypto.randomUUID(),
    nativeSessionId,
    projectPath: project.cwd,
    projectId: projectIdFor(project.cwd),
    title: "Claude Code session",
    createdAt: now,
    updatedAt: now,
    lastStatus: "starting",
    lastSequence: -1,
  }
}

export type ClaudeHandoffDeps = {
  driver: ClaudeDriver
  store: SessionStore
  project: Pick<ProjectPreflight, "cwd">
  resume?: SessionMeta
}

/**
 * Runs one recorded handoff: metadata says "running" while Claude owns the terminal and a
 * terminal status afterwards, so a killed cockpit leaves a resumable "interrupted" row.
 */
export async function runClaudeHandoffSession(deps: ClaudeHandoffDeps): Promise<number> {
  const { driver, store, project } = deps

  let handle: Awaited<ReturnType<SessionStore["open"]>>
  let nativeSessionId: string
  if (deps.resume) {
    if (!deps.resume.nativeSessionId) throw new Error("This Claude session has no native session ID")
    handle = await store.open(deps.resume.projectId, deps.resume.localSessionId)
    nativeSessionId = deps.resume.nativeSessionId
  } else {
    nativeSessionId = crypto.randomUUID()
    handle = await store.create(createClaudeSessionMeta(project, nativeSessionId))
  }

  await handle.updateMeta({ lastStatus: "running" })
  try {
    const result = await driver.handoff(project.cwd, claudeLaunchArgs(nativeSessionId, Boolean(deps.resume)))
    await handle.updateMeta({ lastStatus: claudeStatusForExit(result.exitCode) })
    return result.exitCode
  } catch (error) {
    await handle.updateMeta({ lastStatus: "failed" })
    throw error
  }
}

export async function launchClaude(
  project: ProjectPreflight,
  config: AgentConfig,
  options: AppOptions,
): Promise<void> {
  const driver = new ClaudeDriver()
  const release = deferSignalExit()
  try {
    if (!effectiveHistoryEnabled(config, options)) {
      await driver.handoff(project.cwd)
      return
    }

    const sessions = (await listProjectSessions(projectIdFor(project.cwd))).filter(
      (meta) => meta.engine === "claude",
    )
    let resume: SessionMeta | undefined
    if (sessions.length > 0) {
      const choice = await renderSessionPicker(sessions, config.theme)
      if (choice.type === "back") return
      if (choice.type === "resume") resume = choice.meta
    }

    await runClaudeHandoffSession({ driver, store: new SessionStore(), project, resume })
  } finally {
    release()
  }
}
