import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { defaultSessionPolicy } from "../../../src/core/index.ts"
import { type ToolContext, ToolInputError } from "../../../src/engines/codesplash/contracts.ts"
import { globTool } from "../../../src/engines/codesplash/tools/glob.ts"
import { grepTool } from "../../../src/engines/codesplash/tools/grep.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function makeFixture(files: Record<string, string | Buffer> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codesplash-search-"))
  temporaryDirectories.push(root)
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(root, relativePath)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, content)
  }
  return root
}

function contextFor(cwd: string, signal?: AbortSignal): ToolContext {
  return { cwd, policy: defaultSessionPolicy, signal: signal ?? new AbortController().signal }
}

function abortedContext(cwd: string): ToolContext {
  const controller = new AbortController()
  controller.abort()
  return contextFor(cwd, controller.signal)
}

describe("glob tool", () => {
  test("is read-only with no permission under every policy", () => {
    expect(globTool.name).toBe("glob")
    expect(globTool.isReadOnly({ pattern: "**/*" })).toBe(true)
    const cwd = "/anywhere"
    const policies: ToolContext["policy"][] = [
      defaultSessionPolicy,
      { sandbox: "read-only", approvalPolicy: "untrusted" },
      { sandbox: "danger-full-access", approvalPolicy: "on-request" },
    ]
    for (const policy of policies) {
      const permission = globTool.permission(
        { pattern: "**/*" },
        { cwd, policy, signal: new AbortController().signal },
      )
      expect(permission).toEqual({ kind: "none" })
    }
  })

  test("matches patterns relative to the cwd", async () => {
    const root = await makeFixture({
      "a.ts": "a",
      "b.txt": "b",
      "src/c.ts": "c",
      "src/deep/d.ts": "d",
    })
    const shallow = await globTool.run({ pattern: "*.ts" }, contextFor(root))
    expect(shallow.text.split("\n").sort()).toEqual(["a.ts"])
    expect(shallow.isError).toBeUndefined()
    expect(shallow.label).toBe("glob *.ts")

    const recursive = await globTool.run({ pattern: "**/*.ts" }, contextFor(root))
    expect(recursive.text.split("\n").sort()).toEqual(["a.ts", "src/c.ts", "src/deep/d.ts"])
  })

  test("skips .git and node_modules", async () => {
    const root = await makeFixture({
      "a.ts": "a",
      ".git/hooks/hook.ts": "x",
      "node_modules/pkg/index.ts": "x",
      "src/node_modules/nested/deep.ts": "x",
    })
    const outcome = await globTool.run({ pattern: "**/*.ts" }, contextFor(root))
    expect(outcome.text.split("\n")).toEqual(["a.ts"])
  })

  test("sorts by mtime descending", async () => {
    const root = await makeFixture({ "old.ts": "1", "mid.ts": "2", "new.ts": "3" })
    await utimes(join(root, "old.ts"), new Date("2020-01-01"), new Date("2020-01-01"))
    await utimes(join(root, "mid.ts"), new Date("2022-01-01"), new Date("2022-01-01"))
    await utimes(join(root, "new.ts"), new Date("2024-01-01"), new Date("2024-01-01"))
    const outcome = await globTool.run({ pattern: "*.ts" }, contextFor(root))
    expect(outcome.text.split("\n")).toEqual(["new.ts", "mid.ts", "old.ts"])
  })

  test("caps results at 500 entries, keeping the most recently modified", async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 520; index += 1) {
      files[`f${String(index).padStart(3, "0")}.txt`] = "x"
    }
    const root = await makeFixture(files)
    await utimes(join(root, "f519.txt"), new Date("2030-01-01"), new Date("2030-01-01"))
    const outcome = await globTool.run({ pattern: "*.txt" }, contextFor(root))
    const lines = outcome.text.split("\n")
    expect(lines).toHaveLength(501)
    expect(lines[0]).toBe("f519.txt")
    expect(lines[500]).toContain("20 more entries omitted")
    expect(lines[500]).toContain("500 most recently modified")
  })

  test("reports no matches without an error", async () => {
    const root = await makeFixture({ "a.txt": "a" })
    const outcome = await globTool.run({ pattern: "*.md" }, contextFor(root))
    expect(outcome.text).toBe("No files matched the pattern.")
    expect(outcome.isError).toBeUndefined()
  })

  test("rejects bad input with ToolInputError", async () => {
    const root = await makeFixture()
    const context = contextFor(root)
    await expect(globTool.run({}, context)).rejects.toThrow(ToolInputError)
    await expect(globTool.run("nope", context)).rejects.toThrow(ToolInputError)
    await expect(globTool.run({ pattern: "" }, context)).rejects.toThrow(ToolInputError)
    await expect(globTool.run({ pattern: "/etc/*" }, context)).rejects.toThrow(ToolInputError)
    await expect(globTool.run({ pattern: "../*" }, context)).rejects.toThrow(ToolInputError)
  })

  test("returns an error outcome when already aborted", async () => {
    const root = await makeFixture({ "a.ts": "a" })
    const outcome = await globTool.run({ pattern: "*.ts" }, abortedContext(root))
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain("aborted")
  })
})

describe("grep tool", () => {
  test("is read-only with no permission under every policy", () => {
    expect(grepTool.name).toBe("grep")
    expect(grepTool.isReadOnly({ pattern: "x" })).toBe(true)
    const permission = grepTool.permission(
      { pattern: "x" },
      {
        cwd: "/anywhere",
        policy: { sandbox: "read-only", approvalPolicy: "untrusted" },
        signal: new AbortController().signal,
      },
    )
    expect(permission).toEqual({ kind: "none" })
  })

  test("finds regex matches as path:line:text, files in path order", async () => {
    const root = await makeFixture({
      "b.ts": "alpha\nbeta target\ngamma",
      "src/a.ts": "target here\nnothing",
    })
    const outcome = await grepTool.run({ pattern: "ta.get" }, contextFor(root))
    expect(outcome.text.split("\n")).toEqual(["b.ts:2:beta target", "src/a.ts:1:target here"])
    expect(outcome.isError).toBeUndefined()
    expect(outcome.label).toBe("grep ta.get")
  })

  test("treats the pattern as a real regex with anchors", async () => {
    const root = await makeFixture({ "a.txt": "target start\nnot a target" })
    const outcome = await grepTool.run({ pattern: "^target" }, contextFor(root))
    expect(outcome.text.split("\n")).toEqual(["a.txt:1:target start"])
  })

  test("-i enables case-insensitive matching", async () => {
    const root = await makeFixture({ "a.txt": "Target line" })
    const sensitive = await grepTool.run({ pattern: "target" }, contextFor(root))
    expect(sensitive.text).toBe("No matches found.")
    const insensitive = await grepTool.run({ pattern: "target", "-i": true }, contextFor(root))
    expect(insensitive.text.split("\n")).toEqual(["a.txt:1:Target line"])
  })

  test("glob filter restricts searched files and matches basenames of nested files", async () => {
    const root = await makeFixture({
      "a.ts": "target one",
      "b.md": "target two",
      "src/d.ts": "target three",
    })
    const outcome = await grepTool.run({ pattern: "target", glob: "*.ts" }, contextFor(root))
    expect(outcome.text.split("\n")).toEqual(["a.ts:1:target one", "src/d.ts:1:target three"])
    expect(outcome.label).toBe("grep target *.ts")
  })

  test("context lines wrap matches, merge overlaps, and separate groups with --", async () => {
    const lines = ["l1", "l2", "l3", "hit l4", "l5", "hit l6", "l7", "l8", "l9", "l10", "hit l11", "l12"]
    const root = await makeFixture({ "ctx.txt": lines.join("\n") })
    const outcome = await grepTool.run({ pattern: "^hit", context: 1 }, contextFor(root))
    expect(outcome.text.split("\n")).toEqual([
      "ctx.txt-3-l3",
      "ctx.txt:4:hit l4",
      "ctx.txt-5-l5",
      "ctx.txt:6:hit l6",
      "ctx.txt-7-l7",
      "--",
      "ctx.txt-10-l10",
      "ctx.txt:11:hit l11",
      "ctx.txt-12-l12",
    ])
  })

  test("skips .git and node_modules contents", async () => {
    const root = await makeFixture({
      "a.txt": "target",
      ".git/config": "target",
      "node_modules/pkg/index.js": "target",
    })
    const outcome = await grepTool.run({ pattern: "target" }, contextFor(root))
    expect(outcome.text.split("\n")).toEqual(["a.txt:1:target"])
  })

  test("skips binary-looking files", async () => {
    const root = await makeFixture({
      "a.txt": "target",
      "bin.dat": Buffer.concat([Buffer.from("target "), Buffer.from([0, 1, 2]), Buffer.from("tail")]),
    })
    const outcome = await grepTool.run({ pattern: "target" }, contextFor(root))
    expect(outcome.text.split("\n")).toEqual(["a.txt:1:target"])
  })

  test("skips files larger than 1MB", async () => {
    const root = await makeFixture({
      "a.txt": "target",
      "big.txt": `target\n${"x".repeat(1024 * 1024 + 64)}`,
    })
    const outcome = await grepTool.run({ pattern: "target" }, contextFor(root))
    expect(outcome.text.split("\n")).toEqual(["a.txt:1:target"])
  })

  test("caps results at 200 matches with a cap marker", async () => {
    const many = Array.from({ length: 250 }, (_, index) => `match ${index}`).join("\n")
    const root = await makeFixture({ "many.txt": many })
    const outcome = await grepTool.run({ pattern: "^match" }, contextFor(root))
    const lines = outcome.text.split("\n")
    const matchLines = lines.filter((line) => line.startsWith("many.txt:"))
    expect(matchLines).toHaveLength(200)
    expect(matchLines[199]).toBe("many.txt:200:match 199")
    expect(lines[lines.length - 1]).toContain("200-match cap")
  })

  test("caps output at 50KB head+tail with an elision marker", async () => {
    const wide = Array.from({ length: 200 }, (_, index) => `match ${index} ${"x".repeat(400)}`).join("\n")
    const root = await makeFixture({ "wide.txt": wide })
    const outcome = await grepTool.run({ pattern: "^match" }, contextFor(root))
    expect(new TextEncoder().encode(outcome.text).byteLength).toBeLessThanOrEqual(50 * 1024)
    const lines = outcome.text.split("\n")
    expect(lines[0]).toStartWith("wide.txt:1:match 0")
    expect(lines[lines.length - 1]).toContain("200-match cap")
    expect(outcome.text).toContain("[... output truncated:")
  })

  test("caps output at 2000 lines when context expands the result", async () => {
    const fileLines = Array.from({ length: 3000 }, (_, index) =>
      index % 30 === 0 ? `hit ${index}` : `line ${index}`,
    )
    const root = await makeFixture({ "long.txt": fileLines.join("\n") })
    const outcome = await grepTool.run({ pattern: "^hit", context: 12 }, contextFor(root))
    const lines = outcome.text.split("\n")
    expect(lines.length).toBeLessThanOrEqual(2001)
    expect(outcome.text).toContain("[... output truncated:")
    expect(lines[0]).toBe("long.txt:1:hit 0")
    expect(lines[lines.length - 1]).toBe("long.txt-2983-line 2982")
  })

  test("reports no matches without an error", async () => {
    const root = await makeFixture({ "a.txt": "nothing here" })
    const outcome = await grepTool.run({ pattern: "absent" }, contextFor(root))
    expect(outcome.text).toBe("No matches found.")
    expect(outcome.isError).toBeUndefined()
  })

  test("rejects bad input with ToolInputError", async () => {
    const root = await makeFixture()
    const context = contextFor(root)
    await expect(grepTool.run({}, context)).rejects.toThrow(ToolInputError)
    await expect(grepTool.run({ pattern: "(" }, context)).rejects.toThrow(ToolInputError)
    await expect(grepTool.run({ pattern: "x", "-i": "yes" }, context)).rejects.toThrow(ToolInputError)
    await expect(grepTool.run({ pattern: "x", context: -1 }, context)).rejects.toThrow(ToolInputError)
    await expect(grepTool.run({ pattern: "x", context: 1.5 }, context)).rejects.toThrow(ToolInputError)
    await expect(grepTool.run({ pattern: "x", glob: "" }, context)).rejects.toThrow(ToolInputError)
    await expect(grepTool.run({ pattern: "x", glob: "/etc/*" }, context)).rejects.toThrow(ToolInputError)
  })

  test("returns an error outcome when already aborted", async () => {
    const root = await makeFixture({ "a.txt": "target" })
    const outcome = await grepTool.run({ pattern: "target" }, abortedContext(root))
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain("aborted")
  })
})
