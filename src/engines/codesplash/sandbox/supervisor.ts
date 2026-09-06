import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime"
import { parse } from "shell-quote"
import { installSignalHandlers, registerChildProcess } from "../../../core/lifecycle.ts"
import type { ExecutionResult, SandboxProfile } from "./contracts.ts"
import { installationRoot } from "./entrypoint.ts"
import { childEnvironment } from "./env-policy.ts"
import { assertPrivateInodes } from "./inodes.ts"
import { hardenLinuxMounts } from "./linux-mounts.ts"
import { createMacReaper, macCleanupPolicy } from "./macos-reaper.ts"
import { startNetworkBroker } from "./network-broker.ts"
import { runProcess } from "./process.ts"

export type SupervisorInput = {
  profile: SandboxProfile
  argv: string[]
  input?: string
  temp: string
  planFile?: string
  secrets?: Record<string, string>
  timeoutMs: number
  structured?: boolean
  redactions?: string[]
  workloadEnv?: NodeJS.ProcessEnv
  cleanupTag?: string
  deniedFile?: string
}

export function runtimeConfig(input: SupervisorInput): SandboxRuntimeConfig {
  const p = input.profile
  const runtimeReads = [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/System",
    "/Library",
    "/opt/homebrew",
    "/dev",
    "/etc",
    "/private/etc",
    "/private/var/select",
    process.execPath,
    installationRoot(),
    input.temp,
  ].filter(existsSync)
  const denyWrite = p.protectedPaths.filter((path) => !input.planFile || path !== dirname(input.planFile))
  return {
    network: {
      allowedDomains: p.allowedHosts,
      deniedDomains: [],
      strictAllowlist: true,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: [
        "/",
        ...p.deniedReadPaths,
        "**/.env",
        "**/.env.*",
        "**/*.pem",
        "**/*.p12",
        "**/id_rsa*",
        "**/id_ed25519*",
      ],
      allowRead: [...runtimeReads, ...p.readRoots, ...p.writeRoots],
      allowWrite: [...(input.planFile ? [input.planFile] : p.writeRoots), input.temp],
      denyWrite: [
        ...denyWrite,
        installationRoot(),
        ...(input.deniedFile ? [input.deniedFile] : []),
        "/tmp/claude",
        "/private/tmp/claude",
        "**/.git/**",
        "**/.git",
      ],
    },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowPty: false,
  }
}

/** Dedicated trusted process: its manager and broker are never shared across commands. */
export async function runSupervisor(input: SupervisorInput): Promise<ExecutionResult> {
  if (process.platform !== "darwin" && process.platform !== "linux")
    return {
      kind: "unavailable",
      exitCode: 126,
      stdout: "",
      stderr: "Native sandbox requires macOS or Linux",
    }
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime")
  let broker: Awaited<ReturnType<typeof startNetworkBroker>> | undefined
  let reaper: Awaited<ReturnType<typeof createMacReaper>> | undefined
  let unregister: (() => void) | undefined
  const signal = new AbortController()
  try {
    if (process.platform === "darwin") {
      reaper = await createMacReaper(input.cleanupTag)
      unregister = registerChildProcess(reaper)
    }
    broker = await startNetworkBroker(input.profile.allowedHosts)
    const sensitive = await assertPrivateInodes(input.profile, signal.signal)
    if (process.platform === "linux") {
      // A mode-000 read-only bind refuses access rather than returning /dev/null's
      // misleading empty success. The source itself is also a protected mount.
      input.deniedFile = join(input.temp, `.denied-read-${crypto.randomUUID()}`)
      await writeFile(input.deniedFile, "", { flag: "wx", mode: 0o600 })
      await chmod(input.deniedFile, 0)
    }
    const config = runtimeConfig(input)
    config.network.parentProxy = { http: broker.url, https: broker.url, noProxy: "" }
    // Runtime helpers must be available beside compiled distributions as well as npm installs.
    if (process.platform === "linux") {
      const helper = await verifiedSeccompHelper()
      config.seccomp = { applyPath: helper }
      config.filesystem.allowRead?.push(helper)
      config.filesystem.denyWrite?.push(dirname(helper))
    }
    await SandboxManager.initialize(config, undefined, true)
    const dependencies = await SandboxManager.checkDependenciesAsync()
    if (dependencies.errors.length || dependencies.warnings.length)
      throw new Error([...dependencies.errors, ...dependencies.warnings].join("; "))
    const id = crypto.randomUUID()
    const command = input.argv.map(shellQuote).join(" ")
    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      command,
      "/bin/bash",
      undefined,
      signal.signal,
      input.profile.cwd,
      { commandId: id },
    )
    const env = { ...childEnvironment(input.temp), ...input.workloadEnv, ...wrapped.env, ...input.secrets }
    const argv = hardenSandboxArgv(wrapped.argv, config.filesystem, reaper?.tag, input.deniedFile, sensitive)
    const result = await runProcess(argv, {
      cwd: input.profile.cwd,
      env,
      input: input.input,
      signal: signal.signal,
      timeoutMs: input.timeoutMs,
      structured: input.structured,
      secrets: input.structured ? [] : (input.redactions ?? Object.values(input.secrets ?? {})),
      cleanup: () => reaper?.kill(),
    })
    const violations = SandboxManager.getSandboxViolationStore().getViolationsForCommand(id)
    if (result.kind === "command-failure" && violations.length) result.kind = "sandbox-denial"
    return result
  } catch (error) {
    return {
      kind: "unavailable",
      exitCode: 126,
      stdout: "",
      stderr: `Sandbox unavailable; no unrestricted fallback or retry was attempted. ${error instanceof Error ? error.message : "Backend initialization failed"}`,
    }
  } finally {
    reaper?.kill()
    unregister?.()
    await SandboxManager.reset()
    broker?.close()
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Decode only the pinned backend's generated, fully quoted wrapper, never model shell text. */
export function hardenSandboxArgv(
  wrapper: string[],
  filesystem: SandboxRuntimeConfig["filesystem"],
  cleanupTag?: string,
  deniedFile?: string,
  sensitive: Array<{ path: string; directory: boolean }> = [],
): string[] {
  if (wrapper.length !== 3 || wrapper[1] !== "-c" || !wrapper[2])
    throw new Error("Unexpected sandbox wrapper")
  const parts = parse(wrapper[2], () => {
    throw new Error("Unexpected variable in sandbox wrapper")
  })
  if (parts.some((part) => typeof part !== "string"))
    throw new Error("Unexpected operator in sandbox wrapper")
  const argv = parts as string[]
  if (process.platform === "linux") return hardenLinuxMounts(argv, filesystem, deniedFile, sensitive)
  const at = argv.indexOf("/usr/bin/sandbox-exec")
  if (argv[0] !== "env" || at < 1 || argv[at + 1] !== "-p" || !argv[at + 2]?.startsWith("(version 1)"))
    throw new Error("Unexpected macOS sandbox profile")
  argv[0] = "/usr/bin/env"
  // Amend the single kernel policy: macOS refuses sandbox_init twice. This
  // deny survives exec/fork and prevents hardlinks to granted read-only files.
  argv[at + 2] += "\n(deny file-link)\n"
  if (!cleanupTag) throw new Error("Missing macOS process cleanup identity")
  argv[at + 2] += macCleanupPolicy(cleanupTag)
  return argv
}

export async function verifiedSeccompHelper(): Promise<string> {
  const expected: Record<string, string> = {
    arm64: "9ace43a76dab5650b5e544230814eaaac8f2136f4a40c2f6069f0631fee230e1",
    x64: "64fa7514fa7199584b836159885e59b9ce3684fb8fef7e13de49965b23f54f6b",
  }
  if (!expected[process.arch]) throw new Error("No verified seccomp helper for this architecture")
  const candidates = [join(dirname(process.execPath), "sandbox-runtime", "apply-seccomp")]
  if (!import.meta.url.includes("/$bunfs/"))
    candidates.push(
      join(
        dirname(dirname(fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime")))),
        "vendor",
        "seccomp",
        process.arch,
        "apply-seccomp",
      ),
    )
  const path = candidates.find(existsSync)
  if (!path) throw new Error("Missing packaged seccomp helper; reinstall CodeSplash")
  const hash = createHash("sha256")
    .update(new Uint8Array(await Bun.file(path).arrayBuffer()))
    .digest("hex")
  if (hash !== expected[process.arch])
    throw new Error("Seccomp helper integrity check failed; reinstall CodeSplash")
  return path
}

export async function supervisorMain(): Promise<void> {
  installSignalHandlers()
  const bytes = await new Response(Bun.stdin.stream()).arrayBuffer()
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("Sandbox request exceeds 8 MiB")
  const input = JSON.parse(Buffer.from(bytes).toString()) as SupervisorInput
  if (
    !input ||
    !Array.isArray(input.argv) ||
    input.argv.length === 0 ||
    input.argv.some((s) => typeof s !== "string" || s.includes("\0"))
  )
    throw new Error("Invalid sandbox command")
  process.stdout.write(JSON.stringify(await runSupervisor(input)))
}
