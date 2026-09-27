import { join, resolve } from "node:path"
import { configDirectory, loadConfig } from "../core/config.ts"
import { atomic, bytes, digest, lease } from "../core/session/files.ts"
import { readTrustDecision } from "../core/trust.ts"
import { writeResources } from "../engines/codesplash/inputs/authoring.ts"
import { RESOURCE_NAME } from "../engines/codesplash/inputs/contracts.ts"
import { resourcePaths, safeRead } from "../engines/codesplash/inputs/io.ts"
import { discoverAgents, selectAgent } from "../engines/codesplash/orchestration/definitions.ts"
import { UsageError } from "./usage-error.ts"

const usage =
  "codesplash agents list [--trust] | show NAME [--trust] | create NAME [--write] | generate NAME BRIEF --model ID [--write] | personas [--trust] | enable NAME --fingerprint HASH [--trust]"
export async function runAgentsCommand(
  args: string[],
  options: {
    cwd?: string
    configPath?: string
    dataDir?: string
    userRoot?: string
    output?: (text: string) => void
  } = {},
): Promise<number> {
  const output = options.output ?? ((text) => process.stdout.write(text)),
    cwd = options.cwd ?? process.cwd()
  if (args.length === 1 && ["-h", "--help"].includes(args[0]!)) {
    output(`${usage}\n`)
    return 0
  }
  const [action, ...rest] = args
  if (action === "generate")
    return (await import("./agent-draft.ts")).generateAgentCommand(rest, { ...options, cwd, output })
  if (action === "create") {
    const [name, flag, ...extra] = rest
    if (!name || !RESOURCE_NAME.test(name) || (flag && flag !== "--write") || extra.length)
      throw new UsageError(usage)
    const path = `.codesplash/agents/${name}.md`
    const text = `---\nname: ${name}\ndescription: Describe this agent's purpose\nenabled: false\nmode: plan\nmcp: none\nbudgetTokens: 65536\ntimeoutMs: 120000\n---\nInspect the assigned task and report findings with evidence.\n`
    if (flag) await writeResources(cwd, [{ path, text }])
    output(
      `${flag ? "Created (disabled)" : "Preview"}: ${resolve(cwd, path)}\n${text}\nReview with agents show, then enable the reviewed fingerprint.\n`,
    )
    return 0
  }
  const trusted =
    rest.includes("--trust") || (await readTrustDecision(cwd, options.dataDir))?.trusted === true
  const flags = rest.filter((arg) => arg !== "--trust"),
    [name] = flags
  if (
    action === "list" || action === "personas"
      ? flags.length > 0
      : !name ||
        (action === "show"
          ? flags.length !== 1
          : action !== "enable" || flags.length !== 3 || flags[1] !== "--fingerprint")
  )
    throw new UsageError(usage)
  const config = await loadConfig(options.configPath, [], {
    cwd,
    workspaceTrusted: trusted,
    dataDir: options.dataDir,
  })
  if (action === "personas") {
    output(`${JSON.stringify(config.agents?.personas ?? {}, null, 2)}\n`)
    return 0
  }
  const catalog = await discoverAgents({
    cwd,
    trusted,
    config,
    userRoot: options.userRoot ?? join(configDirectory(), "context"),
    signal: AbortSignal.timeout(30000),
    run: async (tool, raw) => {
      const input = raw as { root: string; path?: string; sources?: string[] }
      const text =
        tool === "context_list"
          ? JSON.stringify(await resourcePaths(input.root, undefined, input.sources))
          : await (async () => {
              const text = await safeRead(input.root, input.path!, undefined, 65536)
              return JSON.stringify({ text, fingerprint: digest(text) })
            })()
      return { type: "tool_result", toolCallId: crypto.randomUUID(), text }
    },
  })
  if (action === "list")
    output(
      `${JSON.stringify(
        catalog.map(({ prompt: _, ...definition }) => definition),
        null,
        2,
      )}\n`,
    )
  else {
    const selected =
      catalog.find((agent) => agent.id === name) ??
      (() => {
        try {
          return selectAgent(catalog, name!)
        } catch {
          return undefined
        }
      })()
    if (!selected) throw new Error("Unknown agent; use a qualified name from agents list")
    if (action === "enable") {
      if (!/^(project|user)\//.test(selected.id) || flags[2] !== selected.fingerprint)
        throw new Error("Enable requires a current reviewed project/user definition fingerprint")
      const release = lease(resolve(selected.source, ".."), "agent-edit.lease")
      try {
        const source = bytes(selected.source, 65536).toString("utf8")
        if (digest(source) !== selected.fingerprint || !/^enabled: false$/m.test(source))
          throw new Error("Agent changed or lacks an explicit disabled flag")
        atomic(selected.source, source.replace(/^enabled: false$/m, "enabled: true"))
      } finally {
        release()
      }
      output(`Enabled ${selected.id}; execution still requires native agent admission.\n`)
    } else output(`${JSON.stringify(selected, null, 2)}\n`)
  }
  return 0
}
