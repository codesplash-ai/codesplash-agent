import { join, resolve } from "node:path"
import { dataDirectory } from "../core/config.ts"
import { bytes, directory, lease } from "../core/session/files.ts"
import { ChatBridge, ledgerPath } from "../integrations/bridge.ts"
import { GithubApp, type GithubPolicy } from "../integrations/github.ts"
import { type SlackPolicy, SlackSocketBridge } from "../integrations/slack.ts"
import { Hub } from "../server/hub.ts"
import { UsageError } from "./usage-error.ts"

export async function runIntegrationsCommand(args: string[]) {
  if (args.length !== 2 || !["github", "slack"].includes(args[0] ?? ""))
    throw new UsageError("codesplash integrations github|slack OPERATOR_CONFIG.json")
  const service = args[0]!,
    config = JSON.parse(bytes(resolve(args[1]!), 65536).toString()) as {
      cwd: string
      root?: string
      port?: number
      policy: GithubPolicy & SlackPolicy
      appId?: string
      appTokenEnv?: string
      botTokenEnv?: string
      privateKeyEnv?: string
      webhookSecretEnv?: string
    }
  if (typeof config.cwd !== "string" || !config.policy)
    throw new Error("Integration config requires cwd and policy")
  const root = config.root ? resolve(config.root) : join(dataDirectory(), "integrations", service)
  directory(root, true)
  const release = lease(root, "daemon.lease")
  const stop = new AbortController(),
    interrupt = () => stop.abort()
  const { deferSignalExit } = await import("../core/lifecycle.ts"),
    releaseSignals = deferSignalExit()
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", interrupt)
  let hub: Hub | undefined, bridge: ChatBridge | undefined
  const secret = (name: string | undefined) => {
    if (!name || !process.env[name])
      throw new Error("Required integration credential environment variable is missing")
    return process.env[name] as string
  }
  try {
    hub = await Hub.open({ root, workspaces: [config.cwd] })
    bridge = new ChatBridge(hub, ledgerPath(root, service), config.cwd)
    await bridge.start()
    if (service === "slack") {
      if (
        typeof config.policy.team !== "string" ||
        !Array.isArray(config.policy.channels) ||
        !Array.isArray(config.policy.users) ||
        !config.policy.channels.length ||
        !config.policy.users.length
      )
        throw new Error("Slack requires explicit team/channel/user allowlists")
      const socket = new SlackSocketBridge({
        appToken: secret(config.appTokenEnv),
        botToken: secret(config.botTokenEnv),
        policy: config.policy,
        bridge,
      })
      try {
        await socket.run(stop.signal)
      } finally {
        socket.close()
      }
    } else {
      const p = config.policy
      if (
        !/^[\w.-]+\/[\w.-]+$/.test(p.repository) ||
        !/^\d+$/.test(p.repositoryId) ||
        !p.ref?.startsWith("refs/heads/") ||
        !p.workflowRef ||
        !/^[a-f0-9]{40}$/.test(p.workflowSha) ||
        !p.audience ||
        !Number.isSafeInteger(p.installationId) ||
        p.installationId < 1 ||
        !Array.isArray(p.allowedActors) ||
        !p.allowedActors.length ||
        !config.appId
      )
        throw new Error("GitHub requires pinned repository, branch, workflow identity and actor allowlist")
      const app = new GithubApp({
        policy: p,
        appId: config.appId,
        privateKey: secret(config.privateKeyEnv),
        webhookSecret: secret(config.webhookSecretEnv),
        bridge,
      })
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: config.port ?? 4097,
        maxRequestBodySize: 1024 * 1024,
        fetch: (request) => app.route(request),
      })
      process.stderr.write(
        `GitHub App listener: ${server.url} (publish through your authenticated TLS ingress)\n`,
      )
      try {
        if (!stop.signal.aborted)
          await new Promise<void>((resolve) =>
            stop.signal.addEventListener("abort", () => resolve(), { once: true }),
          )
      } finally {
        await server.stop(true)
      }
    }
  } finally {
    stop.abort()
    await bridge?.close()
    await hub?.close()
    release()
    releaseSignals()
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
  }
  return 0
}
