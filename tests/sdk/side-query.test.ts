import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentSession, type ExtensionProvider } from "../../src/sdk/index.ts"

test("native side queries isolate history, prohibit tools, account usage and cancel on foreground input/close", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "m8-side-")))
  await mkdir(join(root, "config"))
  const requests: string[] = []
  let wait = false,
    sideStarted!: () => void
  const provider: ExtensionProvider = {
    name: "local",
    displayName: "Local",
    protocol: "openai",
    models: [
      {
        id: "model",
        displayName: "Local",
        contextWindow: 32768,
        maxOutputTokens: 1024,
        isDefault: true,
        supportsReasoning: false,
      },
    ],
    async *stream(request, { signal }) {
      const encoded = JSON.stringify(request)
      requests.push(encoded)
      if (request.system.includes("separate question")) {
        expect(request.tools).toEqual([])
        expect(request.model.maxOutputTokens).toBe(512)
        if (wait) {
          sideStarted()
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve()
            else signal.addEventListener("abort", () => resolve(), { once: true })
          })
          signal.throwIfAborted()
        }
        yield { type: "text_delta", text: "EPHEMERAL_ANSWER" }
      } else yield { type: "text_delta", text: "MAIN_ANSWER" }
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } }
      yield { type: "done", stopReason: "end_turn" }
    },
  }
  const session = await createAgentSession({
    cwd: root,
    trustDataDirectory: join(root, "data"),
    config: { path: join(root, "config", "config.toml"), overrides: ["memory.enabled=false"] },
    model: "ext_sdk_local/model",
    providers: [provider],
  })
  try {
    await session.prompt("Main question")
    const original = JSON.stringify(session.state.transcript)
    expect(await session.sideQuery({ kind: "question", question: "SIDE_MARKER" })).toBe("EPHEMERAL_ANSWER")
    expect(JSON.stringify(session.state.transcript)).toBe(original)
    expect(session.usage.inputTokens).toBe(20)
    await session.prompt("Continue")
    expect(requests.at(-1)).not.toContain("SIDE_MARKER")
    expect(requests.at(-1)).not.toContain("EPHEMERAL_ANSWER")
    wait = true
    const started = new Promise<void>((resolve) => {
      sideStarted = resolve
    })
    const pending = session.sideQuery({ kind: "question", question: "cancel me" })
    void pending.catch(() => {})
    await started
    await session.prompt("Foreground priority")
    await expect(pending).rejects.toThrow()
    const closedStarted = new Promise<void>((resolve) => {
      sideStarted = resolve
    })
    const closing = session.sideQuery({ kind: "question", question: "close me" })
    void closing.catch(() => {})
    await closedStarted
    await session.close()
    await expect(closing).rejects.toThrow()
  } finally {
    await session.close()
    await rm(root, { recursive: true, force: true })
  }
}, 20000)
