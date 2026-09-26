import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { quote } from "shell-quote"
import { editDraft, editorArgv } from "../../src/tui/editor.ts"

test("editor argv honors VISUAL, quoting and refuses shell operators", () => {
  expect(editorArgv({ VISUAL: '"/a path/editor" --wait', EDITOR: "ignored" })).toEqual([
    "/a path/editor",
    "--wait",
  ])
  expect(() => editorArgv({ EDITOR: "vi; echo stolen" })).toThrow("shell operators")
})

test("real editor child preserves Unicode, restores renderer, removes private files on success/failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "m8-editor-test-")),
    script = join(dir, "editor.ts"),
    receipt = join(dir, "receipt")
  const calls: string[] = []
  const renderer = {
    suspend: () => {
      calls.push("suspend")
    },
    resume: () => {
      calls.push("resume")
    },
  }
  try {
    await writeFile(
      script,
      `import {readFileSync,writeFileSync,statSync} from 'node:fs'; const p=process.argv.at(-1); writeFileSync(process.env.RECEIPT,JSON.stringify({p,mode:statSync(p).mode&511})); writeFileSync(p,readFileSync(p,'utf8')+'\\n日本語'); process.exit(Number(process.env.EXIT||0));`,
    )
    const env = { ...process.env, VISUAL: quote([process.execPath, script]), RECEIPT: receipt }
    expect(await editDraft({ text: "original", cwd: dir, renderer, env })).toBe("original\n日本語")
    const info = JSON.parse(await readFile(receipt, "utf8"))
    expect(info.mode).toBe(0o600)
    expect(await Bun.file(info.p).exists()).toBe(false)
    await expect(
      editDraft({ text: "original", cwd: dir, renderer, env: { ...env, EXIT: "1" } }),
    ).rejects.toThrow("draft preserved")
    expect(calls).toEqual(["suspend", "resume", "suspend", "resume"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("editor abort settles the child without reviving a closed renderer", async () => {
  const controller = new AbortController(),
    calls: string[] = []
  const timer = setTimeout(() => controller.abort(), 100)
  try {
    await expect(
      editDraft({
        text: "draft",
        cwd: tmpdir(),
        signal: controller.signal,
        env: { ...process.env, VISUAL: quote([process.execPath, "-e", "setInterval(()=>{},1000)"]) },
        renderer: {
          suspend: () => {
            calls.push("suspend")
          },
          resume: () => {
            calls.push("resume")
          },
        },
      }),
    ).rejects.toThrow()
    expect(calls).toEqual(["suspend"])
  } finally {
    clearTimeout(timer)
  }
})
