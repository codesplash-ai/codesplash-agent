import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { extensionToolId } from "codesplash-agent"
import { assert, fixture, join, localProvider } from "./fixture.ts"

// Literal argv, fixed cwd, two-second deadline, bounded output, owned cancellation; no shell.
async function git(cwd: string, args: string[], parent = AbortSignal.timeout(2000)): Promise<string> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(2000)])
  const child = spawn("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    signal,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  })
  let output = "",
    error = ""
  return new Promise((resolve, reject) => {
    child.on("error", reject)
    child.stdout.on("data", (chunk) => {
      output += chunk.toString()
      if (Buffer.byteLength(output) > 65536) child.kill("SIGKILL")
    })
    child.stderr.on("data", (chunk) => {
      error += chunk.toString()
      if (Buffer.byteLength(error) > 8192) child.kill("SIGKILL")
    })
    child.on("close", (code) =>
      code === 0 ? resolve(output) : reject(new Error(`Git failed (${code}): ${error.slice(0, 8192)}`)),
    )
  })
}
await fixture(async ({ root, open }) => {
  await git(root, ["init", "-q"])
  await writeFile(join(root, "review.txt"), "review me\n")
  const provider = localProvider()
  let stage = 0
  provider.stream = async function* (request) {
    if (stage++ === 0) {
      yield { type: "tool_call", id: "status", name: extensionToolId("git", "status"), input: {} }
      yield { type: "done", stopReason: "tool_use" }
    } else {
      assert.match(JSON.stringify(request.messages), /review.txt/)
      yield { type: "text_delta", text: "Reviewed Git status" }
      yield { type: "done", stopReason: "end_turn" }
    }
  }
  const session = await open({
    providers: [provider],
    respond: async () => ({ choice: "accept" }),
    extensions: [
      {
        id: "git",
        factory(api) {
          api.registerTool({
            name: "status",
            description: "Read bounded Git status in this workspace",
            readOnly: true,
            effects: "workspace",
            inputSchema: { type: "object", additionalProperties: false },
            targets: () => ({ paths: [api.cwd] }),
            async run(_, context) {
              context.progress("Reading Git status")
              return {
                text: await git(
                  context.cwd,
                  ["status", "--porcelain=v1", "--untracked-files=normal"],
                  context.signal,
                ),
                label: "Git status",
              }
            },
          })
        },
      },
    ],
  })
  assert.equal((await session.prompt("Review the working tree")).status, "completed")
})
