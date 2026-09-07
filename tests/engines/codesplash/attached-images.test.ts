import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { digest } from "../../../src/core/session/files.ts"
import { attachmentIdentity } from "../../../src/core/session/input-queue.ts"
import { readAttachedImage } from "../../../src/engines/codesplash/inputs/images.ts"

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
)
test("images retain exact bytes and content hash after their permission gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "m5-images-")),
    path = join(root, "image.png"),
    calls: string[] = []
  try {
    writeFileSync(path, png)
    const result = await readAttachedImage(
      path,
      root,
      async (tool) => {
        calls.push(tool)
        return { type: "tool_result", toolCallId: "image", text: "allowed" }
      },
      new AbortController().signal,
      [{ kind: "image", source: path, ...attachmentIdentity(path) }],
    )
    expect(calls).toEqual(["attachment_access"])
    expect(result.block.base64Data).toBe(png.toString("base64"))
    expect(result.hash).toBe(digest(png))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test("denied and changed images fail before provider use", async () => {
  const root = mkdtempSync(join(tmpdir(), "m5-images-")),
    path = join(root, "image.png")
  try {
    writeFileSync(path, png)
    await expect(
      readAttachedImage(
        path,
        root,
        async () => ({ type: "tool_result", toolCallId: "image", text: "denied by policy", isError: true }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("denied by policy")
    const references = [{ kind: "image" as const, source: path, ...attachmentIdentity(path) }]
    await expect(
      readAttachedImage(
        path,
        root,
        async () => {
          writeFileSync(path, Buffer.concat([png, Buffer.from("changed")]))
          return { type: "tool_result", toolCallId: "image", text: "allowed" }
        },
        new AbortController().signal,
        references,
      ),
    ).rejects.toThrow("changed")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test("inline images reject MIME mismatches and unsupported remote sources", async () => {
  const gate = async () => {
    throw new Error("inline data must not read files")
  }
  const signal = new AbortController().signal
  await expect(
    readAttachedImage(`data:image/jpeg;base64,${png.toString("base64")}`, "/project", gate, signal),
  ).rejects.toThrow("MIME mismatch")
  await expect(
    readAttachedImage("https://example.invalid/image.png", "/project", gate, signal),
  ).rejects.toThrow("local image")
  const result = await readAttachedImage(
    `data:image/png;base64,${png.toString("base64")}`,
    "/project",
    gate,
    signal,
  )
  expect(result.hash).toBe(digest(png))
})
