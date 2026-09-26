import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import type { HarnessTool } from "../contracts.ts"
import type { SandboxRuntime } from "../sandbox/contracts.ts"
import { childEnvironment } from "../sandbox/env-policy.ts"
import { runProcess } from "../sandbox/process.ts"
import { contains, physicalPath } from "../sandbox/profile.ts"
import { bashTool } from "./bash.ts"

export type ExecutionEnvironment =
  | { id: string; transport: "local" }
  | { id: string; transport: "container"; image: string; executable: string; runtimeDirectory?: string }
  | {
      id: string
      transport: "ssh"
      host: string
      port: number
      user: string
      identity: string
      knownHosts: string
    }

/** Operator-supplied capability descriptions. Models choose ids, never connection flags. */
export function validateEnvironments(raw: unknown): ExecutionEnvironment[] {
  if (!Array.isArray(raw) || raw.length > 16)
    throw new Error("Execution environments must be a list of at most 16 entries")
  const ids = new Set<string>()
  for (const item of raw) {
    if (!item || !/^[a-z][a-z0-9-]{0,63}$/.test(item.id) || ids.has(item.id))
      throw new Error("Invalid or duplicate environment id")
    ids.add(item.id)
    if (item.transport === "local") continue
    if (
      item.transport === "container" &&
      typeof item.image === "string" &&
      /^[a-zA-Z0-9._/:-]+@sha256:[a-f0-9]{64}$/.test(item.image) &&
      typeof item.executable === "string" &&
      isAbsolute(item.executable) &&
      (item.runtimeDirectory === undefined ||
        (typeof item.runtimeDirectory === "string" && isAbsolute(item.runtimeDirectory)))
    )
      continue
    if (
      item.transport === "ssh" &&
      /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(item.host) &&
      /^[a-z_][a-z0-9_-]{0,63}$/.test(item.user) &&
      Number.isInteger(item.port) &&
      item.port > 0 &&
      item.port < 65536 &&
      typeof item.identity === "string" &&
      isAbsolute(item.identity) &&
      typeof item.knownHosts === "string" &&
      isAbsolute(item.knownHosts)
    )
      continue
    throw new Error(
      "Invalid execution environment; containers require digest pins, SSH requires fixed identity and known-host files",
    )
  }
  return structuredClone(raw)
}
export function environmentTool(
  raw: ExecutionEnvironment[],
  sandbox: SandboxRuntime,
  allowLoopback = true,
): HarnessTool {
  const environments = validateEnvironments(raw)
  return {
    name: "environment_exec",
    description: `Run a command in a reviewed environment (${environments.map((e) => `${e.id}:${e.transport}`).join(", ")}). Local uses the native sandbox. Containers have no host mounts or network. SSH has fixed identity and strict host keys. External changes cannot be restored locally.`,
    permissionName: "bash",
    effects: "workspace-and-external",
    alwaysAsk: () => true,
    allowPersistentApproval: false,
    isReadOnly: () => false,
    inputSchema: {
      type: "object",
      properties: {
        environment: { type: "string", enum: environments.map((e) => e.id) },
        command: { type: "string", maxLength: 65536 },
        timeout_ms: { type: "integer", minimum: 100, maximum: 30000 },
      },
      required: ["environment", "command"],
      additionalProperties: false,
    },
    permissionTargets: (input) => ({ command: (input as { command: string }).command }),
    permission: () => ({
      kind: "approval",
      title: "Execute in reviewed environment?",
      detail:
        "This command can change local or remote state. Cancellation stops the transport; remote effects may already have completed.",
    }),
    async run(input, context) {
      const p = input as { environment: string; command: string; timeout_ms?: number },
        env = environments.find((e) => e.id === p?.environment)
      if (!env || typeof p.command !== "string" || p.command.length > 65536 || p.command.includes("\0"))
        throw new Error("Invalid environment command")
      const timeout = p.timeout_ms ?? 30000
      if (
        !Number.isInteger(timeout) ||
        timeout < 100 ||
        timeout > 30000 ||
        context.policy.permissionMode === "plan" ||
        context.policy.sandbox === "read-only"
      )
        throw new Error("Execution requires writable non-plan policy and a bounded timeout")
      if (env.transport === "local")
        return sandbox.runTool(bashTool, { command: p.command, timeout }, context)
      const name = `codesplash-${crypto.randomUUID()}`
      const argv =
        env.transport === "container"
          ? [
              env.executable,
              "run",
              "--name",
              name,
              "--rm",
              "--pull=never",
              "--network=none",
              "--read-only",
              "--cap-drop=ALL",
              "--security-opt=no-new-privileges",
              "--pids-limit=64",
              "--memory=256m",
              "--cpus=1",
              "--tmpfs=/tmp:rw,noexec,nosuid,size=32m",
              "-i",
              env.image,
              "/bin/sh",
              "-c",
              // BusyBox timeout execs the command. Keep it below PID 1 so its watchdog can
              // deliver SIGKILL; namespace init ignores that signal from its descendants.
              'timeout -s TERM -k 2 "$1" /bin/sh -s; result=$?; exit "$result"',
              "codesplash-timeout",
              String(Math.ceil(timeout / 1000)),
            ]
          : [
              "/usr/bin/ssh",
              "-F",
              "/dev/null",
              "-T",
              "-o",
              "BatchMode=yes",
              "-o",
              "StrictHostKeyChecking=yes",
              "-o",
              "IdentitiesOnly=yes",
              "-o",
              "ForwardAgent=no",
              "-o",
              "ClearAllForwardings=yes",
              "-o",
              "ConnectTimeout=5",
              "-o",
              `UserKnownHostsFile=${env.knownHosts}`,
              "-i",
              env.identity,
              "-p",
              String(env.port),
              "--",
              `${env.user}@${env.host}`,
              "/bin/sh -s",
            ]
      if (env.transport === "ssh" && env.host === "127.0.0.1" && !allowLoopback)
        throw new Error("Managed host policy refuses loopback SSH")
      if (env.transport === "ssh" && (env.host !== "127.0.0.1" || !allowLoopback))
        context.checkNetwork?.(`ssh://${env.host}:${env.port}`)
      const protectedInputs =
        env.transport === "container"
          ? [env.executable, ...(env.runtimeDirectory ? [env.runtimeDirectory] : [])]
          : [env.identity, env.knownHosts]
      if (
        protectedInputs.some((path) =>
          sandbox.profile.writeRoots.some((root) => contains(root, physicalPath(path))),
        )
      )
        throw new Error("Execution credentials and runtimes must stay outside model-writable roots")
      const owner = await mkdtemp(join(tmpdir(), "codesplash-environment-"))
      const processEnv = childEnvironment(owner)
      if (env.transport === "container" && env.runtimeDirectory)
        processEnv.XDG_RUNTIME_DIR = env.runtimeDirectory
      try {
        const result = await runProcess(argv, {
          cwd: context.cwd,
          env: processEnv,
          input: p.command,
          signal: context.signal,
          timeoutMs: timeout,
          maxBytes: 50000,
        })
        return {
          text:
            context.sanitizeOutput?.(
              `${result.stdout}${result.stderr}\n[${result.kind}; ${env.transport}]`,
            ) ?? `${result.stdout}${result.stderr}\n[${result.kind}]`,
          label: `Environment ${env.id}`,
          isError: result.kind !== "success",
        }
      } finally {
        try {
          if (env.transport === "container")
            await runProcess([env.executable, "rm", "--force", name], {
              cwd: context.cwd,
              env: processEnv,
              signal: AbortSignal.timeout(5000),
              timeoutMs: 5000,
              maxBytes: 1024,
            })
        } finally {
          await rm(owner, { recursive: true, force: true })
        }
      }
    },
  }
}
