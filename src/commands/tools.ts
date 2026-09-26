import { writeFile } from "node:fs/promises"
import { attributeText, attributionPolicy } from "../core/attribution.ts"
import { searchRuntime } from "../core/search-runtime.ts"
import { bytes, digest, json } from "../core/session/files.ts"
import { advancedFeatures, toolsets } from "../engines/codesplash/execution.ts"
import { shellStructure } from "../engines/codesplash/shell-structure.ts"
import { generationArtifact } from "../engines/codesplash/tools/generation.ts"
import { builtinTools } from "../engines/codesplash/tools/registry.ts"
import { UsageError } from "./usage-error.ts"

function stage(name: string): "stable" | "experimental" {
  return Object.values(advancedFeatures).some((names) => names.includes(name)) ? "experimental" : "stable"
}
export async function runToolsCommand(args: string[]): Promise<number> {
  const [action = "list", ...rest] = args
  let result: unknown
  if (action === "list" && !rest.length)
    result = {
      version: 1,
      features: advancedFeatures,
      tools: builtinTools(true).map((t) => ({
        name: t.name,
        version: 1,
        stage: stage(t.name),
        schemaSha256: digest(JSON.stringify(t.inputSchema)),
      })),
    }
  else if (action === "presets" && !rest.length) result = toolsets
  else if (action === "schema" && rest.length === 1) {
    const tool = builtinTools(true).find((t) => t.name === rest[0])
    if (!tool) throw new UsageError("Unknown built-in tool")
    result = {
      version: 1,
      name: tool.name,
      stage: stage(tool.name),
      schemaSha256: digest(JSON.stringify(tool.inputSchema)),
      schema: tool.inputSchema,
    }
  } else if (action === "doctor" && !rest.length) {
    const runtime = await searchRuntime()
    result = {
      version: runtime.version,
      sha256: runtime.sha256,
      repaired: runtime.repaired,
      target: `${process.platform}-${process.arch}`,
    }
  } else if (action === "analyze-shell" && rest.length === 1) result = shellStructure(rest[0]!)
  else if (action === "attribute" && rest.length === 3 && ["commit", "pr"].includes(rest[0]!)) {
    process.stdout.write(
      attributeText(
        bytes(rest[2]!, 256 * 1024).toString(),
        rest[0] as "commit" | "pr",
        attributionPolicy(json(rest[1]!, 4096)),
      ),
    )
    return 0
  } else if (action === "export-media" && rest.length === 4 && rest[3] === "--apply") {
    const artifact = generationArtifact(rest[0]!, rest[1]!)
    await writeFile(rest[2]!, artifact.content, { flag: "wx", mode: 0o600 })
    result = { exported: rest[2], bytes: artifact.content.length }
  } else if (action === "--help") {
    process.stdout.write(
      "codesplash tools list | presets | schema NAME | doctor | analyze-shell COMMAND | attribute commit|pr POLICY_JSON TEXT_FILE | export-media STORE JOB DESTINATION --apply\n",
    )
    return 0
  } else throw new UsageError("Use tools --help")
  process.stdout.write(JSON.stringify(result, null, 2) + "\n")
  return 0
}
