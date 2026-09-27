import { chmod, mkdtemp, rm } from "node:fs/promises"
import { createConnection, createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExecutionResult } from "../engines/codesplash/sandbox/contracts.ts"
import { internalCommand } from "../engines/codesplash/sandbox/entrypoint.ts"
import { childEnvironment, SecretSanitizer } from "../engines/codesplash/sandbox/env-policy.ts"
import { runProcess } from "../engines/codesplash/sandbox/process.ts"
import { contains, physicalPath, validateProfile } from "../engines/codesplash/sandbox/profile.ts"
import type { SupervisorInput } from "../engines/codesplash/sandbox/supervisor.ts"
import type { StartupIsolation } from "./startup-isolation.ts"

type Options = Parameters<typeof runProcess>[1]
const roles = ["supervisor", "stream-supervisor", "pty-supervisor"] as const
/** A private capability channel. The agent may only request nested profiles beneath its startup grants. */
export async function startStartupBridge(profile: StartupIsolation, owner: string) {
  const path = join(owner, "bridge.sock"),
    token = crypto.randomUUID(),
    clients = new Map<Socket, AbortController>(),
    jobs = new Set<Promise<unknown>>()
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (clients.size >= 16) {
      socket.destroy()
      return
    }
    const abort = new AbortController()
    clients.set(socket, abort)
    const pipe = new TransformStream<Uint8Array, Uint8Array>(),
      writer = pipe.writable.getWriter()
    let pending = Buffer.alloc(0),
      started = false,
      closed = false,
      queued = 0
    let task = Promise.resolve()
    const send = async (value: unknown) => {
      if (socket.destroyed) throw Error("Bridge disconnected")
      if (!socket.write(`${JSON.stringify(value)}\n`))
        await new Promise<void>((resolve, reject) => {
          socket.once("drain", resolve)
          socket.once("error", reject)
        })
    }
    socket.on("close", () => {
      abort.abort()
      void writer.abort().catch(() => {})
      clients.delete(socket)
    })
    socket.on("error", () => abort.abort())
    socket.on("data", (chunk) => {
      queued += chunk.length
      if (queued > 16 * 1024 * 1024) {
        socket.destroy()
        return
      }
      task = task
        .then(async () => {
          queued -= chunk.length
          pending = Buffer.concat([pending, chunk])
          if (pending.length > 12 * 1024 * 1024) throw Error("Bridge frame too large")
          for (let at = pending.indexOf(10); at >= 0; at = pending.indexOf(10)) {
            const value = JSON.parse(pending.subarray(0, at).toString())
            pending = pending.subarray(at + 1)
            if (!started) {
              if (
                value.token !== token ||
                !roles.includes(value.role) ||
                typeof value.input !== "string" ||
                Buffer.byteLength(value.input) > 8 * 1024 * 1024
              )
                throw Error("Invalid startup capability request")
              const input = JSON.parse(value.input) as SupervisorInput,
                p = validateProfile(input.profile)
              const readRoots = [profile.workspace, ...(profile.readRoots ?? [])]
              if (
                p.mode === "danger-full-access" ||
                !contains(profile.workspace, physicalPath(p.cwd)) ||
                p.readRoots.some((root) => !readRoots.some((grant) => contains(grant, physicalPath(root)))) ||
                p.writeRoots.some((root) => !contains(profile.workspace, physicalPath(root))) ||
                !contains(owner, physicalPath(input.temp)) ||
                physicalPath(input.temp) === owner ||
                !Number.isInteger(input.timeoutMs) ||
                input.timeoutMs < 0 ||
                input.timeoutMs > 3600000 ||
                (input.planFile !== undefined && !contains(profile.workspace, physicalPath(input.planFile)))
              )
                throw Error("Tool profile exceeds whole-agent startup grants")
              // Force trusted ceilings even if a compromised agent forges its inner profile.
              const requestedTemp = physicalPath(input.temp)
              const privateTemp = physicalPath(await mkdtemp(join(tmpdir(), "cs-startup-job-")))
              input.temp = privateTemp
              input.workloadEnv = {
                ...input.workloadEnv,
                HOME: privateTemp,
                TMPDIR: privateTemp,
                TMP: privateTemp,
                TEMP: privateTemp,
              }
              input.profile = {
                ...p,
                readRoots: [...p.readRoots, requestedTemp],
                deniedReadPaths: [...p.deniedReadPaths, profile.configDirectory, profile.dataDirectory, path],
                protectedPaths: [...p.protectedPaths, profile.configDirectory, profile.dataDirectory, path],
              }
              delete input.cleanupTag
              input.hostNetworkEnv = { ...process.env, CODESPLASH_AGENT_CONFIG_DIR: profile.configDirectory }
              started = true
              const header = JSON.stringify(input) + (value.role === "supervisor" ? "" : "\n")
              const supervisorArgv =
                process.platform === "linux"
                  ? (await import("./startup-isolation.ts")).startupArgv(
                      profile,
                      privateTemp,
                      internalCommand(value.role),
                    )
                  : internalCommand(value.role)
              const result = runProcess(supervisorArgv, {
                cwd: p.cwd,
                env: childEnvironment(input.temp),
                signal: abort.signal,
                input: value.role === "supervisor" ? header : undefined,
                inputStream: value.role === "supervisor" ? undefined : pipe.readable,
                timeoutMs: input.timeoutMs ? input.timeoutMs + 15000 : 0,
                structured: true,
                maxBytes: 10 * 1024 * 1024,
                onStdout:
                  value.role === "supervisor"
                    ? undefined
                    : async (bytes) => send({ kind: "output", data: Buffer.from(bytes).toString("base64") }),
              })
                .then(async (result) => {
                  await send({ kind: "result", result })
                  socket.end()
                })
                .catch(() => {
                  socket.destroy()
                })
                .finally(() => rm(privateTemp, { recursive: true, force: true }))
              jobs.add(result)
              void result.finally(() => jobs.delete(result))
              if (value.role !== "supervisor") await writer.write(Buffer.from(header))
            } else if (
              value.kind === "input" &&
              !closed &&
              typeof value.data === "string" &&
              value.data.length < 2 * 1024 * 1024
            )
              await writer.write(Buffer.from(value.data, "base64"))
            else if (value.kind === "end" && !closed) {
              closed = true
              await writer.close()
            } else throw Error("Invalid bridge input")
          }
        })
        .catch(() => {
          socket.destroy()
        })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(path, resolve)
  })
  await chmod(path, 0o600)
  return {
    path,
    token,
    async close() {
      for (const [socket, abort] of clients) {
        abort.abort()
        socket.destroy()
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await Promise.allSettled([...jobs])
    },
  }
}
export async function runStartupTransport(role: string, options: Options): Promise<ExecutionResult> {
  const path = process.env.CODESPLASH_STARTUP_BRIDGE,
    token = process.env.CODESPLASH_STARTUP_TOKEN
  if (!path || !token) throw Error("Missing startup bridge capability")
  const socket = createConnection({ path }),
    decoder = new TextDecoder(),
    sanitizer = new SecretSanitizer(options.secrets ?? [])
  let pending = "",
    output = "",
    result: ExecutionResult | undefined,
    header = "",
    timer: ReturnType<typeof setTimeout> | undefined
  const abort = () => socket.destroy(new Error("Startup transport interrupted"))
  options.signal.addEventListener("abort", abort, { once: true })
  if (options.signal.aborted) abort()
  if (options.timeoutMs) timer = setTimeout(abort, options.timeoutMs)
  const send = async (value: unknown) => {
    if (!socket.write(`${JSON.stringify(value)}\n`))
      await new Promise<void>((resolve, reject) => {
        socket.once("drain", resolve)
        socket.once("error", reject)
      })
  }
  const pump = (async () => {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve)
      socket.once("error", reject)
    })
    if (options.input !== undefined) await send({ token, role, input: options.input })
    else if (options.inputStream) {
      const reader = options.inputStream.getReader()
      let started = false
      try {
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          let value = Buffer.from(next.value)
          if (!started) {
            const at = value.indexOf(10)
            header += value.subarray(0, at < 0 ? undefined : at).toString()
            if (header.length > 1024 * 1024) throw Error("Oversized startup envelope")
            if (at < 0) continue
            await send({ token, role, input: header })
            started = true
            value = value.subarray(at + 1)
          }
          for (let at = 0; at < value.length; at += 65536)
            await send({ kind: "input", data: value.subarray(at, at + 65536).toString("base64") })
        }
        await send({ kind: "end" })
      } finally {
        reader.releaseLock()
      }
    } else throw Error("Missing startup envelope")
  })().catch((error) => socket.destroy(error))
  void pump
  try {
    for await (const chunk of socket) {
      pending += decoder.decode(chunk, { stream: true })
      if (pending.length > 16 * 1024 * 1024) throw Error("Oversized startup response")
      for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
        const frame = JSON.parse(pending.slice(0, at))
        pending = pending.slice(at + 1)
        if (frame.kind === "output") {
          const data = Buffer.from(frame.data, "base64")
          await options.onStdout?.(data)
          output = (output + sanitizer.push(data.toString())).slice(-(options.maxBytes ?? 1048576))
        } else if (frame.kind === "result") result = frame.result
        else throw Error("Invalid startup response")
      }
    }
    if (!result) throw Error("Startup supervisor ended without a result")
    return options.onStdout ? { ...result, stdout: output + sanitizer.push("", true) } : result
  } catch (error) {
    if (options.signal.aborted)
      return { kind: "interrupted", exitCode: 130, stdout: output, stderr: "Startup transport interrupted" }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    options.signal.removeEventListener("abort", abort)
    socket.destroy()
  }
}
