import type { ToolResultBlock } from "../contracts.ts"

export type Personality = "neutral" | "concise" | "explanatory"
export type ContextInputConfig = {
  claudeRules?: boolean
  cursorRules?: boolean
  claudeSkills?: boolean
  claudeCommands?: boolean
  sharedSkills?: boolean
  includeRoots?: string[]
  personality?: Personality
}
export type Resource = {
  kind: "rule" | "command" | "skill"
  name: string
  path: string
  source: "project" | "user" | "claude" | "cursor" | "shared"
  description: string
  disabled?: boolean
  fork?: boolean
}
export type ResourceCatalog = { resources: Resource[]; diagnostics: string[] }
export type ContextToolRunner = (name: string, input: unknown) => Promise<ToolResultBlock>
export const INPUT_FILE_BYTES = 24 * 1024
export const INPUT_TOTAL_BYTES = 48 * 1024
export const RESOURCE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
