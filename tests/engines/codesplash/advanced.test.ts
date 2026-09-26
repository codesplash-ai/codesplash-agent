import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext } from "../../../src/engines/codesplash/contracts.ts"
import { selectedRegistry, validateLimits } from "../../../src/engines/codesplash/execution.ts"
import {
  anchorEditTool,
  anchorReadTool,
  clockTool,
  codeModeTool,
  notebookTool,
} from "../../../src/engines/codesplash/tools/advanced.ts"
import { readFileTool } from "../../../src/engines/codesplash/tools/read.ts"
import { builtinTools, createToolRegistry } from "../../../src/engines/codesplash/tools/registry.ts"

const digest = (value: string) => createHash("sha256").update(value).digest("hex")
test("notebook edits clear outputs and stale hashes prevent lost external edits", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cs-m10-notebook-")),
    context: ToolContext = {
      cwd,
      policy: { sandbox: "workspace-write", approvalPolicy: "on-request" },
      signal: new AbortController().signal,
    }
  try {
    const original = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      cells: [
        {
          id: "cell",
          cell_type: "code",
          source: ["old"],
          outputs: [{ text: "old" }],
          execution_count: 7,
          metadata: {},
        },
      ],
      metadata: {},
    })
    await writeFile(join(cwd, "n.ipynb"), original)
    await notebookTool.run(
      { path: "n.ipynb", sha256: digest(original), cell_id: "cell", operation: "replace", source: "new" },
      context,
    )
    const current = JSON.parse(await readFile(join(cwd, "n.ipynb"), "utf8"))
    expect(current.cells[0]).toMatchObject({ source: ["new"], outputs: [], execution_count: null })
    await expect(
      notebookTool.run(
        { path: "n.ipynb", sha256: digest(original), cell_id: "cell", operation: "delete" },
        context,
      ),
    ).rejects.toThrow("changed")
    await writeFile(join(cwd, "a.txt"), "one\ntwo\nthree")
    expect((await anchorReadTool.run({ path: "a.txt" }, context)).text).toContain(
      `2:${digest("two").slice(0, 12)}|two`,
    )
    const input = {
      path: "a.txt",
      sha256: digest("one\ntwo\nthree"),
      start: 2,
      end: 2,
      start_hash: digest("two").slice(0, 12),
      end_hash: digest("two").slice(0, 12),
      content: "new",
    }
    await anchorEditTool.run(input, context)
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("one\nnew\nthree")
    await expect(anchorEditTool.run(input, context)).rejects.toThrow("Stale")
    await expect(codeModeTool.run({ code: "return 1" }, context)).rejects.toThrow("OS worker")
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
test("media reads yield image content and bounded PDF page text", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cs-m10-media-")),
    context: ToolContext = {
      cwd,
      policy: { sandbox: "read-only", approvalPolicy: "on-request" },
      signal: new AbortController().signal,
    }
  try {
    await writeFile(
      join(cwd, "a.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      ),
    )
    expect((await readFileTool.run({ path: "a.png" }, context)).images?.[0]?.mediaType).toBe("image/png")
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    const stream = "BT /F1 12 Tf 20 100 Td (Native PDF fixture) Tj ET"
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
    let pdf = "%PDF-1.4\n"
    const offsets = [0]
    for (const [i, obj] of objects.entries()) {
      offsets.push(pdf.length)
      pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`
    }
    const xref = pdf.length
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
      .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
    await writeFile(join(cwd, "a.pdf"), pdf)
    expect((await readFileTool.run({ path: "a.pdf" }, context)).text).toContain("Native PDF fixture")
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
test("tool presets narrow actual dispatch; advanced capabilities require explicit flags", async () => {
  expect(builtinTools().some((t) => t.name === "code_mode")).toBe(false)
  const registry = selectedRegistry(createToolRegistry(builtinTools(true)), { toolset: "read-only" })
  expect(registry.get("write_file")).toBeUndefined()
  expect(registry.get("read_anchors")).toBeDefined()
  expect(() => validateLimits({ features: ["unknown"] })).toThrow()
  const controller = new AbortController(),
    wait = clockTool.run(
      { sleep_ms: 30000 },
      {
        cwd: process.cwd(),
        policy: { sandbox: "read-only", approvalPolicy: "on-request" },
        signal: controller.signal,
      },
    )
  controller.abort()
  await expect(wait).rejects.toThrow()
})
