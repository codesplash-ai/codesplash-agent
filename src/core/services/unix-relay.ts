import { lstatSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { type Readable, Writable } from "node:stream"
import { directory, hostPath } from "../session/files.ts"
import { UnixSocket } from "./unix-socket.ts"

/** Local, explicit stdio transport. No listening port, shell, credential injection or reconnection. */
export async function relayUnixSocket(
  path: string,
  input: Readable,
  output: Writable,
  options: { signal?: AbortSignal; maxBytes?: number; timeoutMs?: number } = {},
) {
  if (process.platform === "win32") throw new Error("Unix socket relay is unavailable on Windows")
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024,
    timeoutMs = options.timeoutMs ?? 300000
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 256 * 1024 * 1024 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 3600000
  )
    throw new Error("Invalid relay byte/time limits")
  path = hostPath(resolve(path))
  if (Buffer.byteLength(path) > 100 || path.includes("\0"))
    throw new Error("Socket path exceeds portable Unix socket limit")
  directory(dirname(path))
  const owned = () => {
    const parent = lstatSync(dirname(path)),
      file = lstatSync(path)
    if (
      parent.uid !== process.getuid?.() ||
      parent.mode & 0o077 ||
      !file.isSocket() ||
      file.isSymbolicLink() ||
      file.uid !== process.getuid?.() ||
      file.mode & 0o077
    )
      throw new Error("Relay requires a private owned socket in a private owned directory")
    return `${file.dev}:${file.ino}`
  }
  const identity = owned()
  options.signal?.throwIfAborted()
  const controller = new AbortController()
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)])
  const socket = new UnixSocket(signal, Math.min(timeoutMs, 60000))
  let transferred = 0
  const debit = (size: number) => {
    transferred += size
    if (transferred > maxBytes) throw new Error("Relay byte limit exceeded")
  }
  let rejectFailure: (error: Error) => void = () => {}
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject
  })
  const fail = (error: Error) => {
    controller.abort(error)
    rejectFailure(error)
  }
  const upstream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        debit(chunk.length)
      } catch (error) {
        callback(error as Error)
        return
      }
      void socket.send(chunk).then(
        () => callback(),
        (error) => callback(error),
      )
    },
    final(callback) {
      try {
        socket.end()
        callback()
      } catch (error) {
        callback(error as Error)
      }
    },
  })
  upstream.on("error", fail)
  input.on("error", fail)
  output.on("error", fail)
  try {
    await socket.connect(path)
    if (owned() !== identity) throw new Error("Socket identity changed")
    input.pipe(upstream)
    await Promise.race([
      failure,
      (async () => {
        for (;;) {
          const data = await socket.receive()
          if (!data) break
          debit(data.length)
          await new Promise<void>((done, reject) => {
            const abort = () => reject(signal.reason)
            signal.addEventListener("abort", abort, { once: true })
            output.write(data, (error) => {
              signal.removeEventListener("abort", abort)
              error ? reject(error) : done()
            })
            if (signal.aborted) abort()
          })
        }
      })(),
    ])
    return { transferred }
  } finally {
    controller.abort(new Error("Relay finished"))
    socket.close()
    input.unpipe(upstream)
    input.pause()
    upstream.destroy()
    input.off("error", fail)
    output.off("error", fail)
  }
}
