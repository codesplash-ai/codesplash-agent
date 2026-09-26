import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ExtensionProvider } from "codesplash-agent/extensions"
import { assert, fixture, localProvider } from "./fixture.ts"

await fixture(async ({ root: cwd, open }) => {
  const source = "first\nsecond",
    hash = (value: string) => createHash("sha256").update(value).digest("hex")
  await writeFile(join(cwd, "anchors.txt"), source)
  let calls = 0
  const provider: ExtensionProvider = {
    ...localProvider(""),
    async *stream(request) {
      assert.ok(request.tools.some((tool) => tool.name === "edit_anchors"))
      assert.ok(!request.tools.some((tool) => tool.name === "browser"))
      if (calls++ === 0) {
        yield {
          type: "tool_call",
          id: "edit",
          name: "edit_anchors",
          input: {
            path: "anchors.txt",
            sha256: hash(source),
            start: 2,
            end: 2,
            start_hash: hash("second").slice(0, 12),
            end_hash: hash("second").slice(0, 12),
            content: "updated",
          },
        }
        yield {
          type: "tool_call",
          id: "code",
          name: "code_mode",
          input: { code: 'return (await Bun.file("anchors.txt").text()).includes("updated")' },
        }
        yield { type: "tool_call", id: "search", name: "grep", input: { pattern: "updated" } }
        yield { type: "done", stopReason: "tool_use" }
        return
      }
      const text = JSON.stringify(request.messages)
      assert.ok(text.includes("Anchored edit applied"))
      assert.ok(text.includes("anchors.txt:2:updated"))
      yield { type: "text_delta", text: "ADVANCED_TOOLS_OK" }
      yield { type: "done", stopReason: "end_turn" }
    },
  }
  const session = await open({
    providers: [provider],
    execution: { features: ["anchors", "code"] },
    respond: async () => ({ choice: "accept" }),
  })
  assert.equal((await session.prompt("Exercise explicit advanced tools")).status, "completed")
  assert.equal(await readFile(join(cwd, "anchors.txt"), "utf8"), "first\nupdated")
})
