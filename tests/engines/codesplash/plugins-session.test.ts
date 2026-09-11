import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runPluginCommand } from "../../../src/commands/plugin.ts"
import { loadConfig } from "../../../src/core/config.ts"
import type { EngineSession } from "../../../src/core/engine.ts"
import type { ProviderRequest } from "../../../src/engines/codesplash/contracts.ts"
import { CodesplashDriver } from "../../../src/engines/codesplash/engine.ts"
import { extensionToolId } from "../../../src/engines/codesplash/extensions/runtime.ts"
import { reviewExtension, trustExtension } from "../../../src/engines/codesplash/extensions/trust.ts"
import { reviewHook, trustHook } from "../../../src/engines/codesplash/hooks/trust.ts"
import { recordMcpTrust, reviewMcpServer } from "../../../src/engines/codesplash/mcp/trust.ts"
import { pluginComponentId } from "../../../src/engines/codesplash/plugins/resolve.ts"

test("native plugin reload stages trust, preserves old commands on failure and refreshes guarded resources/tools", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "plugin-session-"))),
    source = join(root, "source"),
    cfg = join(root, "config"),
    data = join(root, "data")
  const env = { CODESPLASH_AGENT_CONFIG_DIR: cfg, CODESPLASH_AGENT_DATA_DIR: data },
    id = pluginComponentId("fixture", "extension", "main")
  let failCatalog = false
  const hooks: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const value = (await request.json()) as { id?: string | number; method?: string; name?: string }
      if (new URL(request.url).pathname === "/hook") {
        hooks.push(value.name ?? "unknown")
        return Response.json({ version: 1 })
      }
      if (value.method === "notifications/initialized") return new Response(null, { status: 202 })
      if (value.method === "initialize")
        return Response.json({
          jsonrpc: "2.0",
          id: value.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          },
        })
      if (value.method === "tools/list")
        return failCatalog
          ? new Response("fixture failure", { status: 500 })
          : Response.json({ jsonrpc: "2.0", id: value.id, result: { tools: [] } })
      return new Response(null, { status: 405 })
    },
  })
  let session: EngineSession | undefined, drain: Promise<void> | undefined
  try {
    await mkdir(source)
    await mkdir(cfg)
    await mkdir(join(source, "commands"))
    await writeFile(
      join(cfg, "config.toml"),
      `[providers.fixture]\nprotocol="anthropic"\nbaseUrl="http://127.0.0.1:1"\nrequiresKey=false\n[[providers.fixture.models]]\nid="local"\ncontextWindow=32768\nmaxOutputTokens=1024\nisDefault=true\n`,
    )
    const update = async (version: string, extra = "") => {
      await writeFile(
        join(source, "codesplash-plugin.json"),
        JSON.stringify({
          schemaVersion: 1,
          api: 1,
          id: "fixture",
          version,
          commands: ["commands/hello.md"],
          extensions: { main: { entry: "entry.ts" } },
          hooks: {
            observe: {
              kind: "http",
              url: `${server.url.origin}/hook`,
              allowLoopback: true,
              events: ["session.start", "config.before", "config.after"],
            },
          },
          mcp: {
            remote: {
              transport: "http",
              url: `${server.url.origin}/mcp`,
              allowLoopback: true,
              initializeTimeoutMs: 1000,
            },
          },
        }),
      )
      await writeFile(join(source, "commands/hello.md"), `PLUGIN_RESOURCE_${version} $ARGUMENTS`)
      await writeFile(
        join(source, "entry.ts"),
        `export default async api => { ${extra}
        api.registerCommand({name:'hello',description:'Version',run:()=>${JSON.stringify(version)}});
        api.registerTool({name:'read',description:'Plugin read ${version}',readOnly:true,effects:'external',inputSchema:{type:'object',properties:{},additionalProperties:false},async run(){return {text:${JSON.stringify(version)},label:'Plugin'}}});
      }`,
      )
    }
    const command = (args: string[]) => runPluginCommand(args, { cwd: root, env, output: () => {} })
    const load = () => loadConfig(join(cfg, "config.toml"), [], { cwd: root, env })
    const trust = async () => {
      const config = await load(),
        review = await reviewExtension(config, id, root)
      trustExtension(data, review, review.fingerprint)
      const hookReview = await reviewHook(config, pluginComponentId("fixture", "hook", "observe"), root)
      trustHook(data, hookReview, hookReview.fingerprint)
      const mcpReview = await reviewMcpServer(config, pluginComponentId("fixture", "mcp", "remote"), root)
      recordMcpTrust(data, mcpReview, mcpReview.fingerprint)
      return config
    }
    await update("1.0.0")
    await command(["install", source])
    await command(["enable", "fixture"])
    const config = await trust(),
      requests: ProviderRequest[] = []
    const driver = new CodesplashDriver({
      config,
      providers: {
        fixture: {
          id: "anthropic",
          models: [],
          async *stream(request) {
            requests.push(request)
            await Bun.sleep(40)
            if (
              !request.messages.some((message) =>
                message.content.some((block) => block.type === "tool_result"),
              )
            ) {
              yield { type: "tool_call", id: "plugin-read", name: extensionToolId(id, "read"), input: {} }
              yield { type: "done", stopReason: "tool_use" }
              return
            }
            yield { type: "text_delta", text: "fixture done" }
            yield { type: "done", stopReason: "end_turn" }
          },
        },
      },
    })
    session = await driver.openSession({
      cwd: root,
      localSessionId: "plugin-session",
      model: "local",
      trustDataDirectory: data,
      permissionOverrides: { allow: ["read_file(*)"] },
    })
    let completed!: () => void
    const turn = new Promise<void>((done) => {
      completed = done
    })
    drain = (async () => {
      for await (const event of session!.events) {
        if (event.kind === "request.opened") {
          try {
            await expect(session!.pluginsCommand!("reload")).rejects.toThrow("Wait")
          } finally {
            await session!.resolveRequest(event.payload.id, { choice: "accept" })
          }
        }
        if (event.kind === "turn.completed") completed()
      }
    })()
    expect(await session.extensionsCommand?.(`run ${id}/hello`)).toEqual({ result: "1.0.0" })
    expect(JSON.stringify(await session.contextResources?.("command"))).toContain('"source":"plugin"')
    await update("1.0.1")
    await command(["update", "fixture"])
    await command(["enable", "fixture"])
    await expect(session.pluginsCommand?.("reload")).rejects.toThrow("trust")
    expect(await session.extensionsCommand?.(`run ${id}/hello`)).toEqual({ result: "1.0.0" })
    await trust()
    failCatalog = true
    await expect(session.pluginsCommand?.("reload")).rejects.toThrow()
    expect(await session.extensionsCommand?.(`run ${id}/hello`)).toEqual({ result: "1.0.0" })
    failCatalog = false
    await session.pluginsCommand?.("reload")
    expect(hooks.filter((name) => name === "session.start")).toHaveLength(1)
    expect(hooks).toContain("config.after")
    expect(await session.extensionsCommand?.(`run ${id}/hello`)).toEqual({ result: "1.0.1" })
    await session.extensionsCommand?.("reload")
    await session.send({ text: "/hello world" })
    await expect(session.pluginsCommand!("reload")).rejects.toThrow("Wait")
    await turn
    expect(requests.length).toBeGreaterThan(0)
    expect(JSON.stringify(requests)).toContain("PLUGIN_RESOURCE_1.0.1 world")
    expect(
      requests.at(-1)?.tools.find((tool) => tool.name === extensionToolId(id, "read"))?.description,
    ).toContain("1.0.1")
    // A staging factory yields; close must cancel publication and drain its admission operation.
    await update(
      "1.0.2",
      "await Bun.write(api.cwd+'/staging-started','yes'); await new Promise(resolve=>setTimeout(resolve,100));",
    )
    await command(["update", "fixture"])
    await command(["enable", "fixture"])
    await trust()
    const reload = session.pluginsCommand!("reload")
    const rejected = reload.then(
      () => undefined,
      (error) => error,
    )
    for (let i = 0; i < 100 && !(await Bun.file(join(root, "staging-started")).exists()); i++)
      await Bun.sleep(5)
    expect(await Bun.file(join(root, "staging-started")).exists()).toBe(true)
    await session.submit?.({ text: "QUEUED_DURING_STAGING" })
    expect(JSON.stringify(requests)).not.toContain("QUEUED_DURING_STAGING")
    await session.close()
    expect(await rejected).toBeInstanceOf(Error)
    await drain
    session = undefined
  } finally {
    await session?.close()
    await drain
    await server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 15000)
