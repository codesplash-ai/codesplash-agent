import { join, resolve } from "node:path"
import { assertManagedPolicy } from "../core/config/policy.ts"
/**
 * `codesplash debug prompt`: prints the model-visible surface for a session that WOULD open in
 * the given project — the resolved model selector, the assembled system prompt, and every tool
 * spec — as one JSON object. No network request is made and no session or history is created;
 * the only side effects are reads (config, credentials file, project rule files, git toplevel).
 */
import {
  configDirectory,
  configFilePath,
  dataDirectory,
  inspectProject,
  isSandboxMode,
  loadConfig,
  type SandboxMode,
  type SessionPolicy,
} from "../core/index.ts"
import { applyStoredCredentials } from "../engines/codesplash/auth.ts"
import { buildProviderRegistry, formatModelSelector } from "../engines/codesplash/catalog.ts"
import { contextReadTool, internalContextTools } from "../engines/codesplash/inputs/io.ts"
import { ContextInputs, skillTool } from "../engines/codesplash/inputs/session.ts"
import { MemorySession } from "../engines/codesplash/memory/session.ts"
import { memoryTools } from "../engines/codesplash/memory/tools.ts"
import { createPermissionRuntime } from "../engines/codesplash/permissions.ts"
import { buildSystemPrompt } from "../engines/codesplash/prompt.ts"
import type { HeadlessSink } from "../engines/codesplash/runner.ts"
import { createProfile } from "../engines/codesplash/sandbox/profile.ts"
import { NativeSandbox } from "../engines/codesplash/sandbox/runtime.ts"
import { builtinTools } from "../engines/codesplash/tools/registry.ts"
import { UsageError } from "./usage-error.ts"

export type DebugPromptCommand = {
  path?: string
  model?: string
  sandbox?: SandboxMode
}

/** The printed JSON object: exactly what the model would see when a session opens. */
export type DebugPromptSurface = {
  model: string
  system: string
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
}

/* -------------------------------------- parsing -------------------------------------- */

/**
 * Parses the arguments AFTER `debug prompt`. Unlike run, `--sandbox` accepts danger-full-access
 * too: nothing executes here, and inspecting the full-access prompt variant is the point.
 */
export function parseDebugPromptArguments(args: string[]): DebugPromptCommand {
  let path: string | undefined
  let model: string | undefined
  let sandbox: SandboxMode | undefined

  for (let index = 0; index < args.length; index++) {
    const argument = args[index] as string
    if (argument === "--model" || argument.startsWith("--model=")) {
      const value = argument.includes("=") ? argument.slice("--model=".length) : args[++index]
      if (value === undefined) {
        throw new UsageError("--model expects a model id, optionally with :low, :medium, or :high")
      }
      model = value
    } else if (argument === "--sandbox" || argument.startsWith("--sandbox=")) {
      const value = argument.includes("=") ? argument.slice("--sandbox=".length) : args[++index]
      if (!isSandboxMode(value)) {
        throw new UsageError(
          `--sandbox expects read-only, workspace-write, or danger-full-access, got ${value ?? "nothing"}`,
        )
      }
      sandbox = value
    } else if (argument.startsWith("-")) {
      throw new UsageError(`Unknown option ${argument} for debug prompt`)
    } else if (path === undefined) {
      path = argument
    } else {
      throw new UsageError("debug prompt expects at most one project path")
    }
  }

  return { path, model, sandbox }
}

/* ------------------------------------- execution ------------------------------------- */

/** Test seams; every field defaults to the real process surface. */
export type DebugPromptCommandOverrides = {
  stdout?: HeadlessSink
  stderr?: HeadlessSink
  env?: NodeJS.ProcessEnv
  /** Repeatable `-c/--config key=value` overrides (extracted by cli.ts) for the config load. */
  configOverrides?: readonly string[]
  profile?: string
  strictConfig?: boolean
}

/** Dispatches the `debug` subcommand; `prompt` is its only topic today. */
export async function runDebugCommand(
  args: string[],
  overrides: DebugPromptCommandOverrides = {},
): Promise<number> {
  const topic = args[0]
  if (topic === undefined) throw new UsageError("debug expects a topic: codesplash debug prompt")
  if (topic !== "prompt") throw new UsageError(`Unknown debug topic "${topic}"; expected prompt`)
  return runDebugPromptCommand(args.slice(1), overrides)
}

export async function runDebugPromptCommand(
  args: string[],
  overrides: DebugPromptCommandOverrides = {},
): Promise<number> {
  const command = parseDebugPromptArguments(args)
  const env = overrides.env ?? process.env
  const stdout = overrides.stdout ?? process.stdout
  const stderr = overrides.stderr ?? process.stderr

  applyStoredCredentials(env)
  const project = await inspectProject(command.path ?? process.cwd())
  const config = await loadConfig(configFilePath(configDirectory(env)), overrides.configOverrides, {
    cwd: command.path ?? process.cwd(),
    env,
    profile: overrides.profile,
    strict: overrides.strictConfig,
  })
  const registry = buildProviderRegistry(config, env)

  let selection: ReturnType<typeof registry.parseSelector>
  if (command.model !== undefined) {
    try {
      selection = registry.parseSelector(command.model)
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error))
    }
  } else {
    try {
      selection = { model: registry.defaultModel() }
    } catch (error) {
      // No provider is available: an environment problem, not a caller mistake — exit 1, not 2.
      stderr.write(`codesplash: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  const policy: SessionPolicy = {
    sandbox: command.sandbox ?? config.codex.sandbox,
    approvalPolicy: config.codex.approvalPolicy,
  }

  assertManagedPolicy(config, { ...policy, permissionMode: config.permissions.mode })
  const userRoot = resolve(configDirectory(env), "context")
  const permissions = await createPermissionRuntime({
    cwd: project.cwd,
    mode: config.permissions.mode,
    workspaceTrusted: true,
    configRules: config.permissions,
    constraints: config.resolution?.constraints,
  })
  const sandbox = new NativeSandbox(
    createProfile(project.cwd, policy.sandbox, config.sandbox),
    undefined,
    undefined,
    config.resolution?.constraints,
  )
  const memory = new MemorySession({
    root: join(dataDirectory(env), "memory"),
    cwd: project.cwd,
    session: "preview",
    history: false,
    trusted: true,
    writable: () => false,
    permissions,
    sanitize: sandbox.sanitize.bind(sandbox),
  })
  const tools = [...builtinTools(), skillTool, ...memoryTools(memory, () => [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  const inputs = new ContextInputs(
    project.cwd,
    userRoot,
    true,
    config.context,
    sandbox.sanitize.bind(sandbox),
  )
  const signal = new AbortController().signal
  let suffix: string
  try {
    const prepared = await inputs.prepare(
      { text: "" },
      async (name, input) => {
        const tool = [...internalContextTools(), contextReadTool(userRoot)].find((t) => t.name === name)
        if (!tool)
          throw new Error("Prompt preview requires interactive import approval; inspect it in a session")
        const context = {
          cwd: project.cwd,
          policy,
          signal,
          permissions,
          sanitizeOutput: sandbox.sanitize.bind(sandbox),
        }
        const decision = permissions.decide(
          tool.permissionName ?? tool.name,
          tool.permissionTargets?.(input, context),
          true,
        )
        if (decision.kind === "ask" || decision.kind === "deny")
          throw new Error(
            `Prompt preview read ${decision.kind}: inspect permissions in an interactive session`,
          )
        const result = await sandbox.runTool(tool, input, context)
        return { ...result, type: "tool_result", toolCallId: "preview" }
      },
      signal,
    )
    suffix = prepared.suffix
  } finally {
    await sandbox.close()
  }
  const system = await buildSystemPrompt({
    cwd: project.cwd,
    model: selection.model,
    policy,
    toolNames: tools.map((tool) => tool.name),
    rules: [],
    personality: config.context?.personality,
    permissionMode: config.permissions.mode,
  })

  const surface: DebugPromptSurface = {
    model: formatModelSelector(selection.model, selection.effort),
    system: [system, suffix].filter(Boolean).join("\n\n"),
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }

  stdout.write(`${JSON.stringify(surface, null, 2)}\n`)
  return 0
}
