/**
 * Assembles the built-in tool set and provides name-indexed lookup for the loop. This file is the
 * one tools/ module allowed to import its siblings.
 */
import type { HarnessTool, ToolCallBlock, ToolSpec } from "../contracts.ts"
import { readToolOutputTool } from "../tool-output-store.ts"
import { applyPatchTool } from "./apply-patch.ts"
import { bashTool } from "./bash.ts"
import { editFileTool } from "./edit.ts"
import { globTool } from "./glob.ts"
import { grepTool } from "./grep.ts"
import { enterPlanModeTool, exitPlanModeTool } from "./plan-mode.ts"
import { askUserTool } from "./question.ts"
import { readFileTool } from "./read.ts"
import { requestPermissionsTool } from "./request-permissions.ts"
import { todoWriteTool } from "./todo.ts"
import { createWebFetchTool } from "./web-fetch.ts"
import { createWebSearchTool } from "./web-search.ts"
import { writeFileTool } from "./write.ts"

export type ToolRegistry = {
  readonly generation: string
  specs(): ToolSpec[]
  /** Resolve deferred targets before validation, batching and permissions. */
  resolve?(call: ToolCallBlock): { call: ToolCallBlock; tool: HarnessTool }
  get(name: string, expectedGeneration?: string): HarnessTool | undefined
  source(name: string): { id: string; generation: string } | undefined
}

export function builtinTools(): HarnessTool[] {
  return [
    readFileTool,
    writeFileTool,
    editFileTool,
    applyPatchTool,
    globTool,
    grepTool,
    createWebFetchTool(),
    createWebSearchTool(),
    bashTool,
    todoWriteTool,
    askUserTool,
    enterPlanModeTool,
    exitPlanModeTool,
    requestPermissionsTool,
    readToolOutputTool,
  ]
}

export function createToolRegistry(tools: HarnessTool[], generation = "builtin"): ToolRegistry {
  const byName = new Map<string, HarnessTool>()
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`)
    byName.set(tool.name, tool)
  }
  return {
    generation,
    specs: () =>
      [...byName.values()]
        .filter((tool) => !tool.hidden)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
    get: (name, expectedGeneration) => {
      if (expectedGeneration !== undefined && expectedGeneration !== generation)
        throw new Error("Tool selection belongs to a stale runtime generation")
      return byName.get(name)
    },
    source: (name) => (byName.has(name) ? { id: "builtin", generation } : undefined),
  }
}
