import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { SessionPolicy } from "../../../src/core/index.ts"
import {
  type HarnessTool,
  type ToolContext,
  ToolInputError,
} from "../../../src/engines/codesplash/contracts.ts"
import { editFileTool } from "../../../src/engines/codesplash/tools/edit.ts"
import { readFileTool } from "../../../src/engines/codesplash/tools/read.ts"
import { writeFileTool } from "../../../src/engines/codesplash/tools/write.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codesplash-tools-files-"))
  temporaryDirectories.push(directory)
  return directory
}

function makeContext(cwd: string, policy: Partial<SessionPolicy> = {}): ToolContext {
  return {
    cwd,
    policy: { sandbox: "workspace-write", approvalPolicy: "on-request", ...policy },
    signal: new AbortController().signal,
  }
}

async function expectToolInputError(promise: Promise<unknown>, pattern: RegExp): Promise<ToolInputError> {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ToolInputError)
  const error = caught as ToolInputError
  expect(error.message).toMatch(pattern)
  return error
}

describe("read_file", () => {
  test("reads a file as line-numbered content", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "file.txt"), "alpha\nbeta\ngamma\n")

    const outcome = await readFileTool.run({ path: "file.txt" }, makeContext(cwd))

    expect(outcome.text).toContain("     1\talpha")
    expect(outcome.text).toContain("     2\tbeta")
    expect(outcome.text).toContain("     3\tgamma")
    expect(outcome.text).not.toContain("showing lines")
    expect(outcome.label).toBe("file.txt")
    expect(outcome.isError).toBeUndefined()
    expect(outcome.mutatedPaths).toBeUndefined()
  })

  test("pages with offset and limit, keeping absolute line numbers", async () => {
    const cwd = await temporaryDirectory()
    const lines = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`)
    await writeFile(join(cwd, "paged.txt"), `${lines.join("\n")}\n`)

    const outcome = await readFileTool.run({ path: "paged.txt", offset: 3, limit: 2 }, makeContext(cwd))

    expect(outcome.text).toContain("     3\tline-3")
    expect(outcome.text).toContain("     4\tline-4")
    expect(outcome.text).not.toContain("line-2")
    expect(outcome.text).not.toContain("line-5")
    expect(outcome.text).toContain("[showing lines 3-4 of 10; continue with offset=5]")
  })

  test("caps a single call at 2000 lines", async () => {
    const cwd = await temporaryDirectory()
    const lines = Array.from({ length: 2500 }, (_, index) => `L${index + 1}`)
    await writeFile(join(cwd, "big.txt"), `${lines.join("\n")}\n`)

    const outcome = await readFileTool.run({ path: "big.txt" }, makeContext(cwd))

    expect(outcome.text).toContain("     1\tL1")
    expect(outcome.text).toContain("  2000\tL2000")
    expect(outcome.text).not.toContain("\tL2001")
    expect(outcome.text).toContain("[showing lines 1-2000 of 2500; continue with offset=2001]")
  })

  test("caps a single call at 50KB of content", async () => {
    const cwd = await temporaryDirectory()
    const lines = Array.from({ length: 100 }, () => "x".repeat(1024))
    await writeFile(join(cwd, "wide.txt"), `${lines.join("\n")}\n`)

    const outcome = await readFileTool.run({ path: "wide.txt" }, makeContext(cwd))

    expect(outcome.text).toContain("    49\t")
    expect(outcome.text).not.toContain("    50\t")
    expect(outcome.text).toContain("[showing lines 1-49 of 100; continue with offset=50]")
  })

  test("clips a single line larger than the byte cap", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "one-line.txt"), "y".repeat(60 * 1024))

    const outcome = await readFileTool.run({ path: "one-line.txt" }, makeContext(cwd))

    expect(outcome.text).toContain("[line 1 clipped to fit the 50KB read cap]")
    expect(outcome.text).not.toContain("showing lines")
    const firstLine = outcome.text.split("\n")[0] ?? ""
    expect(firstLine.length).toBeLessThan(52 * 1024)
    expect(firstLine).toContain("yyyy")
  })

  test("respects a limit larger than the cap by clamping to 2000", async () => {
    const cwd = await temporaryDirectory()
    const lines = Array.from({ length: 2100 }, (_, index) => `L${index + 1}`)
    await writeFile(join(cwd, "clamp.txt"), `${lines.join("\n")}\n`)

    const outcome = await readFileTool.run({ path: "clamp.txt", limit: 5000 }, makeContext(cwd))

    expect(outcome.text).toContain("[showing lines 1-2000 of 2100; continue with offset=2001]")
  })

  test("reports empty files", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "empty.txt"), "")

    const outcome = await readFileTool.run({ path: "empty.txt" }, makeContext(cwd))

    expect(outcome.text).toMatch(/is an empty file/)
  })

  test("refuses directories", async () => {
    const cwd = await temporaryDirectory()
    await mkdir(join(cwd, "some-dir"))

    await expectToolInputError(
      readFileTool.run({ path: "some-dir" }, makeContext(cwd)),
      /is a directory, not a file/,
    )
  })

  test("refuses files over 5MB", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "huge.bin"), Buffer.alloc(5 * 1024 * 1024 + 1, 120))

    await expectToolInputError(readFileTool.run({ path: "huge.bin" }, makeContext(cwd)), /over the 5MB cap/)
  })

  test("errors when the file does not exist", async () => {
    const cwd = await temporaryDirectory()
    await expectToolInputError(readFileTool.run({ path: "missing.txt" }, makeContext(cwd)), /does not exist/)
  })

  test("errors when offset is past the end of the file", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "short.txt"), "one\ntwo\n")

    await expectToolInputError(
      readFileTool.run({ path: "short.txt", offset: 42 }, makeContext(cwd)),
      /offset 42 is past the end .*\(2 lines\)/,
    )
  })

  test("validates its input", async () => {
    const cwd = await temporaryDirectory()
    const context = makeContext(cwd)

    await expectToolInputError(readFileTool.run("nope", context), /expects an object/)
    await expectToolInputError(readFileTool.run({ path: 42 }, context), /path to be a non-empty string/)
    await expectToolInputError(readFileTool.run({ path: "f", offset: 0 }, context), /offset/)
    await expectToolInputError(readFileTool.run({ path: "f", limit: -1 }, context), /limit/)
  })

  test("is read-only and permitted with no approval under every policy", async () => {
    const cwd = await temporaryDirectory()
    expect(readFileTool.name).toBe("read_file")
    expect(readFileTool.isReadOnly({ path: "file.txt" })).toBe(true)

    const policies: Array<Partial<SessionPolicy>> = [
      { sandbox: "read-only" },
      { sandbox: "workspace-write", approvalPolicy: "on-request" },
      { sandbox: "workspace-write", approvalPolicy: "untrusted" },
      { sandbox: "danger-full-access" },
    ]
    for (const policy of policies) {
      expect(readFileTool.permission({ path: "../outside.txt" }, makeContext(cwd, policy))).toEqual({
        kind: "none",
      })
    }
  })

  test("still reads under a read-only sandbox", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "readable.txt"), "content\n")

    const outcome = await readFileTool.run(
      { path: "readable.txt" },
      makeContext(cwd, { sandbox: "read-only" }),
    )

    expect(outcome.text).toContain("content")
  })
})

describe("write_file", () => {
  test("writes a file and reports bytes written", async () => {
    const cwd = await temporaryDirectory()

    const outcome = await writeFileTool.run({ path: "out.txt", content: "hello" }, makeContext(cwd))

    expect(outcome.text).toBe("Wrote 5 bytes to out.txt")
    expect(outcome.label).toBe("out.txt")
    expect(outcome.mutatedPaths).toEqual([resolve(cwd, "out.txt")])
    expect(await readFile(join(cwd, "out.txt"), "utf8")).toBe("hello")
  })

  test("creates parent directories", async () => {
    const cwd = await temporaryDirectory()

    const outcome = await writeFileTool.run({ path: "a/b/c/deep.txt", content: "deep" }, makeContext(cwd))

    expect(outcome.mutatedPaths).toEqual([resolve(cwd, "a/b/c/deep.txt")])
    expect(await readFile(join(cwd, "a/b/c/deep.txt"), "utf8")).toBe("deep")
  })

  test("overwrites existing files and counts multibyte content in bytes", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "note.txt"), "before")

    const outcome = await writeFileTool.run({ path: "note.txt", content: "héllo" }, makeContext(cwd))

    expect(outcome.text).toBe("Wrote 6 bytes to note.txt")
    expect(await readFile(join(cwd, "note.txt"), "utf8")).toBe("héllo")
  })

  test("uses the singular byte label for one byte", async () => {
    const cwd = await temporaryDirectory()
    const outcome = await writeFileTool.run({ path: "one.txt", content: "h" }, makeContext(cwd))
    expect(outcome.text).toBe("Wrote 1 byte to one.txt")
  })

  test("refuses to overwrite a directory", async () => {
    const cwd = await temporaryDirectory()
    await mkdir(join(cwd, "a-dir"))

    await expectToolInputError(
      writeFileTool.run({ path: "a-dir", content: "x" }, makeContext(cwd)),
      /is a directory, not a file/,
    )
  })

  test("validates its input", async () => {
    const cwd = await temporaryDirectory()
    const context = makeContext(cwd)

    await expectToolInputError(writeFileTool.run(null, context), /expects an object/)
    await expectToolInputError(writeFileTool.run({ path: "", content: "x" }, context), /path/)
    await expectToolInputError(writeFileTool.run({ path: "x.txt" }, context), /content to be a string/)
  })

  test("refuses mutations under a read-only sandbox", async () => {
    const cwd = await temporaryDirectory()

    await expectToolInputError(
      writeFileTool.run({ path: "blocked.txt", content: "x" }, makeContext(cwd, { sandbox: "read-only" })),
      /read-only.*refusing/,
    )
    await expect(stat(join(cwd, "blocked.txt"))).rejects.toThrow()
  })

  test("is not read-only", () => {
    expect(writeFileTool.name).toBe("write_file")
    expect(writeFileTool.isReadOnly({ path: "x", content: "y" })).toBe(false)
  })
})

describe("edit_file", () => {
  test("replaces a unique exact match without touching surrounding text", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "code.ts"), "const value = 1\nconst other = 2\n")

    const outcome = await editFileTool.run(
      { path: "code.ts", old_string: "value = 1", new_string: "value = 42" },
      makeContext(cwd),
    )

    expect(outcome.text).toBe("Edited code.ts: replaced 1 occurrence")
    expect(outcome.label).toBe("code.ts")
    expect(outcome.mutatedPaths).toEqual([resolve(cwd, "code.ts")])
    expect(await readFile(join(cwd, "code.ts"), "utf8")).toBe(
      "const value = 1\nconst other = 2\n".replace("value = 1", "value = 42"),
    )
  })

  test("treats dollar signs in new_string literally", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "money.txt"), "price: REPLACE_ME\n")

    await editFileTool.run(
      { path: "money.txt", old_string: "REPLACE_ME", new_string: "$& $' $1" },
      makeContext(cwd),
    )

    expect(await readFile(join(cwd, "money.txt"), "utf8")).toBe("price: $& $' $1\n")
  })

  test("rejects an ambiguous exact match naming the candidate lines", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "dup.txt"), "dup\nkeep\ndup\n")

    const error = await expectToolInputError(
      editFileTool.run({ path: "dup.txt", old_string: "dup", new_string: "swap" }, makeContext(cwd)),
      /matches 2 locations/,
    )
    expect(error.message).toContain("lines 1, 3")
    expect(error.message).toContain("closest candidate is line 1")
    expect(error.message).toContain("replace_all")
    expect(await readFile(join(cwd, "dup.txt"), "utf8")).toBe("dup\nkeep\ndup\n")
  })

  test("replace_all replaces every exact occurrence", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "dup.txt"), "dup\nkeep\ndup\n")

    const outcome = await editFileTool.run(
      { path: "dup.txt", old_string: "dup", new_string: "swap", replace_all: true },
      makeContext(cwd),
    )

    expect(outcome.text).toBe("Edited dup.txt: replaced 2 occurrences")
    expect(await readFile(join(cwd, "dup.txt"), "utf8")).toBe("swap\nkeep\nswap\n")
  })

  test("falls back to whitespace-normalized matching on a single line", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "loose.ts"), "\tif (ready)  {\n\t\tstart()\n\t}\n")

    const outcome = await editFileTool.run(
      { path: "loose.ts", old_string: "if (ready) {", new_string: "if (done) {" },
      makeContext(cwd),
    )

    expect(outcome.text).toContain("(matched after normalizing whitespace)")
    expect(await readFile(join(cwd, "loose.ts"), "utf8")).toBe("if (done) {\n\t\tstart()\n\t}\n")
  })

  test("falls back to whitespace-normalized matching across a multi-line window", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "fn.ts"), "function go() {\n    return 1\n}\n")

    const outcome = await editFileTool.run(
      {
        path: "fn.ts",
        old_string: "function go() {\n  return 1\n}",
        new_string: "function go() {\n  return 2\n}",
      },
      makeContext(cwd),
    )

    expect(outcome.text).toContain("replaced 1 occurrence")
    expect(await readFile(join(cwd, "fn.ts"), "utf8")).toBe("function go() {\n  return 2\n}\n")
  })

  test("rejects an ambiguous whitespace-normalized match", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "two.txt"), "value =  1\nvalue\t= 1\n")

    const error = await expectToolInputError(
      editFileTool.run(
        { path: "two.txt", old_string: "value = 1", new_string: "value = 2" },
        makeContext(cwd),
      ),
      /matches 2 locations/,
    )
    expect(error.message).toContain("lines 1, 2")
    expect(await readFile(join(cwd, "two.txt"), "utf8")).toBe("value =  1\nvalue\t= 1\n")
  })

  test("replace_all applies whitespace-normalized matches everywhere", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "two.txt"), "value =  1\nkeep\nvalue\t= 1\n")

    const outcome = await editFileTool.run(
      { path: "two.txt", old_string: "value = 1", new_string: "value = 2", replace_all: true },
      makeContext(cwd),
    )

    expect(outcome.text).toContain("replaced 2 occurrences")
    expect(await readFile(join(cwd, "two.txt"), "utf8")).toBe("value = 2\nkeep\nvalue = 2\n")
  })

  test("names the closest candidate line when old_string is not found", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "close.ts"), "function computeTotals() {\n  return items.length\n}\n")

    const error = await expectToolInputError(
      editFileTool.run(
        { path: "close.ts", old_string: "function computeTotal() {", new_string: "function computeSum() {" },
        makeContext(cwd),
      ),
      /old_string was not found/,
    )
    expect(error.message).toContain("closest candidate is line 1")
    expect(error.message).toContain("computeTotals")
  })

  test("validates its input", async () => {
    const cwd = await temporaryDirectory()
    const context = makeContext(cwd)

    await expectToolInputError(editFileTool.run([], context), /expects an object/)
    await expectToolInputError(
      editFileTool.run({ path: "f", old_string: "", new_string: "x" }, context),
      /old_string to be a non-empty string/,
    )
    await expectToolInputError(
      editFileTool.run({ path: "f", old_string: "same", new_string: "same" }, context),
      /to differ/,
    )
    await expectToolInputError(
      editFileTool.run({ path: "f", old_string: "a", new_string: "b", replace_all: "yes" }, context),
      /replace_all must be a boolean/,
    )
  })

  test("errors on missing files and directories", async () => {
    const cwd = await temporaryDirectory()
    await mkdir(join(cwd, "a-dir"))

    await expectToolInputError(
      editFileTool.run({ path: "gone.txt", old_string: "a", new_string: "b" }, makeContext(cwd)),
      /does not exist/,
    )
    await expectToolInputError(
      editFileTool.run({ path: "a-dir", old_string: "a", new_string: "b" }, makeContext(cwd)),
      /is a directory, not a file/,
    )
  })

  test("refuses mutations under a read-only sandbox", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "locked.txt"), "original\n")

    await expectToolInputError(
      editFileTool.run(
        { path: "locked.txt", old_string: "original", new_string: "changed" },
        makeContext(cwd, { sandbox: "read-only" }),
      ),
      /read-only.*refusing/,
    )
    expect(await readFile(join(cwd, "locked.txt"), "utf8")).toBe("original\n")
  })

  test("is not read-only", () => {
    expect(editFileTool.name).toBe("edit_file")
    expect(editFileTool.isReadOnly({ path: "x", old_string: "a", new_string: "b" })).toBe(false)
  })
})

describe("mutating-tool permission policy", () => {
  const mutatingTools: Array<[string, HarnessTool]> = [
    ["write_file", writeFileTool],
    ["edit_file", editFileTool],
  ]

  for (const [name, tool] of mutatingTools) {
    test(`${name}: no approval inside cwd under workspace-write + on-request`, async () => {
      const cwd = await temporaryDirectory()
      expect(tool.permission({ path: "notes.txt" }, makeContext(cwd))).toEqual({ kind: "none" })
      expect(tool.permission({ path: "sub/../notes.txt" }, makeContext(cwd))).toEqual({ kind: "none" })
      expect(tool.permission({ path: join(cwd, "abs.txt") }, makeContext(cwd))).toEqual({ kind: "none" })
    })

    test(`${name}: approval outside cwd under workspace-write + on-request`, async () => {
      const cwd = await temporaryDirectory()
      const outside = await temporaryDirectory()

      expect(tool.permission({ path: "../escape.txt" }, makeContext(cwd))).toEqual({
        kind: "approval",
        title: "Apply file changes?",
        detail: resolve(cwd, "../escape.txt"),
      })
      expect(tool.permission({ path: join(outside, "far.txt") }, makeContext(cwd))).toEqual({
        kind: "approval",
        title: "Apply file changes?",
        detail: join(outside, "far.txt"),
      })
    })

    test(`${name}: approval when a workspace symlink escapes cwd under on-request`, async () => {
      const cwd = await temporaryDirectory()
      const outside = await temporaryDirectory()
      await symlink(outside, join(cwd, "deps"))
      await writeFile(join(outside, "config.json"), "{}\n")

      // Lexically deps/config.json sits inside cwd, but the symlink points outside the
      // workspace: the gate must resolve the physical path and ask for approval.
      expect(tool.permission({ path: "deps/config.json" }, makeContext(cwd))).toEqual({
        kind: "approval",
        title: "Apply file changes?",
        detail: join(cwd, "deps", "config.json"),
      })
      // A direct symlink to an outside file is caught the same way.
      await symlink(join(outside, "config.json"), join(cwd, "linked.json"))
      expect(tool.permission({ path: "linked.json" }, makeContext(cwd))).toEqual({
        kind: "approval",
        title: "Apply file changes?",
        detail: join(cwd, "linked.json"),
      })
    })

    test(`${name}: approval even inside cwd under workspace-write + untrusted`, async () => {
      const cwd = await temporaryDirectory()
      const permission = tool.permission(
        { path: "inside.txt" },
        makeContext(cwd, { approvalPolicy: "untrusted" }),
      )
      expect(permission).toEqual({
        kind: "approval",
        title: "Apply file changes?",
        detail: resolve(cwd, "inside.txt"),
      })
    })

    test(`${name}: no approval anywhere under danger-full-access`, async () => {
      const cwd = await temporaryDirectory()
      expect(
        tool.permission({ path: "../outside.txt" }, makeContext(cwd, { sandbox: "danger-full-access" })),
      ).toEqual({ kind: "none" })
    })

    test(`${name}: no approval prompt under a read-only sandbox (run refuses instead)`, async () => {
      const cwd = await temporaryDirectory()
      expect(tool.permission({ path: "any.txt" }, makeContext(cwd, { sandbox: "read-only" }))).toEqual({
        kind: "none",
      })
    })

    test(`${name}: unparseable input yields no approval (run reports the input error)`, async () => {
      const cwd = await temporaryDirectory()
      expect(tool.permission({}, makeContext(cwd))).toEqual({ kind: "none" })
      expect(tool.permission(null, makeContext(cwd))).toEqual({ kind: "none" })
    })
  }
})

describe("file-tool permissionTargets", () => {
  const cases: Array<[HarnessTool, (path: string) => Record<string, unknown>]> = [
    [readFileTool, (path) => ({ path })],
    [writeFileTool, (path) => ({ path, content: "x" })],
    [editFileTool, (path) => ({ path, old_string: "a", new_string: "b" })],
  ]

  test("resolves the input path against the cwd, absolute paths pass through", async () => {
    const cwd = await temporaryDirectory()
    const context = makeContext(cwd)
    for (const [tool, inputFor] of cases) {
      expect(tool.permissionTargets?.(inputFor("src/a.ts"), context)).toEqual({
        paths: [resolve(cwd, "src/a.ts")],
      })
      expect(tool.permissionTargets?.(inputFor("/outside/dir/b.ts"), context)).toEqual({
        paths: ["/outside/dir/b.ts"],
      })
    }
  })

  test("malformed input throws ToolInputError (the loop then falls to the default path)", async () => {
    const cwd = await temporaryDirectory()
    const context = makeContext(cwd)
    for (const [tool] of cases) {
      expect(() => tool.permissionTargets?.({}, context)).toThrow(ToolInputError)
      expect(() => tool.permissionTargets?.(null, context)).toThrow(ToolInputError)
    }
  })
})
