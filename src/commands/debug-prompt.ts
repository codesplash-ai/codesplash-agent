/**
 * `codesplash debug prompt`: prints the model-visible surface for a session that WOULD open in
 * the given project — the resolved model selector, the assembled system prompt, and every tool
 * spec — as one JSON object. No network request is made and no session or history is created;
 * the only side effects are reads (config, credentials file, project rule files, git toplevel).
 */
import {
  configDirectory,
  configFilePath,
  inspectProject,
  isSandboxMode,
  loadConfig,
  type SandboxMode,
  type SessionPolicy,
} from "../core/index.ts"
import { applyStoredCredentials } from "../engines/codesplash/auth.ts"
import { buildProviderRegistry, formatModelSelector } from "../engines/codesplash/catalog.ts"
import { buildSystemPrompt } from "../engines/codesplash/prompt.ts"
import type { HeadlessSink } from "../engines/codesplash/runner.ts"
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
  const config = await loadConfig(configFilePath(configDirectory(env)), overrides.configOverrides)
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

  const tools = builtinTools()
  const system = await buildSystemPrompt({
    cwd: project.cwd,
    model: selection.model,
    policy,
    toolNames: tools.map((tool) => tool.name),
  })

  const surface: DebugPromptSurface = {
    model: formatModelSelector(selection.model, selection.effort),
    system,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }

  stdout.write(`${JSON.stringify(surface, null, 2)}\n`)
  return 0
}
