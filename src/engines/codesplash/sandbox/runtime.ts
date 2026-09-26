import { constants } from "node:fs"
import { lstat, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { PermissionMode } from "../../../core/config.ts"
import { diagnosticContext } from "../../../core/diagnostics.ts"
import { registerChildProcess } from "../../../core/lifecycle.ts"
import { redactSensitiveText } from "../../../core/redaction.ts"
import { searchRuntime } from "../../../core/search-runtime.ts"
import type { HarnessTool, ToolContext, ToolOutcome } from "../contracts.ts"
import { describePermissionRules } from "../permissions.ts"
import { NamedSecrets } from "../secrets.ts"
import { truncateToolOutput } from "../tools/truncate.ts"
import type { AccessGrant, ExecutionResult, SandboxProfile, SandboxRuntime } from "./contracts.ts"
import { installationRoot, internalCommand } from "./entrypoint.ts"
import { childEnvironment, SENSITIVE_NAME, SecretSanitizer } from "./env-policy.ts"
import { SandboxLog } from "./log.ts"
import { createMacReaper } from "./macos-reaper.ts"
import { startNetworkBroker } from "./network-broker.ts"
import { runProcess } from "./process.ts"
import { canonicalHost, contains, physicalPath, validateAccessGrant } from "./profile.ts"
import type { SupervisorInput } from "./supervisor.ts"
import type { WorkerInput } from "./worker.ts"

const FILE_TOOLS = new Set([
  "notebook_edit",
  "read_anchors",
  "edit_anchors",
  "code_mode",
  "attachment_access",
  "context_read",
  "context_list",
  "context_files",
  "read_file",
  "write_file",
  "edit_file",
  "apply_patch",
  "glob",
  "grep",
  "bash",
])

export class NativeSandbox implements SandboxRuntime {
  readonly #streamAbort = new AbortController()
  readonly #streamOpenings = new Set<Promise<import("./duplex.ts").SandboxDuplex>>()
  readonly #streams = new Set<import("./duplex.ts").SandboxDuplex>()
  readonly #grants: AccessGrant[] = []
  readonly #log: SandboxLog
  #closed = false
  #enforcement = "not yet tested"
  readonly #secretValues = new Set<string>()
  constructor(
    readonly profile: SandboxProfile,
    logPath?: string,
    readonly secrets = new NamedSecrets(),
    readonly constraints?: import("../../../core/config/contracts.ts").ManagedConstraints,
  ) {
    this.#log = new SandboxLog(logPath)
    // Desktop session metadata is not a credential. Treating XDG_SESSION_ID=7 as
    // a secret redacts every 7, including tool ids and structured provenance.
    for (const [key, value] of Object.entries(process.env))
      if (SENSITIVE_NAME.test(key) && value && !/^XDG_SESSION_(?:ID|TYPE|CLASS|DESKTOP)$/.test(key))
        this.#secretValues.add(value)
    this.#log.record("profile", profile.hash)
  }
  validateGrant(grant: AccessGrant, mode: PermissionMode): AccessGrant {
    const checked = validateAccessGrant(this.profile, grant, mode === "plan")
    if (
      checked.resource === "network" &&
      this.constraints?.allowedHosts &&
      !this.constraints.allowedHosts.includes(checked.target)
    )
      throw new Error("Network grant prohibited by managed configuration")
    if (
      checked.resource !== "network" &&
      (contains(checked.target, installationRoot()) || contains(installationRoot(), checked.target))
    )
      throw new Error("The harness installation is protected")
    return checked
  }
  grant(grant: AccessGrant): void {
    if (this.#closed) throw new Error("Sandbox session closed")
    if (
      grant.resource === "network" &&
      this.constraints?.allowedHosts &&
      !this.constraints.allowedHosts.includes(canonicalHost(grant.target))
    )
      throw new Error("Network grant prohibited by managed configuration")
    if (!this.#grants.some((g) => JSON.stringify(g) === JSON.stringify(grant))) this.#grants.push(grant)
    this.#log.record("grant", this.profile.hash, grant.resource)
  }
  resetGrants(): void {
    this.#grants.length = 0
  }
  endTurn(): void {
    for (let i = this.#grants.length - 1; i >= 0; i--)
      if (this.#grants[i]?.scope === "turn") this.#grants.splice(i, 1)
  }
  async close(): Promise<void> {
    this.#closed = true
    this.#streamAbort.abort(new Error("Sandbox session closed"))
    await Promise.allSettled([...this.#streamOpenings])
    await Promise.allSettled([...this.#streams].map((stream) => stream.close()))
    this.#grants.length = 0
    this.#secretValues.clear()
    await this.#log.flush()
  }
  outputSanitizer(): SecretSanitizer {
    return new SecretSanitizer([...this.#secretValues], true)
  }
  sanitize(value: string): string {
    return redactSensitiveText(new SecretSanitizer([...this.#secretValues]).redact(value))
  }
  async openTerminal(
    argv: string[],
    options: import("./terminal.ts").TerminalOptions,
    signal: AbortSignal,
    output: (bytes: Uint8Array) => void,
    mode: PermissionMode = "default",
    readOnly = false,
  ): Promise<import("./terminal.ts").SandboxTerminal> {
    if (this.#closed) throw new Error("Sandbox session closed")
    if (this.#streams.size + this.#streamOpenings.size >= 16)
      throw new Error("Sandbox terminal/process limit reached")
    const profile = {
      ...this.profile,
      ...(mode === "plan" || readOnly ? { mode: "read-only" as const, writeRoots: [] } : {}),
    }
    const decoder = new TextDecoder(),
      sanitizer = new SecretSanitizer([...this.#secretValues], true)
    const opening = (async () => {
      const { openSandboxTerminal } = await import("./terminal.ts")
      const terminal = await openSandboxTerminal(
        profile,
        argv,
        options,
        AbortSignal.any([signal, this.#streamAbort.signal]),
        (bytes) => {
          const text = sanitizer.push(decoder.decode(bytes, { stream: true }))
          if (text) output(Buffer.from(text))
        },
        [...this.#secretValues],
      )
      if (this.#closed) {
        await terminal.close()
        throw new Error("Sandbox session closed")
      }
      this.#streams.add(terminal)
      void terminal.finished
        .finally(() => {
          this.#streams.delete(terminal)
          const tail = sanitizer.push(decoder.decode(), true)
          if (tail) output(Buffer.from(tail))
        })
        .catch(() => {})
      return terminal
    })()
    this.#streamOpenings.add(opening)
    try {
      return await opening
    } finally {
      this.#streamOpenings.delete(opening)
    }
  }
  async openDuplex(
    argv: string[],
    signal: AbortSignal,
    stdout: (chunk: Uint8Array) => void | Promise<void>,
    mode: PermissionMode = "default",
    environment: readonly string[] = this.profile.environment,
  ) {
    if (this.#closed) throw new Error("Sandbox session closed")
    if (this.#streams.size + this.#streamOpenings.size >= 32)
      throw new Error("Persistent sandbox process limit reached")
    // Persistent children may not retain temporary grants after their turn ends.
    if (environment.some((name) => !this.profile.environment.includes(name)))
      throw new Error("MCP environment variable has no fixed sandbox grant")
    const profile = {
      ...this.profile,
      environment: [...environment],
      ...(mode === "plan" ? { mode: "read-only" as const, writeRoots: [] } : {}),
    }
    const opening = (async () => {
      const { openSandboxDuplex } = await import("./duplex.ts")
      const stream = await openSandboxDuplex(
        profile,
        argv,
        AbortSignal.any([signal, this.#streamAbort.signal]),
        stdout,
        [...this.#secretValues],
      )
      if (this.#closed) {
        await stream.close()
        throw new Error("Sandbox session closed")
      }
      this.#streams.add(stream)
      void stream.finished
        .finally(() => {
          this.#streams.delete(stream)
        })
        .catch(() => {})
      return stream
    })()
    this.#streamOpenings.add(opening)
    try {
      return await opening
    } finally {
      this.#streamOpenings.delete(opening)
    }
  }
  #effective(mode?: PermissionMode): SandboxProfile {
    return {
      ...this.profile,
      readRoots: [
        ...this.profile.readRoots,
        ...this.#grants.filter((g) => g.resource === "read" || g.resource === "write").map((g) => g.target),
      ],
      writeRoots:
        mode === "plan"
          ? []
          : [
              ...this.profile.writeRoots,
              ...this.#grants.filter((g) => g.resource === "write").map((g) => g.target),
            ],
      allowedHosts: [
        ...this.profile.allowedHosts,
        ...this.#grants.filter((g) => g.resource === "network").map((g) => g.target),
      ],
    }
  }
  checkNetwork = (value: string): void => {
    if (this.#closed) throw new Error("Sandbox session closed")
    const url = new URL(value)
    const target = canonicalHost(`${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`)
    if (!this.#effective().allowedHosts.includes(target))
      throw new Error(
        `Sandbox network denied: ${target}. Request network access with request_permissions; no request was sent.`,
      )
  }
  async executeFixed(
    argv: string[],
    input: string,
    signal: AbortSignal,
    options: {
      mode: PermissionMode
      environment: readonly string[]
      timeoutMs: number
      writeWorkspace: boolean
    },
  ): Promise<ExecutionResult> {
    if (this.profile.mode === "danger-full-access")
      throw new Error("Hook commands require an enforced OS sandbox")
    if (
      !argv[0] ||
      argv.length > 129 ||
      argv.some((arg) => typeof arg !== "string" || arg.includes("\0") || arg.length > 8192)
    )
      throw new Error("Invalid fixed command argv")
    if (
      Buffer.byteLength(input) > 128 * 1024 ||
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 100 ||
      options.timeoutMs > 30000
    )
      throw new Error("Fixed command input or timeout exceeds its limit")
    if (options.environment.some((name) => !this.profile.environment.includes(name)))
      throw new Error("Hook environment variable has no fixed sandbox grant")
    return this.#invoke(
      {
        argv,
        input,
        timeoutMs: options.timeoutMs,
        fixed: true,
        environment: [...options.environment],
        structured: true,
      },
      signal,
      options.mode === "plan" || !options.writeWorkspace ? "plan" : options.mode,
    )
  }
  async execute(argv: string[], signal: AbortSignal, mode?: PermissionMode): Promise<ExecutionResult> {
    return this.#invoke({ argv, timeoutMs: 120_000 }, signal, mode)
  }
  status(): string {
    const backend =
      this.profile.mode === "danger-full-access"
        ? "full access"
        : process.platform === "darwin"
          ? "Seatbelt"
          : process.platform === "linux"
            ? "bwrap/seccomp"
            : "unsupported OS"
    return `${backend}: ${this.#closed ? "closed" : this.#enforcement} · profile ${this.profile.hash.slice(0, 12)} · ${this.profile.readRoots.length} read / ${this.profile.writeRoots.length} write roots · ${this.#effective().allowedHosts.length} host grants`
  }
  async #invoke(
    command: {
      argv: string[]
      input?: string
      timeoutMs: number
      planFile?: string
      secrets?: Record<string, string>
      outputLimit?: number
      structured?: boolean
      redactions?: string[]
      search?: boolean
      fixed?: boolean
      environment?: string[]
    },
    signal: AbortSignal,
    mode?: PermissionMode,
  ): Promise<ExecutionResult> {
    if (this.#closed) throw new Error("Sandbox session closed")
    const started = performance.now()
    const temp = physicalPath(await mkdtemp(join(tmpdir(), "codesplash-sandbox-")))
    let reaper: Awaited<ReturnType<typeof createMacReaper>> | undefined
    let unregister: (() => void) | undefined
    try {
      if (command.search) {
        const runtime = await searchRuntime(),
          binary = join(temp, "rg")
        await writeFile(binary, runtime.payload, { mode: 0o500, flag: "wx" })
        command.input = JSON.stringify({ ...JSON.parse(command.input!), searchBinary: binary })
      }
      const profile = command.fixed
        ? {
            ...this.profile,
            environment: command.environment ?? [],
            writeRoots: this.profile.writeRoots.filter((root) => contains(this.profile.cwd, root)),
            ...(mode === "plan" ? { mode: "read-only" as const, writeRoots: [] } : {}),
          }
        : this.#effective(mode)
      const env = childEnvironment(temp, profile.environment)
      let result: ExecutionResult
      if (profile.mode === "danger-full-access" && mode !== "plan") {
        result = await runProcess(command.argv, {
          cwd: profile.cwd,
          env: { ...env, ...command.secrets },
          signal,
          input: command.input,
          timeoutMs: command.timeoutMs,
          maxBytes: command.outputLimit,
          structured: command.structured,
          secrets: command.structured ? [] : [...this.#secretValues],
        })
      } else {
        if (process.platform === "darwin") {
          reaper = await createMacReaper()
          unregister = registerChildProcess(reaper)
        }
        const input: SupervisorInput = {
          ...command,
          profile,
          temp,
          workloadEnv: env,
          cleanupTag: reaper?.tag,
        }
        const wire = JSON.stringify(input)
        if (Buffer.byteLength(wire) > 8 * 1024 * 1024) throw new Error("Sandbox request exceeds 8 MiB")
        const transport = await runProcess(internalCommand("supervisor"), {
          cwd: profile.cwd,
          env: childEnvironment(temp),
          signal,
          input: wire,
          timeoutMs: command.timeoutMs + 15_000,
          structured: true,
          maxBytes: (command.outputLimit ?? 1024 * 1024) + 2 * 1024 * 1024,
          cleanup: () => reaper?.kill(),
        })
        if (transport.kind !== "success")
          result =
            transport.kind === "timeout" || transport.kind === "interrupted"
              ? transport
              : {
                  ...transport,
                  kind: "unavailable",
                  stderr:
                    transport.stderr ||
                    "Sandbox supervisor failed; execution was not authorized to fall back",
                }
        else {
          try {
            result = JSON.parse(transport.stdout) as ExecutionResult
            if (
              typeof result.exitCode !== "number" ||
              typeof result.stdout !== "string" ||
              typeof result.stderr !== "string" ||
              ![
                "success",
                "command-failure",
                "sandbox-denial",
                "unavailable",
                "timeout",
                "interrupted",
              ].includes(result.kind)
            )
              throw new Error("Invalid response")
          } catch {
            result = {
              kind: "unavailable",
              exitCode: 126,
              stdout: "",
              stderr: "Invalid sandbox supervisor response; no fallback or retry was attempted",
            }
          }
        }
      }
      if (!command.structured) result.stdout = this.sanitize(result.stdout)
      result.stderr = this.sanitize(result.stderr)
      this.#enforcement =
        profile.mode === "danger-full-access" && mode !== "plan"
          ? "unrestricted"
          : result.kind === "success" || result.kind === "sandbox-denial"
            ? "enforcement observed"
            : result.kind === "unavailable"
              ? "unavailable; execution refused"
              : `last execution: ${result.kind}`
      this.#log.record("execution", profile.hash, result.kind)
      return result
    } finally {
      if (command.search)
        diagnosticContext
          .getStore()
          ?.record("index.operation", { count: 1, durationMs: performance.now() - started })
      reaper?.kill()
      unregister?.()
      await rm(temp, { recursive: true, force: true })
    }
  }
  async runTool(tool: HarnessTool, input: unknown, context: ToolContext): Promise<ToolOutcome> {
    const mode = context.permissions?.mode ?? "default"
    // Trusted in-process extensions retain loop policy/checkpoints. A built-in name override
    // must execute its reviewed callback instead of accidentally invoking the built-in worker.
    if (tool.source?.id.startsWith("extension:"))
      return tool.run(input, {
        ...context,
        policy:
          this.profile.mode === "read-only" ? { ...context.policy, sandbox: "read-only" } : context.policy,
        checkNetwork: this.checkNetwork,
        sanitizeOutput: this.sanitize.bind(this),
      })
    if (!FILE_TOOLS.has(tool.name)) {
      if (
        !["web_fetch", "web_search"].includes(tool.permissionName ?? tool.name) ||
        (this.profile.mode === "danger-full-access" && tool.name !== "memory_embed")
      )
        return tool.run(input, { ...context, checkNetwork: this.checkNetwork })
      const broker = await startNetworkBroker(this.#effective(mode).allowedHosts)
      const stop = () => broker.close()
      context.signal.addEventListener("abort", stop, { once: true })
      try {
        return await tool.run(input, {
          ...context,
          checkNetwork: this.checkNetwork,
          fetchNetwork: (url, init) => {
            this.checkNetwork(url)
            return fetch(url, { ...init, proxy: broker.url })
          },
        })
      } finally {
        context.signal.removeEventListener("abort", stop)
        broker.close()
      }
    }
    const targets = tool.permissionTargets?.(input, context)
    // Refuse existing hardlinks in host tools: path containment alone cannot identify an inode's aliases.
    for (const path of targets?.paths ?? []) {
      const info = await lstat(path).catch(() => undefined)
      if (info?.isFile() && info.nlink > 1)
        throw new Error("Sandbox refuses multiply-linked files; use a private copy")
      const p = physicalPath(path),
        effective = this.#effective(mode)
      const roots = tool.isReadOnly(input)
        ? [...effective.readRoots, ...effective.writeRoots]
        : effective.writeRoots
      const isPlan =
        ["write_file", "edit_file"].includes(tool.name) &&
        p === join(this.profile.cwd, ".codesplash", "plan.md")
      if (!isPlan && !roots.some((r) => contains(r, p)) && this.profile.mode !== "danger-full-access")
        throw new Error(`Sandbox path denied: ${p}. Request scoped access with request_permissions.`)
    }
    const rules = { allow: [] as string[], ask: [] as string[], deny: [] as string[] }
    if (context.permissions)
      for (const rule of describePermissionRules(context.permissions))
        if (rule.source !== "builtin") rules[rule.action].push(rule.raw)
    let planFile: string | undefined
    if (
      ["write_file", "edit_file"].includes(tool.name) &&
      targets?.paths?.length === 1 &&
      resolve(targets.paths[0] ?? "") === join(this.profile.cwd, ".codesplash", "plan.md")
    ) {
      planFile = await preparePlanFile(this.profile.cwd)
    }
    const worker: WorkerInput = {
      tool: tool.name,
      input,
      cwd: context.cwd,
      policy: {
        ...context.policy,
        permissionMode: mode,
        ...(planFile ? { sandbox: "workspace-write" as const } : {}),
      },
      rules,
      redactions: [...this.#secretValues],
    }
    const secretBindings: Record<string, string> = {}
    if (tool.name === "bash" && input && typeof input === "object" && "secrets" in input && input.secrets) {
      if (
        !Array.isArray(input.secrets) ||
        input.secrets.length > 16 ||
        input.secrets.some((s) => typeof s !== "string")
      )
        throw new Error("bash secrets must be an array of at most 16 secret names")
      for (const name of input.secrets as string[]) {
        if (
          /^(?:PATH|HOME|TMP|TEMP|TMPDIR|BASH_ENV|ENV|IFS|SHELLOPTS|BASHOPTS|LD_.*|DYLD_.*|NODE_.*|BUN_.*|GIT_.*|PYTHON.*|RUBY.*|PERL.*|.*PROXY)$/.test(
            name,
          )
        )
          throw new Error("Secrets cannot bind shell/runtime startup or routing variables")
        const value = await this.secrets.get(name)
        secretBindings[name] = value
        this.#secretValues.add(value)
      }
    }
    const timeout =
      tool.name === "bash" &&
      input &&
      typeof input === "object" &&
      "timeout" in input &&
      typeof input.timeout === "number"
        ? Math.min(600_000, Math.max(1, input.timeout)) + 3000
        : tool.name === "code_mode"
          ? 33000
          : 125_000
    if (tool.name === "bash") {
      const command = targets?.command
      if (!command) throw new Error("Invalid bash command")
      const result = await this.#invoke(
        {
          argv: ["/bin/bash", "-c", command],
          timeoutMs: timeout - 3000,
          secrets: secretBindings,
          redactions: [...this.#secretValues],
        },
        context.signal,
        mode,
      )
      return {
        text: `${truncateToolOutput(this.sanitize(result.stdout + result.stderr))}\n[${result.kind}; exit code: ${result.exitCode}]`,
        label: this.sanitize(command.replace(/\s+/g, " ").slice(0, 120)),
        ...(result.kind !== "success" ? { isError: true } : {}),
      }
    }
    const result = await this.#invoke(
      {
        outputLimit: 8 * 1024 * 1024,
        search: tool.name === "grep",
        argv: internalCommand("worker"),
        input: JSON.stringify(worker),
        timeoutMs: timeout,
        planFile,
        secrets: secretBindings,
        structured: true,
      },
      context.signal,
      mode,
    )
    if (result.kind !== "success")
      return {
        text: this.sanitize(`${result.stderr}\n${result.stdout}\n[${result.kind}; exit ${result.exitCode}]`),
        label: tool.name,
        isError: true,
      }
    try {
      const outcome = JSON.parse(result.stdout) as ToolOutcome
      if (typeof outcome.text !== "string" || typeof outcome.label !== "string")
        throw new Error("Invalid tool outcome")
      outcome.text = this.sanitize(outcome.text)
      outcome.label = this.sanitize(outcome.label)
      this.#log.record("tool", this.profile.hash, outcome.isError ? "failed" : "completed")
      return outcome
    } catch {
      return {
        text: "Sandbox worker returned invalid output; no retry was attempted",
        label: tool.name,
        isError: true,
      }
    }
  }
}

async function preparePlanFile(cwd: string): Promise<string> {
  const directory = join(cwd, ".codesplash"),
    path = join(directory, "plan.md")
  await mkdir(directory, { mode: 0o700 }).catch((e) => {
    if (e.code !== "EEXIST") throw e
  })
  if ((await lstat(directory)).isSymbolicLink() || physicalPath(directory) !== directory)
    throw new Error("Plan directory must not be a symlink")
  const file = await open(path, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    if ((await file.stat()).nlink !== 1) throw new Error("Plan file must not have hardlinks")
  } finally {
    await file.close()
  }
  if (physicalPath(dirname(path)) !== directory) throw new Error("Plan directory changed during creation")
  return path
}
