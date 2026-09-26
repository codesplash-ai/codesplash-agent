import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestRenderer } from "@opentui/core/testing"
import type { TranscriptItem } from "../../src/core/index.ts"
import { itermImageSequence, showItermImage } from "../../src/tui/images.ts"
import { terminalMarkdown, terminalMath } from "../../src/tui/rich-text.ts"
import { TranscriptScrollback } from "../../src/tui/scrollback.ts"
import { boundedLocalBytes, loadUserTheme } from "../../src/tui/themes.ts"

test("rich text renders diagrams and math while preserving code, unknown syntax and oversized input", () => {
  const diagram = terminalMarkdown("```mermaid\ngraph LR; A[Start] --> B[End]\n```")
  expect(diagram).toContain("Start")
  expect(diagram).toContain("─")
  expect(diagram).not.toContain("graph LR")
  expect(terminalMath("\\frac{a}{b} + \\sqrt{x^2} + \\alpha_1")).toBe("(a)/(b) + √(x²) + α₁")
  expect(terminalMath("\\unknown{x}")).toContain("\\unknown")
  const code = "```js\nconst price = '$x^2';\n```"
  expect(terminalMarkdown(code)).toBe(code)
  expect(terminalMarkdown("Use `$x^2$` literally")).toBe("Use `$x^2$` literally")
  const tooLarge = `\`\`\`mermaid\ngraph TD\n${"A-->B\n".repeat(100)}\`\`\``
  expect(terminalMarkdown(tooLarge)).toBe(tooLarge)
})

test("theme accepts known colors, rejects escape/path injection and symlinks", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "m8-theme-")))
  try {
    await mkdir(join(dir, "themes"))
    await writeFile(
      join(dir, "themes", "ocean.json"),
      JSON.stringify({ extends: "dark", colors: { accent: "#123456" } }),
    )
    expect(loadUserTheme(dir, "ocean").accent).toBe("#123456")
    expect(() => loadUserTheme(dir, "../ocean")).toThrow()
    await writeFile(
      join(dir, "themes", "bad.json"),
      JSON.stringify({ extends: "dark", colors: { accent: "\x1b[31m" } }),
    )
    expect(() => loadUserTheme(dir, "bad")).toThrow()
    await symlink(join(dir, "themes", "ocean.json"), join(dir, "link"))
    expect(() => boundedLocalBytes(join(dir, "link"), 65536)).toThrow()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("actual renderer scrollback deduplicates completed items across mode changes and waits for streaming settlement", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 25,
    screenMode: "split-footer",
    footerHeight: 10,
    externalOutputMode: "capture-stdout",
  })
  const history = new TranscriptScrollback(),
    transcript: TranscriptItem[] = [
      { id: "a", kind: "message", status: "completed", text: "Completed 日本語" },
      { id: "b", kind: "message", status: "running", text: "Partial" },
    ]
  let writes = 0
  const original = setup.renderer.writeToScrollback.bind(setup.renderer)
  setup.renderer.writeToScrollback = (writer) => {
    writes++
    original(writer)
  }
  try {
    history.append(setup.renderer, transcript, "show")
    await setup.flush()
    setup.renderer.externalOutputMode = "passthrough"
    setup.renderer.screenMode = "alternate-screen"
    setup.renderer.screenMode = "split-footer"
    setup.renderer.externalOutputMode = "capture-stdout"
    history.append(setup.renderer, transcript, "show")
    expect(writes).toBe(1)
    transcript[1] = { ...transcript[1]!, status: "completed", text: "Final" }
    history.append(setup.renderer, transcript, "show")
    await setup.flush()
    expect(writes).toBe(2)
  } finally {
    setup.renderer.destroy()
  }
})

test("iTerm protocol encodes filenames/content and restores renderer on write failure", () => {
  const calls: string[] = [],
    data = new Uint8Array([1, 2, 3])
  expect(itermImageSequence("\x1b]malicious", data)).not.toContain("malicious")
  expect(() =>
    showItermImage(
      {
        suspend: () => {
          calls.push("suspend")
        },
        resume: () => {
          calls.push("resume")
        },
      },
      "test",
      data,
      () => {
        throw new Error("closed terminal")
      },
    ),
  ).toThrow()
  expect(calls).toEqual(["suspend", "resume"])
})
