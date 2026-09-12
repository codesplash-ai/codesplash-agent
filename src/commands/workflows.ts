import { existsSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { type WorkflowDefinition, workflowFingerprint, workflowOf } from "../core/orchestration/automation.ts"
import { atomic, bytes, digest, lease } from "../core/session/files.ts"
import { writeResources } from "../engines/codesplash/inputs/authoring.ts"
import { UsageError } from "./usage-error.ts"

const usage =
  "codesplash workflows list | show NAME | create NAME [--write] | enable NAME --fingerprint SOURCE_SHA --apply | import SOURCE --name NAME [--write]"
export async function runWorkflowsCommand(
  args: string[],
  options: { cwd?: string; output?: (text: string) => void } = {},
) {
  const cwd = options.cwd ?? process.cwd(),
    output = options.output ?? ((text) => process.stdout.write(text))
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    output(`${usage}\n`)
    return 0
  }
  const [action, selected, ...rest] = args,
    root = join(cwd, ".codesplash", "workflows")
  if (action === "list") {
    if (selected) throw new UsageError(usage)
    const names = existsSync(root)
      ? readdirSync(root).filter((n) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.json$/.test(n))
      : []
    if (names.length > 64) throw new Error("Workflow catalog exceeds 64 definitions")
    output(
      `${JSON.stringify(
        names.map((n) => {
          const raw = bytes(join(root, n), 65536)
          const definition = workflowOf(JSON.parse(raw.toString()))
          return {
            name: definition.name,
            enabled: definition.enabled,
            fingerprint: workflowFingerprint(definition),
            sourceFingerprint: digest(raw),
          }
        }),
        null,
        2,
      )}\n`,
    )
    return 0
  }
  if (action === "import") {
    if (
      !selected ||
      rest[0] !== "--name" ||
      !rest[1] ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(rest[1]) ||
      rest.length > 3 ||
      (rest[2] && rest[2] !== "--write")
    )
      throw new UsageError(usage)
    const source = bytes(resolve(selected), 65536).toString(),
      name = rest[1]
    let definition: WorkflowDefinition
    if (selected.endsWith(".json")) definition = workflowOf(JSON.parse(source))
    else {
      // Deliberately literal-only Rhai translation. Never evaluate imported code.
      const match =
        /^\s*let meta = #\{\s*name:\s*"(?:[^"\\]|\\.)*"\s*,\s*description:\s*"(?:[^"\\]|\\.)*"\s*\};\s*let ([a-zA-Z_][a-zA-Z0-9_]*) = agent\(("(?:[^"\\]|\\.)*")\);\s*complete\(\1\.output\);\s*$/.exec(
          source,
        )
      if (!match)
        throw new Error(
          "Unsupported workflow semantics: only native JSON or a literal one-agent Grok Rhai script can be translated; review other constructs manually",
        )
      definition = {
        version: 1,
        name,
        enabled: false,
        limits: { tokens: 65536, timeoutMs: 120000, rounds: 1 },
        steps: [{ id: "agent", kind: "prompt", prompt: JSON.parse(match[2]!) }],
      }
    }
    definition = workflowOf({ ...definition, name, enabled: false })
    const text = `${JSON.stringify(definition, null, 2)}\n`
    if (rest[2]) await writeResources(cwd, [{ path: `.codesplash/workflows/${name}.json`, text }])
    output(
      `${JSON.stringify({ written: !!rest[2], sourceFingerprint: digest(source), definition, inactive: true }, null, 2)}\n`,
    )
    return 0
  }
  if (!selected || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(selected)) throw new UsageError(usage)
  const path = join(root, `${selected}.json`)
  if (action === "create") {
    if (rest.length > 1 || (rest[0] && rest[0] !== "--write")) throw new UsageError(usage)
    const definition: WorkflowDefinition = {
      version: 1,
      name: selected,
      enabled: false,
      limits: { tokens: 65536, timeoutMs: 120000, rounds: 1 },
      steps: [
        {
          id: "inspect",
          kind: "prompt",
          agent: "builtin/explore",
          prompt: "Inspect the workspace and report findings",
        },
      ],
    }
    if (rest[0])
      await writeResources(cwd, [
        { path: `.codesplash/workflows/${selected}.json`, text: `${JSON.stringify(definition, null, 2)}\n` },
      ])
    output(`${JSON.stringify({ written: !!rest[0], definition }, null, 2)}\n`)
    return 0
  }
  if (action === "show") {
    if (rest.length) throw new UsageError(usage)
    const raw = bytes(path, 65536),
      definition = workflowOf(JSON.parse(raw.toString()))
    output(
      `${JSON.stringify({ definition, fingerprint: workflowFingerprint(definition), sourceFingerprint: digest(raw) }, null, 2)}\n`,
    )
    return 0
  }
  if (action !== "enable" || rest.length !== 3 || rest[0] !== "--fingerprint" || rest[2] !== "--apply")
    throw new UsageError(usage)
  const release = lease(root, "workflow-edit.lease")
  try {
    const raw = bytes(path, 65536),
      definition = workflowOf(JSON.parse(raw.toString()))
    if (digest(raw) !== rest[1] || definition.enabled)
      throw new Error("Workflow source changed or is already enabled")
    definition.enabled = true
    atomic(path, `${JSON.stringify(definition, null, 2)}\n`)
    output(`${JSON.stringify({ definition, fingerprint: workflowFingerprint(definition) }, null, 2)}\n`)
  } finally {
    release()
  }
  return 0
}
