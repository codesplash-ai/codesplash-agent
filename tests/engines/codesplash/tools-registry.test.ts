import { describe, expect, test } from "bun:test"
import {
  ASK_USER_TOOL_NAME,
  type HarnessTool,
  type ToolContext,
  ToolInputError,
} from "../../../src/engines/codesplash/contracts.ts"
import { askUserTool } from "../../../src/engines/codesplash/tools/question.ts"
import { builtinTools, createToolRegistry } from "../../../src/engines/codesplash/tools/registry.ts"
import { todoWriteTool } from "../../../src/engines/codesplash/tools/todo.ts"
import {
  DEFAULT_TRUNCATE_MAX_BYTES,
  DEFAULT_TRUNCATE_MAX_LINES,
  truncateToolOutput,
} from "../../../src/engines/codesplash/tools/truncate.ts"

const MARKER = "[... output truncated:"

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: "/tmp",
    policy: { sandbox: "workspace-write", approvalPolicy: "on-request" },
    signal: new AbortController().signal,
    ...overrides,
  }
}

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line-${index + 1}`).join("\n")
}

function stubTool(name: string): HarnessTool {
  return {
    name,
    description: `stub ${name}`,
    inputSchema: { type: "object" },
    isReadOnly: () => true,
    permission: () => ({ kind: "none" }),
    run: async () => ({ text: "", label: name }),
  }
}

describe("truncateToolOutput", () => {
  test("returns short text unchanged", () => {
    expect(truncateToolOutput("")).toBe("")
    expect(truncateToolOutput("hello\nworld")).toBe("hello\nworld")
  })

  test("exports the documented default caps", () => {
    expect(DEFAULT_TRUNCATE_MAX_LINES).toBe(2000)
    expect(DEFAULT_TRUNCATE_MAX_BYTES).toBe(50 * 1024)
  })

  test("text exactly at both caps passes untouched, including a trailing newline", () => {
    const atCap = `${numberedLines(2000)}\n`
    expect(truncateToolOutput(atCap)).toBe(atCap)
  })

  test("keeps head and tail and elides the middle when over the line cap", () => {
    const result = truncateToolOutput(numberedLines(5000))
    const lines = result.split("\n")
    expect(lines).toHaveLength(2001)
    expect(lines[0]).toBe("line-1")
    expect(lines[999]).toBe("line-1000")
    expect(lines[1000]).toBe("[... output truncated: 3000 lines (30001 bytes) elided ...]")
    expect(lines[1001]).toBe("line-4001")
    expect(lines[2000]).toBe("line-5000")
  })

  test("preserves a trailing newline through truncation", () => {
    const result = truncateToolOutput(`${numberedLines(5000)}\n`)
    expect(result.endsWith("line-5000\n")).toBe(true)
    expect(result).toContain(MARKER)
  })

  test("honors a custom line cap", () => {
    const result = truncateToolOutput(numberedLines(25), { maxLines: 10 })
    const lines = result.split("\n")
    expect(lines).toHaveLength(11)
    expect(lines.slice(0, 5)).toEqual(["line-1", "line-2", "line-3", "line-4", "line-5"])
    expect(lines[5]).toContain("15 lines")
    expect(lines.slice(6)).toEqual(["line-21", "line-22", "line-23", "line-24", "line-25"])
  })

  test("keeps both ends of a single line over the byte cap", () => {
    const result = truncateToolOutput("a".repeat(100_000), { maxBytes: 1024 })
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(1024)
    expect(result.startsWith("aaa")).toBe(true)
    expect(result.endsWith("aaa")).toBe(true)
    expect(result).toContain(MARKER)
    expect(result).toContain("bytes) elided")
  })

  test("byte cap applies after line selection", () => {
    const wide = Array.from({ length: 100 }, () => "x".repeat(1000)).join("\n")
    const result = truncateToolOutput(wide, { maxLines: 50, maxBytes: 2048 })
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(2048)
    expect(result.startsWith("xxx")).toBe(true)
    expect(result.endsWith("xxx")).toBe(true)
    expect(result).toContain(MARKER)
  })

  test("never splits a multibyte character at the byte cut", () => {
    const result = truncateToolOutput("héllo—wörld🙂".repeat(5000), { maxBytes: 501 })
    expect(result).not.toContain("�")
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(501)
    expect(result).toContain(MARKER)
  })

  test("reports elided line and byte counts in the marker", () => {
    const result = truncateToolOutput(numberedLines(30), { maxLines: 20 })
    expect(result).toContain("10 lines")
    expect(result).toMatch(/\[\.\.\. output truncated: 10 lines \(\d+ bytes\) elided \.\.\.\]/)
  })
})

describe("todo_write", () => {
  test("declares a read-only, permission-free spec", () => {
    expect(todoWriteTool.name).toBe("todo_write")
    expect(todoWriteTool.isReadOnly({ todos: [] })).toBe(true)
    expect(todoWriteTool.permission({ todos: [] }, context())).toEqual({ kind: "none" })
    expect(todoWriteTool.inputSchema.required).toEqual(["todos"])
  })

  test("returns planSteps mirroring the full replacement list", async () => {
    const outcome = await todoWriteTool.run(
      {
        todos: [
          { id: "1", text: "read the config", completed: true },
          { id: "2", text: "write the tests", completed: false },
        ],
      },
      context(),
    )
    expect(outcome.isError).toBeUndefined()
    expect(outcome.planSteps).toEqual([
      { text: "read the config", completed: true },
      { text: "write the tests", completed: false },
    ])
    expect(outcome.label).toBe("Plan: 1/2 steps complete")
    expect(outcome.text).toContain("[x] read the config")
    expect(outcome.text).toContain("[ ] write the tests")
    expect(outcome.mutatedPaths).toBeUndefined()
  })

  test("accepts an empty list as clearing the plan", async () => {
    const outcome = await todoWriteTool.run({ todos: [] }, context())
    expect(outcome.planSteps).toEqual([])
    expect(outcome.label).toBe("Plan cleared")
  })

  test("rejects duplicate ids", async () => {
    const input = {
      todos: [
        { id: "step", text: "first", completed: false },
        { id: "step", text: "second", completed: false },
      ],
    }
    await expect(todoWriteTool.run(input, context())).rejects.toThrow(ToolInputError)
    await expect(todoWriteTool.run(input, context())).rejects.toThrow('Duplicate todo id "step"')
  })

  test.each([
    ["non-object input", "todos"],
    [{ todos: "not-an-array" }, "array"],
    [{ todos: [null] }, "todos[0]"],
    [{ todos: [{ id: "", text: "x", completed: false }] }, "todos[0].id"],
    [{ todos: [{ id: 7, text: "x", completed: false }] }, "todos[0].id"],
    [{ todos: [{ id: "a", text: "", completed: false }] }, "todos[0].text"],
    [{ todos: [{ id: "a", text: "x" }] }, "todos[0].completed"],
    [{ todos: [{ id: "a", text: "x", completed: "yes" }] }, "todos[0].completed"],
  ])("rejects invalid input %p", async (input, messagePart) => {
    await expect(todoWriteTool.run(input, context())).rejects.toThrow(ToolInputError)
    await expect(todoWriteTool.run(input, context())).rejects.toThrow(messagePart as string)
  })
})

describe("ask_user", () => {
  test("uses the intrinsic tool name and a 2-6 option schema", () => {
    expect(askUserTool.name).toBe(ASK_USER_TOOL_NAME)
    expect(askUserTool.inputSchema.required).toEqual(["question", "options"])
    const properties = askUserTool.inputSchema.properties as Record<string, Record<string, unknown>>
    expect(properties.question?.type).toBe("string")
    expect(properties.options?.minItems).toBe(2)
    expect(properties.options?.maxItems).toBe(6)
  })

  test("is read-only and needs no approval", () => {
    expect(askUserTool.isReadOnly({ question: "q", options: ["a", "b"] })).toBe(true)
    expect(askUserTool.permission({ question: "q", options: ["a", "b"] }, context())).toEqual({
      kind: "none",
    })
  })

  test("run() throws because the loop executes it intrinsically", async () => {
    await expect(askUserTool.run({ question: "q", options: ["a", "b"] }, context())).rejects.toThrow(
      "harness loop",
    )
  })
})

describe("tool registry", () => {
  test("builtinTools includes plan-mode and retained-output intrinsics", () => {
    expect(builtinTools().map((tool) => tool.name)).toEqual([
      "read_file",
      "write_file",
      "edit_file",
      "apply_patch",
      "glob",
      "grep",
      "web_fetch",
      "web_search",
      "bash",
      "todo_write",
      "ask_user",
      "enter_plan_mode",
      "exit_plan_mode",
      "request_permissions",
      "read_tool_output",
    ])
  })

  test("plan-mode tools are spec-only: intrinsic, approval-free, and run() must never execute", async () => {
    const registry = createToolRegistry(builtinTools())
    for (const name of ["enter_plan_mode", "exit_plan_mode"]) {
      const tool = registry.get(name)
      expect(tool).toBeDefined()
      if (!tool) continue
      expect(tool.isReadOnly({})).toBe(true)
      expect(tool.permission({}, context())).toEqual({ kind: "none" })
      await expect(tool.run({}, context())).rejects.toThrow("intrinsic")
    }
  })

  test("specs() reflects each tool's name, description, and schema", () => {
    const registry = createToolRegistry([todoWriteTool, askUserTool])
    const specs = registry.specs()
    expect(specs).toHaveLength(2)
    expect(specs[1]).toEqual({
      name: todoWriteTool.name,
      description: todoWriteTool.description,
      inputSchema: todoWriteTool.inputSchema,
    })
    expect(specs[0]?.name).toBe(ASK_USER_TOOL_NAME)
    expect(createToolRegistry([askUserTool, todoWriteTool]).specs()).toEqual(specs)
  })

  test("get() finds tools by name and returns undefined otherwise", () => {
    const registry = createToolRegistry(builtinTools())
    expect(registry.get("todo_write")).toBe(todoWriteTool)
    expect(registry.get("ask_user")).toBe(askUserTool)
    expect(registry.get("bash")?.name).toBe("bash")
    expect(registry.get("no_such_tool")).toBeUndefined()
  })

  test("duplicate tool names throw", () => {
    expect(() => createToolRegistry([stubTool("bash"), stubTool("bash")])).toThrow(
      "Duplicate tool name: bash",
    )
  })

  test("every built-in spec is model-ready", () => {
    for (const spec of createToolRegistry(builtinTools()).specs()) {
      expect(spec.name.length).toBeGreaterThan(0)
      expect(spec.description.length).toBeGreaterThan(0)
      expect(spec.inputSchema.type).toBe("object")
    }
  })
})
