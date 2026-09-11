import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerChildProcess } from "../../../core/lifecycle.ts"
import type { ExecutionResult, SandboxProfile } from "./contracts.ts"
import { internalCommand } from "./entrypoint.ts"
import { childEnvironment } from "./env-policy.ts"
import { createMacReaper } from "./macos-reaper.ts"
import { runProcess } from "./process.ts"
import { physicalPath } from "./profile.ts"
import type { SupervisorInput } from "./supervisor.ts"

export type SandboxDuplex = {
  write(bytes: Uint8Array): Promise<void>
  readonly finished: Promise<ExecutionResult>
  close(): Promise<void>
}

/** A persistent child has the same OS boundary and cleanup identity as ordinary tools. */
export async function openSandboxDuplex(
  profile: SandboxProfile,
  argv: string[],
  signal: AbortSignal,
  stdout: (chunk: Uint8Array) => void | Promise<void>,
  redactions: string[] = [],
): Promise<SandboxDuplex> {
  if (signal.aborted) throw signal.reason ?? new Error("Transport cancelled")
  if (!argv[0] || argv.some((arg) => arg.includes("\0"))) throw new Error("Invalid transport argv")
  if (profile.mode === "danger-full-access")
    throw new Error("Persistent MCP processes require an enforced read-only or workspace-write sandbox")
  const temp = physicalPath(await mkdtemp(join(tmpdir(), "codesplash-duplex-")))
  let reaper: Awaited<ReturnType<typeof createMacReaper>> | undefined
  let unregister: (() => void) | undefined
  let removeAbort: (() => void) | undefined
  try {
    if (process.platform === "darwin") {
      reaper = await createMacReaper()
      unregister = registerChildProcess(reaper)
    }
    if (signal.aborted) throw signal.reason ?? new Error("Transport cancelled")
    const abort = new AbortController()
    const cancel = () => abort.abort(signal.reason ?? new Error("Transport cancelled"))
    signal.addEventListener("abort", cancel, { once: true })
    removeAbort = () => signal.removeEventListener("abort", cancel)
    if (signal.aborted) cancel()
    const pipe = new TransformStream<Uint8Array, Uint8Array>(
      undefined,
      { highWaterMark: 16 * 1024 * 1024, size: (chunk) => chunk?.byteLength ?? 0 },
      { highWaterMark: 16 * 1024 * 1024, size: (chunk) => chunk?.byteLength ?? 0 },
    )
    const writer = pipe.writable.getWriter()
    const envelope: SupervisorInput = {
      profile: structuredClone(profile),
      argv: [...argv],
      temp,
      timeoutMs: 0,
      workloadEnv: childEnvironment(temp, profile.environment),
      cleanupTag: reaper?.tag,
      structured: true,
      redactions,
    }
    const header = Buffer.from(`${JSON.stringify(envelope)}\n`)
    if (header.length > 1024 * 1024) throw new Error("Streaming sandbox envelope exceeds 1 MiB")
    let closed = false
    const finished = runProcess(internalCommand("stream-supervisor"), {
      cwd: profile.cwd,
      env: childEnvironment(temp),
      inputStream: pipe.readable,
      signal: abort.signal,
      timeoutMs: 0,
      structured: true,
      secrets: redactions,
      maxBytes: 128 * 1024,
      onStdout: stdout,
      cleanup: () => reaper?.kill(),
    }).finally(async () => {
      closed = true
      signal.removeEventListener("abort", cancel)
      await writer.abort().catch(() => {})
      reaper?.kill()
      unregister?.()
      await rm(temp, { recursive: true, force: true })
    })
    // Observe immediately, including a spawn failure before the first write finishes.
    void finished.catch(() => {})
    try {
      await writer.write(header)
    } catch (error) {
      abort.abort(error)
      await finished.catch(() => {})
      throw error
    }
    return {
      finished,
      async write(bytes) {
        if (closed || abort.signal.aborted) throw new Error("Transport is closed")
        if (bytes.byteLength > 16 * 1024 * 1024) throw new Error("Transport write exceeds 16 MiB")
        if (writer.desiredSize === null || writer.desiredSize < bytes.byteLength)
          throw new Error("Transport input queue limit reached")
        await writer.write(Uint8Array.from(bytes))
      },
      async close() {
        abort.abort(new Error("Transport closed"))
        await finished.catch(() => {})
      },
    }
  } catch (error) {
    removeAbort?.()
    reaper?.kill()
    unregister?.()
    await rm(temp, { recursive: true, force: true })
    throw error
  }
}
