import { modelFamily } from "../../core/model-family.ts"
import type { ModelInfo } from "./contracts.ts"

const guidance = {
  generic:
    "Use the advertised tools and their schemas. Inspect relevant files, make focused changes and verify the result.",
  openai:
    "Use apply_patch for focused workspace edits when available. Follow each tool's input schema exactly, inspect current file content and verify changes before reporting completion.",
  anthropic:
    "Read relevant files before editing. Use precise replacements against observed content, batch independent read-only investigation and verify changed behavior.",
  gemini:
    "Ground file paths and symbols in workspace observations. Keep tool arguments within the advertised JSON schemas; make concrete edits and verify each affected behavior.",
  deepseek:
    "Separate concise user-facing progress from tool calls. Use observed file context for patches, preserve unrelated edits and verify results with appropriate commands.",
  qwen: "Use explicit tool calls with complete schema-valid arguments. Inspect paths before editing, keep changes focused and report observed verification results.",
  llama:
    "Use only tools listed in this session. Supply complete arguments, inspect before editing and use actual tool results to decide the next step; never invent execution results.",
}
export function familyPrompt(model: ModelInfo): string {
  return `Model-family guidance (${modelFamily(model)}): ${guidance[modelFamily(model)]}`
}
