/**
 * Assembles the built-in tool set and provides name-indexed lookup for the loop. This file is the
 * one tools/ module allowed to import its siblings.
 */
import type { HarnessTool, ToolSpec } from "../contracts.ts"
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
  specs(): ToolSpec[]
  get(name: string): HarnessTool | undefined
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
  ]
}

export function createToolRegistry(tools: HarnessTool[]): ToolRegistry {
  const byName = new Map<string, HarnessTool>()
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`)
    byName.set(tool.name, tool)
  }
  return {
    specs: () =>
      [...byName.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    get: (name) => byName.get(name),
  }
}
