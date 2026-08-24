import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { SessionPolicy } from "../../../src/core/index.ts"
import { type ToolContext, ToolInputError } from "../../../src/engines/codesplash/contracts.ts"
import { applyPatchTool } from "../../../src/engines/codesplash/tools/apply-patch.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codesplash-tools-apply-patch-"))
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

function patch(...lines: string[]): { input: string } {
  return { input: ["*** Begin Patch", ...lines, "*** End Patch", ""].join("\n") }
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

describe("apply_patch envelope parsing", () => {
  test("validates its input shape", async () => {
    const cwd = await temporaryDirectory()
    const context = makeContext(cwd)

    await expectToolInputError(applyPatchTool.run("nope", context), /expects an object/)
    await expectToolInputError(applyPatchTool.run({}, context), /non-empty patch string/)
    await expectToolInputError(applyPatchTool.run({ input: "   " }, context), /non-empty patch string/)
    await expectToolInputError(applyPatchTool.run({ input: 42 }, context), /non-empty patch string/)
  })

  test("requires the begin marker", async () => {
    const cwd = await temporaryDirectory()
    await expectToolInputError(
      applyPatchTool.run({ input: "*** Add File: x.txt\n+hi\n*** End Patch\n" }, makeContext(cwd)),
      /must start with "\*\*\* Begin Patch"/,
    )
  })

  test("requires the end marker", async () => {
    const cwd = await temporaryDirectory()
    await expectToolInputError(
      applyPatchTool.run({ input: "*** Begin Patch\n*** Add File: x.txt\n+hi\n" }, makeContext(cwd)),
      /missing its closing "\*\*\* End Patch"/,
    )
  })

  test("rejects unknown directives, naming the offending line", async () => {
    const cwd = await temporaryDirectory()
    const error = await expectToolInputError(
      applyPatchTool.run(patch("*** Frobnicate: x.txt"), makeContext(cwd)),
      /invalid patch at line 2/,
    )
    expect(error.message).toContain("Frobnicate")
    expect(error.message).toContain("expected a *** directive")
  })

  test("rejects added-file lines missing their '+' prefix", async () => {
    const cwd = await temporaryDirectory()
    const error = await expectToolInputError(
      applyPatchTool.run(patch("*** Add File: x.txt", "+ok", "bad line"), makeContext(cwd)),
      /added lines for x\.txt must start with "\+"/,
    )
    expect(error.message).toContain('"bad line"')
    await expect(stat(join(cwd, "x.txt"))).rejects.toThrow()
  })

  test("rejects hunk lines with an unknown prefix", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "y.txt"), "line\n")
    await expectToolInputError(
      applyPatchTool.run(patch("*** Update File: y.txt", "@@", "?what"), makeContext(cwd)),
      /hunk lines in y\.txt must start with/,
    )
  })

  test("rejects an empty patch", async () => {
    const cwd = await temporaryDirectory()
    await expectToolInputError(applyPatchTool.run(patch(), makeContext(cwd)), /contains no file operations/)
  })

  test("rejects content after the end marker", async () => {
    const cwd = await temporaryDirectory()
    await expectToolInputError(
      applyPatchTool.run(
        { input: "*** Begin Patch\n*** Delete File: a.txt\n*** End Patch\nstray\n" },
        makeContext(cwd),
      ),
      /content after "\*\*\* End Patch"/,
    )
  })

  test("rejects an update with no hunks and no move", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "z.txt"), "line\n")
    await expectToolInputError(
      applyPatchTool.run(patch("*** Update File: z.txt"), makeContext(cwd)),
      /update for z\.txt contains no hunks/,
    )
  })
})

describe("apply_patch add", () => {
  test("adds a new file, creating parent directories", async () => {
    const cwd = await temporaryDirectory()

    const outcome = await applyPatchTool.run(
      patch("*** Add File: notes/new.txt", "+hello", "+world"),
      makeContext(cwd),
    )

    expect(await readFile(join(cwd, "notes/new.txt"), "utf8")).toBe("hello\nworld\n")
    expect(outcome.text).toContain("Applied patch to 1 file")
    expect(outcome.text).toContain("Added notes/new.txt")
    expect(outcome.label).toBe("notes/new.txt")
    expect(outcome.isError).toBeUndefined()
    expect(outcome.mutatedPaths).toEqual([resolve(cwd, "notes/new.txt")])
  })

  test("adds an empty file from a bodyless add", async () => {
    const cwd = await temporaryDirectory()

    await applyPatchTool.run(patch("*** Add File: empty.txt"), makeContext(cwd))

    expect(await readFile(join(cwd, "empty.txt"), "utf8")).toBe("")
  })

  test("preserves '+'-leading content lines", async () => {
    const cwd = await temporaryDirectory()

    await applyPatchTool.run(patch("*** Add File: diff.txt", "++added", "+ context"), makeContext(cwd))

    expect(await readFile(join(cwd, "diff.txt"), "utf8")).toBe("+added\n context\n")
  })

  test("refuses to add a file that already exists", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "taken.txt"), "original\n")

    await expectToolInputError(
      applyPatchTool.run(patch("*** Add File: taken.txt", "+clobber"), makeContext(cwd)),
      /cannot add taken\.txt: the file already exists/,
    )
    expect(await readFile(join(cwd, "taken.txt"), "utf8")).toBe("original\n")
  })
})

describe("apply_patch update", () => {
  test("applies a single exact-match hunk", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "code.ts"), "alpha\nbeta\ngamma\n")

    const outcome = await applyPatchTool.run(
      patch("*** Update File: code.ts", "@@", " alpha", "-beta", "+BETA", " gamma"),
      makeContext(cwd),
    )

    expect(await readFile(join(cwd, "code.ts"), "utf8")).toBe("alpha\nBETA\ngamma\n")
    expect(outcome.text).toContain("Updated code.ts")
    expect(outcome.text).not.toContain("normalizing whitespace")
    expect(outcome.label).toBe("code.ts")
    expect(outcome.mutatedPaths).toEqual([resolve(cwd, "code.ts")])
  })

  test("applies multiple hunks in order", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "nums.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n")

    await applyPatchTool.run(
      patch("*** Update File: nums.txt", "@@", " one", "-two", "+TWO", "@@", " four", "-five", "+FIVE"),
      makeContext(cwd),
    )

    expect(await readFile(join(cwd, "nums.txt"), "utf8")).toBe("one\nTWO\nthree\nfour\nFIVE\nsix\n")
  })

  test("anchors a hunk with an @@ context header", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(
      join(cwd, "fn.ts"),
      "function first() {\n  value = 1\n}\nfunction second() {\n  value = 1\n}\n",
    )

    await applyPatchTool.run(
      patch("*** Update File: fn.ts", "@@ function second() {", "-  value = 1", "+  value = 2"),
      makeContext(cwd),
    )

    expect(await readFile(join(cwd, "fn.ts"), "utf8")).toBe(
      "function first() {\n  value = 1\n}\nfunction second() {\n  value = 2\n}\n",
    )
  })

  test("ignores unified-diff numeric @@ headers", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "uni.txt"), "alpha\nbeta\n")

    await applyPatchTool.run(
      patch("*** Update File: uni.txt", "@@ -1,2 +1,2 @@", " alpha", "-beta", "+BETA"),
      makeContext(cwd),
    )

    expect(await readFile(join(cwd, "uni.txt"), "utf8")).toBe("alpha\nBETA\n")
  })

  test("falls back to whitespace-normalized matching", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "loose.ts"), "\tif (ready)  {\n\t\tstart()\n\t}\n")

    const outcome = await applyPatchTool.run(
      patch("*** Update File: loose.ts", "@@", "-if (ready) {", "+if (done) {"),
      makeContext(cwd),
    )

    expect(outcome.text).toContain("(matched after normalizing whitespace)")
    expect(await readFile(join(cwd, "loose.ts"), "utf8")).toBe("if (done) {\n\t\tstart()\n\t}\n")
  })

  test("names the file and first non-matching line on a context mismatch", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "target.txt"), "alpha\nXXX\ngamma\n")

    const error = await expectToolInputError(
      applyPatchTool.run(
        patch("*** Update File: target.txt", "@@", " alpha", "-beta", "+BETA"),
        makeContext(cwd),
      ),
      /hunk #1 does not apply to target\.txt/,
    )
    expect(error.message).toContain('first non-matching line: "beta"')
    expect(await readFile(join(cwd, "target.txt"), "utf8")).toBe("alpha\nXXX\ngamma\n")
  })

  test("errors when an @@ context anchor is not found", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "anchor.ts"), "function real() {\n  work()\n}\n")

    const error = await expectToolInputError(
      applyPatchTool.run(
        patch("*** Update File: anchor.ts", "@@ function imaginary() {", "-  work()", "+  play()"),
        makeContext(cwd),
      ),
      /does not apply to anchor\.ts/,
    )
    expect(error.message).toContain('the @@ context line was not found: "function imaginary() {"')
    expect(await readFile(join(cwd, "anchor.ts"), "utf8")).toBe("function real() {\n  work()\n}\n")
  })

  test("errors when the file does not exist", async () => {
    const cwd = await temporaryDirectory()
    await expectToolInputError(
      applyPatchTool.run(patch("*** Update File: gone.txt", "@@", "-a", "+b"), makeContext(cwd)),
      /cannot update gone\.txt: the file does not exist/,
    )
  })

  test("errors when the path is a directory", async () => {
    const cwd = await temporaryDirectory()
    await mkdir(join(cwd, "a-dir"))
    await expectToolInputError(
      applyPatchTool.run(patch("*** Update File: a-dir", "@@", "-a", "+b"), makeContext(cwd)),
      /a-dir is a directory, not a file/,
    )
  })

  test("appends at the end of the file with the End of File marker", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "tail.txt"), "first\nlast\n")

    await applyPatchTool.run(
      patch("*** Update File: tail.txt", "@@", " last", "+appended", "*** End of File"),
      makeContext(cwd),
    )

    expect(await readFile(join(cwd, "tail.txt"), "utf8")).toBe("first\nlast\nappended\n")
  })

  test("preserves a missing trailing newline", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "no-eol.txt"), "a\nb")

    await applyPatchTool.run(patch("*** Update File: no-eol.txt", "@@", " a", "-b", "+c"), makeContext(cwd))

    expect(await readFile(join(cwd, "no-eol.txt"), "utf8")).toBe("a\nc")
  })
})

describe("apply_patch delete", () => {
  test("deletes an existing file", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "doomed.txt"), "bye\n")

    const outcome = await applyPatchTool.run(patch("*** Delete File: doomed.txt"), makeContext(cwd))

    await expect(stat(join(cwd, "doomed.txt"))).rejects.toThrow()
    expect(outcome.text).toContain("Deleted doomed.txt")
    expect(outcome.label).toBe("doomed.txt")
    expect(outcome.mutatedPaths).toEqual([resolve(cwd, "doomed.txt")])
  })

  test("errors when the file does not exist", async () => {
    const cwd = await temporaryDirectory()
    await expectToolInputError(
      applyPatchTool.run(patch("*** Delete File: missing.txt"), makeContext(cwd)),
      /cannot delete missing\.txt: the file does not exist/,
    )
  })
})

describe("apply_patch move", () => {
  test("moves a file while applying hunks", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "old.txt"), "keep\nchange\n")

    const outcome = await applyPatchTool.run(
      patch("*** Update File: old.txt", "*** Move to: dir/new.txt", "@@", " keep", "-change", "+changed"),
      makeContext(cwd),
    )

    await expect(stat(join(cwd, "old.txt"))).rejects.toThrow()
    expect(await readFile(join(cwd, "dir/new.txt"), "utf8")).toBe("keep\nchanged\n")
    expect(outcome.text).toContain("Updated old.txt -> dir/new.txt (moved)")
    expect(outcome.label).toBe("old.txt -> dir/new.txt")
    expect(outcome.mutatedPaths).toEqual([resolve(cwd, "old.txt"), resolve(cwd, "dir/new.txt")])
  })

  test("supports a pure rename with no hunks", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "from.txt"), "unchanged\n")

    await applyPatchTool.run(patch("*** Update File: from.txt", "*** Move to: to.txt"), makeContext(cwd))

    await expect(stat(join(cwd, "from.txt"))).rejects.toThrow()
    expect(await readFile(join(cwd, "to.txt"), "utf8")).toBe("unchanged\n")
  })

  test("refuses to move onto an existing file, leaving both files untouched", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "a.txt"), "from a\n")
    await writeFile(join(cwd, "b.txt"), "precious\n")

    await expectToolInputError(
      applyPatchTool.run(patch("*** Update File: a.txt", "*** Move to: b.txt"), makeContext(cwd)),
      /cannot move a\.txt to b\.txt: the target file already exists/,
    )
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("from a\n")
    expect(await readFile(join(cwd, "b.txt"), "utf8")).toBe("precious\n")
  })

  test("allows a move onto a path deleted earlier in the same patch", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "old-name.txt"), "kept\n")
    await writeFile(join(cwd, "target.txt"), "obsolete\n")

    await applyPatchTool.run(
      patch("*** Delete File: target.txt", "*** Update File: old-name.txt", "*** Move to: target.txt"),
      makeContext(cwd),
    )

    expect(await readFile(join(cwd, "target.txt"), "utf8")).toBe("kept\n")
    await expect(stat(join(cwd, "old-name.txt"))).rejects.toThrow()
  })
})

describe("apply_patch duplicate-path operations", () => {
  test("a second update to the same file sees the first update's result", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "chain.ts"), "start\nkeep\n")

    // The second hunk only applies to the staged result of the first, never the on-disk content.
    const outcome = await applyPatchTool.run(
      patch(
        "*** Update File: chain.ts",
        "@@",
        "-start",
        "+middle",
        "*** Update File: chain.ts",
        "@@",
        "-middle",
        "+end",
      ),
      makeContext(cwd),
    )

    expect(await readFile(join(cwd, "chain.ts"), "utf8")).toBe("end\nkeep\n")
    expect(outcome.mutatedPaths).toEqual([resolve(cwd, "chain.ts")])
  })

  test("two independent updates to the same file both land", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "same.ts"), "one\ntwo\nthree\n")

    await applyPatchTool.run(
      patch(
        "*** Update File: same.ts",
        "@@",
        "-one",
        "+ONE",
        "*** Update File: same.ts",
        "@@",
        "-three",
        "+THREE",
      ),
      makeContext(cwd),
    )

    expect(await readFile(join(cwd, "same.ts"), "utf8")).toBe("ONE\ntwo\nTHREE\n")
  })

  test("delete then add of the same path rewrites the file", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "rewrite.txt"), "old content\n")

    const outcome = await applyPatchTool.run(
      patch("*** Delete File: rewrite.txt", "*** Add File: rewrite.txt", "+brand new"),
      makeContext(cwd),
    )

    expect(await readFile(join(cwd, "rewrite.txt"), "utf8")).toBe("brand new\n")
    expect(outcome.text).toContain("Deleted rewrite.txt")
    expect(outcome.text).toContain("Added rewrite.txt")
  })

  test("an update after a delete of the same path fails and mutates nothing", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "gone.txt"), "content\n")

    await expectToolInputError(
      applyPatchTool.run(
        patch("*** Delete File: gone.txt", "*** Update File: gone.txt", "@@", "-content", "+changed"),
        makeContext(cwd),
      ),
      /cannot update gone\.txt: the file does not exist/,
    )
    expect(await readFile(join(cwd, "gone.txt"), "utf8")).toBe("content\n")
  })
})

describe("apply_patch CRLF files", () => {
  test("preserves CRLF line endings across the whole patched file", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "win.txt"), "alpha\r\nbeta\r\ngamma\r\n")

    const outcome = await applyPatchTool.run(
      patch("*** Update File: win.txt", "@@", " alpha", "-beta", "+BETA", " gamma"),
      makeContext(cwd),
    )

    expect(await readFile(join(cwd, "win.txt"), "utf8")).toBe("alpha\r\nBETA\r\ngamma\r\n")
    // The match is exact once '\r' is stripped, not the whitespace-normalized fallback.
    expect(outcome.text).not.toContain("normalizing whitespace")
  })

  test("preserves a missing final CRLF newline", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "tailless.txt"), "a\r\nb")

    await applyPatchTool.run(patch("*** Update File: tailless.txt", "@@", " a", "-b", "+c"), makeContext(cwd))

    expect(await readFile(join(cwd, "tailless.txt"), "utf8")).toBe("a\r\nc")
  })
})

describe("apply_patch mixed multi-file patch", () => {
  test("applies add, update, move, and delete in one envelope", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "up.txt"), "a\nb\n")
    await writeFile(join(cwd, "gone.txt"), "x\n")
    await writeFile(join(cwd, "mv.txt"), "stay\n")

    const outcome = await applyPatchTool.run(
      patch(
        "*** Add File: fresh.txt",
        "+hello",
        "*** Update File: up.txt",
        "@@",
        " a",
        "-b",
        "+B",
        "*** Update File: mv.txt",
        "*** Move to: moved.txt",
        "*** Delete File: gone.txt",
      ),
      makeContext(cwd),
    )

    expect(await readFile(join(cwd, "fresh.txt"), "utf8")).toBe("hello\n")
    expect(await readFile(join(cwd, "up.txt"), "utf8")).toBe("a\nB\n")
    expect(await readFile(join(cwd, "moved.txt"), "utf8")).toBe("stay\n")
    await expect(stat(join(cwd, "mv.txt"))).rejects.toThrow()
    await expect(stat(join(cwd, "gone.txt"))).rejects.toThrow()
    expect(outcome.text).toContain("Applied patch to 4 files")
    expect(outcome.label).toBe("4 files")
    expect(outcome.mutatedPaths).toEqual([
      resolve(cwd, "fresh.txt"),
      resolve(cwd, "up.txt"),
      resolve(cwd, "mv.txt"),
      resolve(cwd, "moved.txt"),
      resolve(cwd, "gone.txt"),
    ])
  })

  test("mutates nothing when a later hunk fails to apply", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "bad.txt"), "actual\n")

    await expectToolInputError(
      applyPatchTool.run(
        patch("*** Add File: ok.txt", "+content", "*** Update File: bad.txt", "@@", "-expected", "+other"),
        makeContext(cwd),
      ),
      /does not apply to bad\.txt/,
    )
    await expect(stat(join(cwd, "ok.txt"))).rejects.toThrow()
    expect(await readFile(join(cwd, "bad.txt"), "utf8")).toBe("actual\n")
  })
})

describe("apply_patch permission policy", () => {
  test("is not read-only", () => {
    expect(applyPatchTool.name).toBe("apply_patch")
    expect(applyPatchTool.isReadOnly({ input: "*** Begin Patch\n*** End Patch" })).toBe(false)
  })

  test("refuses to run under a read-only sandbox", async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, "locked.txt"), "original\n")

    const error = await expectToolInputError(
      applyPatchTool.run(
        patch("*** Update File: locked.txt", "@@", "-original", "+changed"),
        makeContext(cwd, { sandbox: "read-only" }),
      ),
      /read-only.*refusing/,
    )
    expect(error.message).toContain("locked.txt")
    expect(await readFile(join(cwd, "locked.txt"), "utf8")).toBe("original\n")
  })

  test("no approval prompt under a read-only sandbox (run refuses instead)", async () => {
    const cwd = await temporaryDirectory()
    expect(
      applyPatchTool.permission(
        patch("*** Add File: any.txt", "+x"),
        makeContext(cwd, { sandbox: "read-only" }),
      ),
    ).toEqual({ kind: "none" })
  })

  test("no approval inside cwd under workspace-write + on-request", async () => {
    const cwd = await temporaryDirectory()
    expect(
      applyPatchTool.permission(
        patch("*** Add File: inside.txt", "+x", "*** Delete File: sub/other.txt"),
        makeContext(cwd),
      ),
    ).toEqual({ kind: "none" })
  })

  test("approval listing every touched path when any path is outside cwd", async () => {
    const cwd = await temporaryDirectory()

    const permission = applyPatchTool.permission(
      patch("*** Add File: inside.txt", "+x", "*** Add File: ../escape.txt", "+y"),
      makeContext(cwd),
    )

    expect(permission).toEqual({
      kind: "approval",
      title: "Apply file changes?",
      detail: `${resolve(cwd, "inside.txt")}\n${resolve(cwd, "../escape.txt")}`,
    })
  })

  test("a move target outside cwd requires approval and appears in the detail", async () => {
    const cwd = await temporaryDirectory()

    const permission = applyPatchTool.permission(
      patch("*** Update File: inside.txt", "*** Move to: ../taken-away.txt"),
      makeContext(cwd),
    )

    expect(permission).toEqual({
      kind: "approval",
      title: "Apply file changes?",
      detail: `${resolve(cwd, "inside.txt")}\n${resolve(cwd, "../taken-away.txt")}`,
    })
  })

  test("approval when a workspace symlink escapes cwd under on-request", async () => {
    const cwd = await temporaryDirectory()
    const outside = await temporaryDirectory()
    await symlink(outside, join(cwd, "deps"))

    expect(
      applyPatchTool.permission(patch("*** Add File: deps/config.json", "+{}"), makeContext(cwd)),
    ).toEqual({
      kind: "approval",
      title: "Apply file changes?",
      detail: join(cwd, "deps", "config.json"),
    })
  })

  test("approval even inside cwd under workspace-write + untrusted", async () => {
    const cwd = await temporaryDirectory()
    expect(
      applyPatchTool.permission(
        patch("*** Add File: inside.txt", "+x"),
        makeContext(cwd, { approvalPolicy: "untrusted" }),
      ),
    ).toEqual({
      kind: "approval",
      title: "Apply file changes?",
      detail: resolve(cwd, "inside.txt"),
    })
  })

  test("no approval anywhere under danger-full-access", async () => {
    const cwd = await temporaryDirectory()
    expect(
      applyPatchTool.permission(
        patch("*** Add File: ../outside.txt", "+x"),
        makeContext(cwd, { sandbox: "danger-full-access" }),
      ),
    ).toEqual({ kind: "none" })
  })

  test("unparseable input yields no approval (run reports the input error)", async () => {
    const cwd = await temporaryDirectory()
    expect(applyPatchTool.permission({}, makeContext(cwd))).toEqual({ kind: "none" })
    expect(applyPatchTool.permission(null, makeContext(cwd))).toEqual({ kind: "none" })
    expect(applyPatchTool.permission({ input: "not a patch" }, makeContext(cwd))).toEqual({ kind: "none" })
    expect(applyPatchTool.permission({ input: "*** Begin Patch\n*** End Patch" }, makeContext(cwd))).toEqual({
      kind: "none",
    })
  })
})
