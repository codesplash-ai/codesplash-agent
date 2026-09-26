import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { dataDirectory } from "../core/config.ts"
import { bytes } from "../core/session/files.ts"
import { readTrustDecision } from "../core/trust.ts"
import { UsageError } from "./usage-error.ts"

export async function runServerCommand(command: string, args: string[]) {
  const usage =
    "codesplash serve [--stdio] [--root DIR] [--cwd DIR] [--port N] [--share manual|auto|disabled] | attach THREAD [--reader|--shared|--exclusive] [--steal] [--root DIR] | acp | mcp-server | generate [DIR] | daemon status|pair [--root DIR]"
  if (args.includes("--help")) {
    process.stdout.write(`${usage}\n`)
    return 0
  }
  let root = join(dataDirectory(), "daemon"),
    cwd = process.cwd(),
    port = 4096,
    stdio = false,
    steal = false,
    mode: "reader" | "shared" | "exclusive" = "shared",
    share: "manual" | "auto" | "disabled" = "disabled"
  let hostname = "127.0.0.1",
    mdns = false,
    cert: string | undefined,
    key: string | undefined
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (["--root", "--cwd", "--port", "--share", "--listen", "--tls-cert", "--tls-key"].includes(arg)) {
      const value = args[++i]
      if (!value || value.startsWith("--")) throw new UsageError(`Value required for ${arg}`)
      if (arg === "--listen") hostname = value
      if (arg === "--tls-cert") cert = bytes(resolve(value), 1024 * 1024).toString()
      if (arg === "--tls-key") key = bytes(resolve(value), 1024 * 1024).toString()
      if (arg === "--root") root = resolve(value)
      if (arg === "--cwd") cwd = resolve(value)
      if (arg === "--port") {
        port = Number(value)
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError("Invalid port")
      }
      if (arg === "--share") {
        if (!["manual", "auto", "disabled"].includes(value)) throw new UsageError("Invalid sharing mode")
        share = value as "manual" | "auto" | "disabled"
      }
    } else if (arg === "--stdio") stdio = true
    else if (arg === "--mdns") mdns = true
    else if (arg === "--steal") steal = true
    else if (["--reader", "--shared", "--exclusive"].includes(arg)) mode = arg.slice(2) as typeof mode
    else if (arg.startsWith("-")) throw new UsageError(`Unknown server option ${arg}`)
    else positional.push(arg)
  }
  if (command === "generate") {
    if (positional.length > 1) throw new UsageError(usage)
    const destination = resolve(positional[0] ?? "codesplash-protocol-v1"),
      { generatedContract } = await import("../server/protocol.ts"),
      contract = generatedContract()
    await mkdir(destination, { recursive: true })
    for (const [name, content] of [
      ["protocol.ts", contract.types],
      ["schema.json", JSON.stringify(contract.schema, null, 2)],
      ["openapi.json", JSON.stringify(contract.openapi, null, 2)],
    ] as const)
      await writeFile(join(destination, name), content, { flag: "wx" })
    process.stdout.write(`${destination}\n`)
    return 0
  }
  if (command === "attach" || command === "daemon") {
    if (positional.length !== 1) throw new UsageError(usage)
    const metadata = JSON.parse(bytes(join(root, "daemon.json"), 4096).toString()) as {
      url: string
      pid: number
    }
    const token = bytes(join(root, "token"), 128).toString()
    const { DaemonClient } = await import("../server/client.ts"),
      client = new DaemonClient(metadata.url, token)
    if (command === "attach") {
      await (await import("../tui/run-attach.tsx")).runAttach(client, positional[0]!, cwd, mode, steal)
      return 0
    }
    try {
      if (positional[0] === "status") {
        await client.initialize()
        process.stdout.write(`${JSON.stringify({ ...metadata, threads: await client.rpc("thread/list") })}\n`)
      } else if (positional[0] === "pair") {
        const response = await fetch(new URL("pair", metadata.url), {
          method: "POST",
          headers: client.headers(),
        })
        if (!response.ok) throw new Error("Pairing unavailable")
        process.stdout.write(`${JSON.stringify(await response.json())}\n`)
      } else throw new UsageError(usage)
    } finally {
      await client.close()
    }
    return 0
  }
  if (positional.length) throw new UsageError(usage)
  const trustedWorkspace = async (path: string) => (await readTrustDecision(path))?.trusted === true
  if (command === "acp" || command === "mcp-server" || stdio) {
    const { Hub } = await import("../server/hub.ts"),
      { lease, directory } = await import("../core/session/files.ts")
    const isolated = join(root, `${command}-stdio`)
    directory(isolated, true)
    const release = lease(isolated, "daemon.lease")
    try {
      const hub = await Hub.open({ root: isolated, workspaces: [cwd], trustedWorkspace })
      if (command === "serve") await (await import("../server/transport.ts")).stdio(hub)
      else
        await (await import("../server/adapters.ts")).adapterStdio(
          hub,
          command === "acp" ? "acp" : "mcp",
          cwd,
        )
    } finally {
      release()
    }
    return 0
  }
  if (command !== "serve") throw new UsageError(usage)
  const { serve } = await import("../server/transport.ts"),
    { webClient } = await import("../server/web.ts"),
    { ShareStore } = await import("../server/sharing.ts")
  const shares = new ShareStore(join(root, "shares"), share)
  if (!!cert !== !!key || (!["127.0.0.1", "::1"].includes(hostname) && (!cert || !key)))
    throw new UsageError("LAN listeners require --tls-cert and --tls-key; bind a concrete interface address")
  if (hostname === "0.0.0.0" || hostname === "::")
    throw new UsageError("Bind a concrete interface address for strict Host validation")
  if (mdns && ["127.0.0.1", "::1"].includes(hostname))
    throw new UsageError("mDNS requires a concrete LAN interface and TLS")
  const daemon = await serve({
    hostname,
    ...(cert && key ? { tls: { cert, key } } : {}),
    root,
    workspaces: [cwd],
    trustedWorkspace,
    port,
    web: webClient,
    onShare: (action, thread, id) =>
      action === "create"
        ? shares.create(thread.id, thread.session, daemon.url)
        : shares.revoke(thread.id, id ?? ""),
    publicRoute: (request) => shares.route(request),
  })
  if (share === "auto") shares.auto(daemon.hub, daemon.url)
  const discovery = mdns
    ? await (await import("../server/discovery.ts")).advertise(daemon.server.port!, hostname)
    : undefined
  process.stderr.write(
    `CodeSplash daemon: ${daemon.url}\nCredential file: ${daemon.tokenPath}\nWorkspace: ${cwd}\nSharing: ${share}\n`,
  )
  const { deferSignalExit } = await import("../core/lifecycle.ts"),
    release = deferSignalExit()
  try {
    await new Promise<void>((done) => {
      const stop = () => {
        process.off("SIGINT", stop)
        process.off("SIGTERM", stop)
        done()
      }
      process.on("SIGINT", stop)
      process.on("SIGTERM", stop)
    })
  } finally {
    await discovery?.close()
    await shares.close()
    await daemon.close()
    release()
  }
  return 0
}
