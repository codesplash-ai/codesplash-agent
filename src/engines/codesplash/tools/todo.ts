/**
 * todo_write: full-list replace of the harness plan. No filesystem side effects; the loop turns
 * the returned planSteps into a plan.updated event.
 */
import { type HarnessTool, ToolInputError } from "../contracts.ts"
import { truncateToolOutput } from "./truncate.ts"

type TodoItem = {
  id: string
  text: string
  completed: boolean
}

export const todoWriteTool: HarnessTool = {
  name: "todo_write",
  description:
    "Replace the task plan with the complete updated list. Always send every step (full-list replace), " +
    "each with a stable unique id, its text, and whether it is completed. Use it to plan multi-step " +
    "work and to mark steps done as you go.",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The complete plan; this replaces the previous list.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable unique identifier for the step." },
            text: { type: "string", description: "Short description of the step." },
            completed: { type: "boolean", description: "Whether the step is done." },
          },
          required: ["id", "text", "completed"],
          additionalProperties: false,
        },
      },
    },
    required: ["todos"],
    additionalProperties: false,
  },
  isReadOnly: () => true,
  permission: () => ({ kind: "none" }),
  run: async (input) => {
    const todos = parseTodos(input)
    const completed = todos.filter((todo) => todo.completed).length
    const label = todos.length === 0 ? "Plan cleared" : `Plan: ${completed}/${todos.length} steps complete`
    const rendered = todos.map((todo) => `[${todo.completed ? "x" : " "}] ${todo.text}`).join("\n")
    const text =
      todos.length === 0
        ? "Plan cleared."
        : `Plan updated (${completed}/${todos.length} complete):\n${rendered}`
    return {
      text: truncateToolOutput(text),
      label,
      planSteps: todos.map((todo) => ({ text: todo.text, completed: todo.completed })),
    }
  },
}

function parseTodos(input: unknown): TodoItem[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolInputError("todo_write input must be an object with a `todos` array.")
  }
  const todos = (input as Record<string, unknown>).todos
  if (!Array.isArray(todos)) {
    throw new ToolInputError("todo_write requires `todos` to be an array of steps.")
  }
  const seen = new Set<string>()
  return todos.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ToolInputError(`todos[${index}] must be an object with id, text, and completed.`)
    }
    const { id, text, completed } = entry as Record<string, unknown>
    if (typeof id !== "string" || id.length === 0) {
      throw new ToolInputError(`todos[${index}].id must be a non-empty string.`)
    }
    if (typeof text !== "string" || text.length === 0) {
      throw new ToolInputError(`todos[${index}].text must be a non-empty string.`)
    }
    if (typeof completed !== "boolean") {
      throw new ToolInputError(`todos[${index}].completed must be a boolean.`)
    }
    if (seen.has(id)) {
      throw new ToolInputError(`Duplicate todo id "${id}"; every step needs a unique id.`)
    }
    seen.add(id)
    return { id, text, completed }
  })
}
