import type { EngineDriver, EngineSession, OpenSessionOptions } from "../engine.ts"
import type { SessionRecorder } from "../session-recorder.ts"

/** Publish only a live session whose native identity has reached the recorder. */
export async function openEngineSession(
  driver: EngineDriver,
  options: OpenSessionOptions,
  recorder?: Pick<SessionRecorder, "recordNativeSessionId" | "flush"> & { readonly failure?: Error },
  signal?: AbortSignal,
): Promise<EngineSession> {
  signal?.throwIfAborted()
  let session: EngineSession | undefined
  try {
    session = await driver.openSession(options)
    signal?.throwIfAborted()
    if (session.nativeSessionId) recorder?.recordNativeSessionId(session.nativeSessionId)
    await recorder?.flush()
    if (recorder?.failure) throw recorder.failure
    signal?.throwIfAborted()
    return session
  } catch (error) {
    await session?.close()
    throw error
  }
}
