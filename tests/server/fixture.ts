import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { create } from "../../src/sdk/runtime.ts"
export async function fixture(approval = false) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "m9-server-")))
  let calls = 0
  const options = {
    root: join(cwd, "daemon"),
    onError: (e: unknown) => console.error(e),
    workspaces: [cwd],
    createSession: (options: Parameters<typeof create>[0]) =>
      create({
        ...options,
        trustDataDirectory: join(cwd, "trust"),
        config: {
          path: join(cwd, "absent.toml"),
          overrides: ["memory.enabled=false", ...(approval ? ['permissions.ask=["write_file"]'] : [])],
        },
        model: "ext_sdk_local/model",
        providers: [
          {
            name: "local",
            displayName: "Fixture",
            protocol: "openai" as const,
            models: [
              {
                id: "model",
                displayName: "Fixture",
                contextWindow: 32768,
                maxOutputTokens: 100,
                isDefault: true,
                supportsReasoning: false,
              },
            ],
            async *stream(request) {
              calls++
              if (
                approval &&
                !request.messages.some((m) => m.content.some((b) => b.type === "tool_result"))
              ) {
                yield {
                  type: "tool_call" as const,
                  id: "approval-write",
                  name: "write_file",
                  input: { path: "approved.txt", content: "approved by fixture client" },
                }
                yield { type: "done" as const, stopReason: "tool_use" as const }
                return
              }
              yield { type: "text_delta" as const, text: "served" }
              yield { type: "usage" as const, usage: { inputTokens: 4, outputTokens: 1 } }
              yield { type: "done" as const, stopReason: "end_turn" as const }
            },
          },
        ],
      }),
  }
  return { cwd, options, calls: () => calls, clean: () => rm(cwd, { recursive: true, force: true }) }
}
