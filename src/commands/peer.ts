import { loadConfig } from "../core/config.ts"
import { PeerEndpoint, sendPeerEndpoint } from "../core/orchestration/peer-socket.ts"
import { PeerMailbox } from "../core/orchestration/peers.ts"
import { MemorySessionState } from "../core/session/control.ts"
import { createPermissionRuntime } from "../engines/codesplash/permissions.ts"
import { UsageError } from "./usage-error.ts"

export async function runPeerCommand(args: string[]) {
  const usage = "codesplash peer send ENDPOINT TARGET TEXT | listen [--duration SECONDS]"
  if (args.length === 1 && ["-h", "--help"].includes(args[0]!)) {
    process.stdout.write(`${usage}\n`)
    return 0
  }
  const [action, ...rest] = args
  const config = await loadConfig(undefined, [], { cwd: process.cwd(), workspaceTrusted: false })
  const permissions = await createPermissionRuntime({
    cwd: process.cwd(),
    workspaceTrusted: false,
    mode: config.permissions.mode,
    configRules: config.permissions,
    constraints: config.resolution?.constraints,
  })
  if (permissions.decide(action === "send" ? "send_message" : "peers", undefined, true).kind === "deny")
    throw new Error("Peer control denied by configuration")
  const write = async (value: unknown) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        process.stdout.destroy()
        reject(new Error("Peer output consumer stalled"))
      }, 5000)
      process.stdout.write(`${JSON.stringify(value)}\n`, (error) => {
        clearTimeout(timer)
        error ? reject(error) : resolve()
      })
    })
  if (action === "send") {
    if (rest.length !== 3) throw new UsageError(usage)
    await write(await sendPeerEndpoint(rest[0]!, rest[1]!, rest[2]!))
    return 0
  }
  if (action !== "listen" || (rest.length && (rest.length !== 2 || rest[0] !== "--duration")))
    throw new UsageError(usage)
  const duration = rest.length ? Number(rest[1]) : 3600
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 3600)
    throw new UsageError("Listener duration must be 1–3600 seconds")
  const mailbox = new PeerMailbox(crypto.randomUUID(), new MemorySessionState()),
    endpoint = new PeerEndpoint(mailbox)
  const stop = new AbortController(),
    abort = () => stop.abort()
  process.once("SIGTERM", abort)
  process.once("SIGINT", abort)
  const expires = setTimeout(abort, duration * 1000)
  try {
    await write(await endpoint.open())
    while (!stop.signal.aborted) {
      for (const message of mailbox.inbox("root", true)) await write(message)
      await Bun.sleep(100)
    }
  } finally {
    clearTimeout(expires)
    process.off("SIGTERM", abort)
    process.off("SIGINT", abort)
    await endpoint.close()
  }
  return 0
}
