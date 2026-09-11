import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type AgentSession,
  type CreateAgentSessionOptions,
  createAgentSession,
  type ExtensionProvider,
} from "codesplash-agent"

export function localProvider(text = "Local example completed"): ExtensionProvider {
  return {
    name: "local",
    displayName: "Local scripted provider",
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
    async *stream() {
      yield { type: "text_delta", text }
      yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }
      yield { type: "done", stopReason: "end_turn" }
    },
  }
}
export async function fixture(
  run: (context: {
    root: string
    options: CreateAgentSessionOptions
    open: (overrides?: CreateAgentSessionOptions) => Promise<AgentSession>
  }) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codesplash-sdk-example-")))
  const sessions: AgentSession[] = []
  const options: CreateAgentSessionOptions = {
    cwd: root,
    trustDataDirectory: join(root, "data"),
    workspaceTrusted: true,
    config: { path: join(root, "config", "config.toml"), overrides: ["memory.enabled=false"] },
    providers: [localProvider()],
    model: "ext_sdk_local/model",
  }
  try {
    await mkdir(join(root, "config"))
    await run({
      root,
      options,
      async open(overrides = {}) {
        const session = await createAgentSession({ ...options, ...overrides })
        sessions.push(session)
        return session
      },
    })
    console.log("SDK_EXAMPLE_OK")
  } finally {
    await Promise.all(sessions.map((session) => session.close()))
    await rm(root, { recursive: true, force: true })
  }
}
export { assert, join }
