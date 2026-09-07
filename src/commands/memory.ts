import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { configDirectory, configFilePath, dataDirectory, loadConfig } from "../core/config.ts"
import { logBytes } from "../core/session/compression.ts"
import {
  listProjectSessions,
  projectIdFor,
  sessionDirectory,
  sessionsRootDirectory,
} from "../core/sessions.ts"
import { readTrustDecision, writeTrustDecision } from "../core/trust.ts"
import { applyStoredCredentials } from "../engines/codesplash/auth.ts"
import { buildProviderRegistry } from "../engines/codesplash/catalog.ts"
import type { ChatMessage } from "../engines/codesplash/contracts.ts"
import { embeddingTool } from "../engines/codesplash/memory/embedding.ts"
import { maintainMemory } from "../engines/codesplash/memory/maintenance.ts"
import { MemorySession } from "../engines/codesplash/memory/session.ts"
import { createPermissionRuntime } from "../engines/codesplash/permissions.ts"
import { createProfile, physicalPath } from "../engines/codesplash/sandbox/profile.ts"
import { NativeSandbox } from "../engines/codesplash/sandbox/runtime.ts"
import { UsageError } from "./usage-error.ts"
export async function runMemoryCommand(
  args: string[],
  options: {
    configOverrides?: readonly string[]
    output?: (text: string) => void
    env?: NodeJS.ProcessEnv
  } = {},
): Promise<number> {
  const env = options.env ?? process.env,
    output = options.output ?? ((text) => process.stdout.write(text))
  let cwd = process.cwd(),
    trust = false,
    history = true,
    readonly = false,
    model: string | undefined
  const command: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ""
    if (arg === "--") {
      command.push(...args.slice(i + 1))
      break
    }
    if (arg === "--path") {
      if (!args[i + 1]) throw new UsageError("--path requires a directory")
      cwd = resolve(args[++i] ?? "")
    } else if (arg === "--trust") trust = true
    else if (arg === "--no-history") history = false
    else if (arg === "--read-only") readonly = true
    else if (arg === "--model") {
      if (!args[i + 1]) throw new UsageError("--model requires a selector")
      model = args[++i]
    } else command.push(arg)
  }
  cwd = physicalPath(cwd)
  const config = await loadConfig(configFilePath(configDirectory(env)), options.configOverrides),
    data = physicalPath(dataDirectory(env))
  history = history && config.history.enabled
  if (trust && history) await writeTrustDecision(cwd, true, data)
  const trusted = trust || (await readTrustDecision(cwd, data))?.trusted === true
  const permissions = await createPermissionRuntime({
    cwd,
    mode: config.permissions.mode,
    workspaceTrusted: trusted,
    configRules: config.permissions,
  })
  const policy = {
    sandbox: readonly ? ("read-only" as const) : config.codex.sandbox,
    approvalPolicy: config.codex.approvalPolicy,
    permissionMode: permissions.mode,
  }
  const sandbox = new NativeSandbox(createProfile(cwd, policy.sandbox, config.sandbox)),
    abort = new AbortController()
  const cancel = () => abort.abort(new Error("Memory command interrupted"))
  process.once("SIGINT", cancel)
  process.once("SIGTERM", cancel)
  const memory = new MemorySession({
    root: join(data, "memory"),
    cwd,
    session: "memory-cli",
    history,
    trusted,
    config: config.memory,
    permissions,
    sanitize: sandbox.sanitize.bind(sandbox),
    writable: () => policy.sandbox === "workspace-write" && permissions.mode !== "plan",
  })
  const action = command[0] ?? "list",
    write =
      ["remember", "edit", "forget", "accept", "repair", "index", "extract", "consolidate"].includes(
        action,
      ) ||
      (action === "link" && command.includes("--apply"))
  const embedding = embeddingTool(config.memory?.embedding, (tokens, cost) =>
    output(
      `Embedding usage: ${tokens} input tokens; ${cost === undefined ? "cost unknown" : `estimated $${cost.toFixed(6)}`}\n`,
    ),
  )
  const permit = (name: string, readOnly: boolean) => {
    const decision = permissions.decide(name, undefined, readOnly)
    if (decision.kind === "deny" || decision.kind === "ask")
      throw new Error(`Memory ${decision.kind}: use an interactive session to inspect permissions`)
  }
  try {
    permit(write ? "memory_write" : action === "show" ? "memory_read" : "memory_search", !write)
    if (action === "status" && !memory.available) {
      output("Durable memory is disabled in this untrusted, no-history or disabled invocation.\n")
      return 0
    }
    if (action === "extract" || action === "consolidate") {
      memory.requireWrite()
      permit("history_read", true)
      applyStoredCredentials(env)
      const providers = buildProviderRegistry(config, env),
        selected = model ? providers.parseSelector(model).model : providers.defaultModel(),
        provider = providers.providers.find((p) => p.id === selected.provider)?.client
      if (!provider) throw new Error("No provider for memory maintenance")
      const meta = (await listProjectSessions(projectIdFor(cwd), sessionsRootDirectory(data))).find(
        (session) => session.engine === "codesplash",
      )
      const messages: ChatMessage[] = []
      if (meta) {
        const path = join(
          sessionDirectory(sessionsRootDirectory(data), meta.projectId, meta.localSessionId),
          "transcript.jsonl",
        )
        if (existsSync(path) || existsSync(`${path}.storage.json`))
          for (const line of logBytes(path, 8 * 1024 * 1024)
            .toString()
            .split("\n")
            .slice(-1000)) {
            if (!line.trim()) continue
            try {
              const parsed = JSON.parse(line) as { message?: ChatMessage }
              if (
                parsed.message &&
                (parsed.message.role === "user" || parsed.message.role === "assistant") &&
                Array.isArray(parsed.message.content)
              )
                messages.push(parsed.message)
            } catch {}
          }
      }
      output(
        `${await maintainMemory({
          memory,
          messages,
          provider,
          model: selected,
          signal: abort.signal,
          action,
          onUsage: (usage) => {
            const price = selected.pricing
            const cost = price
              ? ((usage.inputTokens ?? 0) * price.inputPerMTok +
                  (usage.cachedInputTokens ?? 0) * (price.cachedInputPerMTok ?? price.inputPerMTok / 10) +
                  (usage.outputTokens ?? 0) * price.outputPerMTok) /
                1e6
              : undefined
            output(
              `Memory usage: ${JSON.stringify({ ...usage, estimatedCostUsd: cost, costUnknown: cost === undefined })}\n`,
            )
          },
        })}\n`,
      )
    } else
      output(
        `${await memory.command(
          command.map((part) => JSON.stringify(part)).join(" "),
          abort.signal,
          async (name, input) => {
            if (name !== "memory_embed") throw new Error("Unsupported memory operation")
            const context = {
              cwd,
              policy,
              signal: abort.signal,
              permissions,
              sanitizeOutput: sandbox.sanitize.bind(sandbox),
            }
            const decision = permissions.decide(
              "web_fetch",
              embedding.permissionTargets?.(input, context),
              true,
            )
            if (decision.kind === "deny" || decision.kind === "ask")
              return {
                type: "tool_result",
                toolCallId: "embedding",
                isError: true,
                text: `Embedding ${decision.kind} by policy`,
              }
            const result = await sandbox.runTool(embedding, input, context)
            return { ...result, type: "tool_result", toolCallId: "embedding" }
          },
        )}\n`,
      )
    return 0
  } finally {
    process.removeListener("SIGINT", cancel)
    process.removeListener("SIGTERM", cancel)
    await sandbox.close()
  }
}
