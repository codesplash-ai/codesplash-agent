import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validateConfig } from "../../../src/core/config.ts"
import type { AgentEvent } from "../../../src/core/events.ts"
import type { ModelInfo, ProviderClient } from "../../../src/engines/codesplash/contracts.ts"
import type { ExtensionUiUpdate } from "../../../src/engines/codesplash/extensions/api.ts"
import { type ExtensionHost, ExtensionRuntime } from "../../../src/engines/codesplash/extensions/runtime.ts"
import {
  extensionTrusted,
  reviewExtension,
  trustExtension,
} from "../../../src/engines/codesplash/extensions/trust.ts"
import { CodesplashEventFactory, CodesplashLoop } from "../../../src/engines/codesplash/loop.ts"
import { createPermissionRuntime } from "../../../src/engines/codesplash/permissions.ts"
import { readFileTool } from "../../../src/engines/codesplash/tools/read.ts"
import { createToolRegistry } from "../../../src/engines/codesplash/tools/registry.ts"

async function fixture(source: string, overrides: string[] = []) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "extensions-test-"))),
    packageRoot = join(root, "package")
  await mkdir(packageRoot)
  await writeFile(join(packageRoot, "entry.ts"), source)
  const config = validateConfig(
    {
      extensions: {
        entries: { fixture: { root: packageRoot, entry: "entry.ts", enabled: true, overrides } },
      },
    },
    "fixture",
  )
  const updates: ExtensionUiUpdate[] = [],
    diagnostics: string[] = []
  const host: ExtensionHost = {
    interactive: () => true,
    ui: (update) => {
      updates.push(update)
      return true
    },
    dialog: async () => ({ action: "decline" }),
    complete: async () => "auxiliary",
    diagnostic: (text) => diagnostics.push(text),
  }
  const runtimes: ExtensionRuntime[] = []
  const runtime = () => {
    const value = new ExtensionRuntime({ config, cwd: root, dataDir: root })
    runtimes.push(value)
    return value
  }
  const trust = async () => {
    const review = await reviewExtension(config, "fixture", root)
    trustExtension(root, review, review.fingerprint)
    return review
  }
  return {
    root,
    packageRoot,
    config,
    updates,
    diagnostics,
    host,
    runtime,
    trust,
    close: async () => {
      await Promise.all(runtimes.map((runtime) => runtime.close()))
      await rm(root, { recursive: true, force: true })
    },
  }
}
const toolSource = `export default (api) => {
  let calls=0;
  api.registerTool({name:'echo', description:'Echo input', readOnly:true, inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},
    async run(input,ctx){ctx.progress('working'); return {label:'Echo',text:input.text+':'+(++calls)}}});
  api.registerCommand({name:'status',description:'Status',async run(){return String(calls)},async complete(){return ['alpha','beta']}});
  api.on('turn.start',()=>api.ui.status('state','Ready'));
}`
test("extension review is inert, enforces trust and isolates module/dependency state", async () => {
  const f = await fixture(`import {next} from './dep.ts'; import nextCjs from 'fixture-package';
    export default api => { api.registerCommand({name:'count',description:'Count',async run(){return next()+':'+nextCjs()}}) }`)
  try {
    await writeFile(join(f.packageRoot, "dep.ts"), "let n=0; export const next=()=>++n")
    await mkdir(join(f.packageRoot, "node_modules/fixture-package"), { recursive: true })
    await writeFile(
      join(f.packageRoot, "node_modules/fixture-package/package.json"),
      '{"name":"fixture-package","main":"index.js"}',
    )
    await writeFile(
      join(f.packageRoot, "node_modules/fixture-package/index.js"),
      "let n=0; module.exports=()=>++n",
    )
    await expect(f.runtime().stage()).rejects.toThrow("fingerprint trust")
    const review = await f.trust()
    expect(extensionTrusted(f.root, review)).toBe(true)
    const first = f.runtime(),
      second = f.runtime()
    await first.stage()
    await second.stage()
    first.activate(f.host)
    second.activate(f.host)
    expect(await first.command("fixture/count", "", AbortSignal.timeout(1000))).toBe("1:1")
    expect(await second.command("fixture/count", "", AbortSignal.timeout(1000))).toBe("1:1")
    await writeFile(join(f.packageRoot, "dep.ts"), "export const next=()=>99")
    await expect(first.command("fixture/count", "", AbortSignal.timeout(1000))).rejects.toThrow(
      "source or policy changed",
    )
    expect(first.status().entries[0]?.state).toBe("quarantined")
    expect(extensionTrusted(f.root, await reviewExtension(f.config, "fixture", f.root))).toBe(false)
  } finally {
    await f.close()
  }
})
test("extension tools validate input, stream progress, observe live events and revoke on close", async () => {
  const f = await fixture(toolSource)
  try {
    await f.trust()
    const runtime = f.runtime()
    await runtime.stage()
    const registry = runtime.registry(createToolRegistry([]))
    runtime.activate(f.host)
    const name = registry.specs()[0]!.name,
      tool = registry.get(name)!,
      progress: string[] = []
    expect(tool.source?.id).toBe("extension:fixture/tool/echo")
    expect(() => tool.isReadOnly({ text: 4 })).toThrow("schema")
    expect(
      await tool.run(
        { text: "hello" },
        {
          cwd: f.root,
          policy: { sandbox: "read-only", approvalPolicy: "on-request" },
          signal: AbortSignal.timeout(2000),
          progress: (text) => progress.push(text),
        },
      ),
    ).toMatchObject({ text: "hello:1" })
    expect(progress).toEqual(["working"])
    await runtime.observe(
      {
        version: 1,
        id: "event",
        sessionId: "session",
        name: "turn.start",
        generation: "gen",
        metadata: {},
        fields: {},
      },
      AbortSignal.timeout(2000),
    )
    expect(f.updates.at(-1)?.text).toBe("Ready")
    expect(await runtime.completeCommand("fixture/status", "", AbortSignal.timeout(2000))).toEqual([
      "alpha",
      "beta",
    ])
    await runtime.close()
    expect(registry.specs()).toEqual([])
    expect(() => tool.isReadOnly({ text: "late" })).toThrow("closed")
    expect(f.updates.at(-1)?.operation).toBe("clear")
  } finally {
    await f.close()
  }
})
test("protected overrides fail before publication and ordinary overrides require exact selection/schema", async () => {
  const f = await fixture(
    `export default api => api.registerTool({name:'read',override:'read_file',description:'Read',inputSchema:${JSON.stringify(readFileTool.inputSchema)},readOnly:true,async run(){return {text:'override',label:'Read'}}})`,
  )
  try {
    await f.trust()
    const first = f.runtime()
    await first.stage()
    expect(() => first.registry(createToolRegistry([readFileTool]))).toThrow("not permitted")
    f.config.extensions!.entries.fixture!.overrides = ["read_file"]
    await f.trust()
    const second = f.runtime()
    await second.stage()
    const registry = second.registry(createToolRegistry([readFileTool]))
    second.activate(f.host)
    expect(registry.get("read_file")?.permissionFloor).toBe(readFileTool)
    expect(registry.source("read_file")?.id).toBe("extension:fixture/tool/read")
    await writeFile(
      join(f.packageRoot, "entry.ts"),
      "export default api => api.registerTool({name:'escape',override:'request_permissions',description:'escape',inputSchema:{type:'object'},async run(){return {text:'',label:''}}})",
    )
    f.config.extensions!.entries.fixture!.overrides = ["request_permissions"]
    await f.trust()
    const third = f.runtime()
    await third.stage()
    expect(() =>
      third.registry(createToolRegistry([{ ...readFileTool, name: "request_permissions" }])),
    ).toThrow("not permitted")
  } finally {
    await f.close()
  }
})
test("extension snapshots reject links and dependencies outside the reviewed root", async () => {
  const f = await fixture("import '../outside.ts'; export default () => {}")
  try {
    await writeFile(join(f.root, "outside.ts"), "export const outside=true")
    await f.trust()
    await expect(f.runtime().stage()).rejects.toThrow()
    await symlink(join(f.root, "outside.ts"), join(f.packageRoot, "linked.ts"))
    await expect(f.trust()).rejects.toThrow("symbolic links")
    const disabled = new ExtensionRuntime({ config: f.config, cwd: f.root, dataDir: f.root, disabled: true })
    await disabled.stage()
    expect(disabled.status().entries).toEqual([])
    await disabled.close()
  } finally {
    await f.close()
  }
})
test("extension provider/auth is scoped, streamed and sanitized; headless UI is explicit", async () => {
  const f = await fixture(`export default api => {
    api.registerProvider({name:'local', displayName:'Local', protocol:'openai', models:[{id:'model',displayName:'Model',contextWindow:4096,maxOutputTokens:512,isDefault:true,supportsReasoning:false}],
      async auth(){return 'fixture-provider-secret'}, async *stream(request,{credential}) {yield {type:'text_delta',text:credential}; yield {type:'usage',usage:{inputTokens:10,outputTokens:2}}; yield {type:'done',stopReason:'end_turn'}}});
    api.registerCommand({name:'ui',description:'UI',async run(){return JSON.stringify(await api.ui.dialog({message:'Continue?',fields:[]}))}})
  }`)
  try {
    await f.trust()
    const runtime = f.runtime()
    await runtime.stage()
    runtime.activate({ ...f.host, interactive: () => false })
    expect(await runtime.command("fixture/ui", "", AbortSignal.timeout(2000))).toBe(
      '{"action":"unsupported"}',
    )
    const provider = runtime.providers()[0]!,
      events = []
    expect(provider.id).toBe("ext_fixture_local")
    expect(provider.client.models[0]?.pricing).toBeUndefined()
    for await (const event of provider.client.stream(
      { model: provider.client.models[0]!, messages: [], tools: [], system: "" },
      AbortSignal.timeout(2000),
    ))
      events.push(event)
    expect(events).toEqual([
      { type: "text_delta", text: "[REDACTED]" },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } },
      { type: "done", stopReason: "end_turn" },
    ])
  } finally {
    await f.close()
  }
})

test("cancelled callbacks cannot publish late UI; owned timers outlive their creating command", async () => {
  const f = await fixture(`export default api => {
    api.registerCommand({name:'late',description:'Late',async run(){await new Promise(resolve=>setTimeout(resolve,80));try{api.ui.status('late','MUST NOT PUBLISH')}catch{};return 'late'}});
    api.registerCommand({name:'timer',description:'Timer',async run(){api.after(60,()=>{api.ui.status('timer','Owned timer')});return 'scheduled'}});
  }`)
  try {
    await f.trust()
    const runtime = f.runtime()
    await runtime.stage()
    runtime.activate(f.host)
    await expect(runtime.command("fixture/late", "", AbortSignal.timeout(10))).rejects.toThrow()
    expect(await runtime.command("fixture/timer", "", AbortSignal.timeout(10))).toBe("scheduled")
    await Bun.sleep(120)
    expect(f.updates.some((update) => update.text === "MUST NOT PUBLISH")).toBe(false)
    expect(f.updates.some((update) => update.text === "Owned timer")).toBe(true)
    expect(runtime.status().entries[0]?.state).toBe("active")
    expect(f.diagnostics).toEqual([])
    await runtime.close()
    expect(f.diagnostics).toEqual([])
  } finally {
    await f.close()
  }
})

test("staged collisions and failed factories leave an existing active registry usable", async () => {
  const f = await fixture(toolSource)
  try {
    await f.trust()
    const current = f.runtime()
    await current.stage()
    current.activate(f.host)
    const registry = current.registry(createToolRegistry([]))
    await writeFile(
      join(f.packageRoot, "entry.ts"),
      "export default () => {throw new Error('broken candidate')}",
    )
    await f.trust()
    await expect(f.runtime().stage()).rejects.toThrow("broken candidate")
    expect(current.status().entries[0]?.state).toBe("active")
    expect(registry.specs()).toHaveLength(1)
    // Source revalidation still refuses changed code; restoring the prior reviewed source
    // demonstrates that failed staging never replaced or destroyed the prior registry.
    await writeFile(join(f.packageRoot, "entry.ts"), toolSource)
    await f.trust()
    expect(await current.command("fixture/status", "", AbortSignal.timeout(1000))).toBe("0")
    expect(registry.specs()[0]?.name).toBeDefined()
  } finally {
    await f.close()
  }
})

test("an explicit extension allow cannot bypass the overridden built-in's deny rule", async () => {
  const f = await fixture(
    `export default api => api.registerTool({name:'read',override:'read_file',description:'Read',inputSchema:${JSON.stringify(readFileTool.inputSchema)},readOnly:true,async run(){return {text:'MUST_NOT_RUN',label:'Read'}}})`,
    ["read_file"],
  )
  try {
    await f.trust()
    const runtime = f.runtime()
    await runtime.stage()
    runtime.activate(f.host)
    const registry = runtime.registry(createToolRegistry([readFileTool])),
      name = registry.get("read_file")!.permissionName!
    const permissions = await createPermissionRuntime({
      cwd: f.root,
      mode: "default",
      workspaceTrusted: true,
      configRules: { allow: [name], ask: [], deny: ["read_file"] },
    })
    const events: AgentEvent[] = []
    const loop = new CodesplashLoop({
      cwd: f.root,
      policy: { sandbox: "workspace-write", approvalPolicy: "on-request" },
      registry,
      permissions,
      extensionsEnabled: () => runtime.enabled,
      events: new CodesplashEventFactory("extension-deny"),
      emit: (event) => events.push(event),
    })
    const model: ModelInfo = {
      id: "fixture",
      displayName: "Fixture",
      provider: "openai",
      protocol: "openai",
      isDefault: true,
      contextWindow: 32768,
      maxOutputTokens: 1024,
      supportsReasoning: false,
    }
    let count = 0
    const provider: ProviderClient = {
      id: "openai",
      models: [model],
      async *stream() {
        if (++count === 1) {
          yield { type: "tool_call", id: "read", name: "read_file", input: { path: "fixture.txt" } }
          yield { type: "done", stopReason: "tool_use" }
        } else {
          yield { type: "text_delta", text: "Finished" }
          yield { type: "done", stopReason: "end_turn" }
        }
      },
    }
    await loop.runTurn({
      provider,
      model,
      system: "Fixture",
      userText: "Read",
      userContent: [{ type: "text", text: "Read" }],
    })
    expect(
      events.some(
        (event) =>
          event.kind === "item.updated" && event.payload.output?.includes("Denied by permission rule"),
      ),
    ).toBe(true)
    expect(JSON.stringify(loop.historySnapshot())).not.toContain("MUST_NOT_RUN")
    expect(events.some((event) => event.kind === "request.opened")).toBe(false)
  } finally {
    await f.close()
  }
})

test("closing an idle provider stream drains its finalizer before removing snapshot assets", async () => {
  const f =
    await fixture(`export default api => api.registerProvider({name:'local',displayName:'Local',protocol:'openai',models:[{id:'model',displayName:'Model',contextWindow:4096,maxOutputTokens:512,isDefault:true,supportsReasoning:false}],
    async *stream(){try{yield {type:'text_delta',text:'first'};yield {type:'done',stopReason:'end_turn'}}finally{await new Promise(resolve=>setTimeout(resolve,40));await Bun.write(api.cwd+'/cleanup.txt',await Bun.file(import.meta.dir+'/asset.txt').text())}}})`)
  try {
    await writeFile(join(f.packageRoot, "asset.txt"), "ASSET_STILL_OWNED")
    await f.trust()
    const runtime = f.runtime()
    await runtime.stage()
    runtime.activate(f.host)
    const provider = runtime.providers()[0]!,
      iterator = provider.client
        .stream(
          { model: provider.client.models[0]!, system: "", tools: [], messages: [] },
          AbortSignal.timeout(2000),
        )
        [Symbol.asyncIterator]()
    expect((await iterator.next()).value).toEqual({ type: "text_delta", text: "first" })
    await runtime.close()
    expect(await Bun.file(join(f.root, "cleanup.txt")).text()).toBe("ASSET_STILL_OWNED")
    await iterator.return?.()
  } finally {
    await f.close()
  }
})
