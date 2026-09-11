/** Compiled native integration probe; no test framework and no repository files at runtime. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runPluginCommand } from "../../src/commands/plugin.ts"
import { configDirectory, configFilePath, loadConfig } from "../../src/core/config.ts"
import { CodesplashDriver } from "../../src/engines/codesplash/engine.ts"
import { reviewExtension, trustExtension } from "../../src/engines/codesplash/extensions/trust.ts"
import { pluginComponentId } from "../../src/engines/codesplash/plugins/resolve.ts"

const role = process.argv[2]
if (role === "--internal-sandbox-supervisor")
  await (await import("../../src/engines/codesplash/sandbox/supervisor.ts")).supervisorMain()
else if (role === "--internal-sandbox-worker")
  await (await import("../../src/engines/codesplash/sandbox/worker.ts")).workerMain()
else if (role === "--internal-sandbox-stream-supervisor")
  await (await import("../../src/engines/codesplash/sandbox/supervisor.ts")).streamSupervisorMain()
else await probe()
async function probe() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "compiled-plugin-reload-"))),
    source = join(root, "source"),
    cfg = join(root, "config"),
    data = join(root, "data")
  process.env.CODESPLASH_AGENT_CONFIG_DIR = cfg
  process.env.CODESPLASH_AGENT_DATA_DIR = data
  const env = process.env,
    id = pluginComponentId("fixture", "extension", "main")
  try {
    await mkdir(source)
    await mkdir(cfg)
    await mkdir(join(source, "commands"))
    await writeFile(
      join(cfg, "config.toml"),
      `[providers.fixture]\nprotocol="anthropic"\nbaseUrl="http://127.0.0.1:1"\nrequiresKey=false\n[[providers.fixture.models]]\nid="local"\ncontextWindow=32768\nmaxOutputTokens=1024\nisDefault=true\n`,
    )
    await writeFile(
      join(source, "codesplash-plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        api: 1,
        id: "fixture",
        version: "1.0.0",
        commands: ["commands/hello.md"],
        extensions: { main: { entry: "entry.ts" } },
      }),
    )
    const update = async (text: string) => {
      await writeFile(join(source, "commands/hello.md"), text)
      await writeFile(
        join(source, "entry.ts"),
        `export default api=>api.registerCommand({name:'hello',description:'Version',run:()=>${JSON.stringify(text)}})`,
      )
    }
    const run = (args: string[]) => runPluginCommand(args, { cwd: root, env, output: () => {} })
    const trust = async () => {
      const config = await loadConfig(configFilePath(configDirectory(env)), [], { cwd: root, env })
      const review = await reviewExtension(config, id, root)
      trustExtension(data, review, review.fingerprint)
      return config
    }
    await update("COMPILED_PLUGIN_ONE")
    await run(["install", source])
    await run(["enable", "fixture"])
    const config = await trust(),
      requests: string[] = []
    const session = await new CodesplashDriver({
      config,
      providers: {
        fixture: {
          id: "anthropic",
          models: [],
          async *stream(request) {
            requests.push(JSON.stringify(request))
            yield { type: "text_delta", text: "done" }
            yield { type: "done", stopReason: "end_turn" }
          },
        },
      },
    }).openSession({
      cwd: root,
      localSessionId: "plugin-probe",
      model: "local",
      trustDataDirectory: data,
      permissionOverrides: { allow: ["read_file(*)"] },
    })
    let done!: () => void
    const completed = new Promise<void>((resolve) => {
      done = resolve
    })
    const drain = (async () => {
      for await (const event of session.events) {
        if (event.kind === "request.opened")
          await session.resolveRequest(event.payload.id, { choice: "accept" })
        if (event.kind === "turn.completed") done()
      }
    })()
    try {
      assert.deepEqual(await session.extensionsCommand?.(`run ${id}/hello`), {
        result: "COMPILED_PLUGIN_ONE",
      })
      await update("COMPILED_PLUGIN_TWO")
      await run(["update", "fixture"])
      await run(["enable", "fixture"])
      await assert.rejects(session.pluginsCommand!("reload"), /trust/)
      assert.deepEqual(await session.extensionsCommand?.(`run ${id}/hello`), {
        result: "COMPILED_PLUGIN_ONE",
      })
      await trust()
      await session.pluginsCommand!("reload")
      assert.deepEqual(await session.extensionsCommand?.(`run ${id}/hello`), {
        result: "COMPILED_PLUGIN_TWO",
      })
      await session.send({ text: "/hello" })
      await completed
      assert.match(requests.join("\n"), /COMPILED_PLUGIN_TWO/)
    } finally {
      await session.close()
      await drain
    }
    console.log(
      "Compiled plugin reload probe passed: install, enable, trust, failed-stage preservation, live registry/resource publication and close",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
