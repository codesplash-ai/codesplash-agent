import { resolve } from "node:path"
import { writeResources } from "../engines/codesplash/inputs/authoring.ts"
import { RESOURCE_NAME } from "../engines/codesplash/inputs/contracts.ts"
import { parseAgentMarkdown } from "../engines/codesplash/orchestration/definitions.ts"
import { createAgentSession } from "../sdk/index.ts"

/** Only prose is accepted from the model; capability fields are fixed by the authoring workflow. */
export function agentDraft(name: string, response: string): string {
  if (!RESOURCE_NAME.test(name) || Buffer.byteLength(response) > 16384) throw new Error("Invalid agent draft")
  const value = JSON.parse(response)
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !["description", "prompt"].includes(k)) ||
    typeof value.description !== "string" ||
    typeof value.prompt !== "string"
  )
    throw new Error("Expected only description and prompt in generated draft")
  const text = `---\nname: ${name}\ndescription: ${JSON.stringify(value.description)}\nenabled: false\nmode: plan\nmcp: none\nbudgetTokens: 65536\ntimeoutMs: 120000\n---\n${value.prompt}\n`
  parseAgentMarkdown(text, name)
  return text
}
export async function generateAgentCommand(
  args: string[],
  options: {
    cwd: string
    configPath?: string
    dataDir?: string
    output: (text: string) => void
    generate?: (question: string, model: string) => Promise<string>
  },
) {
  const [name, brief, ...flags] = args
  let model: string | undefined,
    write = false
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--model" && !model) model = flags[++i]
    else if (flags[i] === "--write" && !write) write = true
    else throw new Error("Use agents generate NAME BRIEF --model ID [--write]")
  }
  if (
    !name ||
    !RESOURCE_NAME.test(name) ||
    !brief?.trim() ||
    brief.length > 1400 ||
    brief.includes("\0") ||
    !model
  )
    throw new Error("Use agents generate NAME BRIEF --model ID [--write]; brief limit is 1400 characters")
  const question = `Draft a coding-agent definition for this brief: ${JSON.stringify(brief)}. Return only a JSON object with string fields description (one sentence) and prompt (concise instructions, under 1200 characters). No Markdown fences or additional fields. The draft will be disabled, read-only and without MCP until separately reviewed.`
  let response: string
  if (options.generate) response = await options.generate(question, model)
  else {
    const session = await createAgentSession({
      cwd: options.cwd,
      workspaceTrusted: false,
      trustDataDirectory: options.dataDir,
      config: { path: options.configPath, overrides: ['permissions.mode="plan"', "history.enabled=false"] },
      model,
      disableExtensions: true,
      signal: AbortSignal.timeout(45000),
    })
    try {
      response = await session.sideQuery({ kind: "question", question })
      options.output(`Generation usage: ${JSON.stringify(session.usage)}\n`)
    } finally {
      await session.close()
    }
  }
  const text = agentDraft(name, response),
    path = `.codesplash/agents/${name}.md`
  if (write) await writeResources(options.cwd, [{ path, text }])
  options.output(
    `${write ? "Created disabled draft" : "Preview"}: ${resolve(options.cwd, path)}\n${text}\nReview with agents show, then enable the exact fingerprint.\n`,
  )
  return 0
}
