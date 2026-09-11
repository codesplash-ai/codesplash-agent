import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validateConfig } from "../../../src/core/config.ts"
import type { AgentEvent } from "../../../src/core/events.ts"
import { CodesplashDriver } from "../../../src/engines/codesplash/engine.ts"
import { extensionToolId } from "../../../src/engines/codesplash/extensions/runtime.ts"
import { reviewExtension, trustExtension } from "../../../src/engines/codesplash/extensions/trust.ts"

test("native extension provider/tool shares permissions, progress, lifecycle, dialogs and usage", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "extension-session-"))),
    packageRoot = join(root, "package")
  await mkdir(packageRoot)
  const name = extensionToolId("fixture", "write")
  await writeFile(
    join(packageRoot, "entry.ts"),
    `export default api => {
    api.registerTool({name:'write',description:'Write fixture',effects:'workspace',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},
      targets:()=>({paths:[api.cwd+'/result.txt']}),async run(input,ctx){ctx.progress('extension progress');await Bun.write(api.cwd+'/result.txt',input.text);return {text:'written',label:'Extension write',mutatedPaths:[api.cwd+'/result.txt']}}});
    api.registerProvider({name:'local',displayName:'Fixture',protocol:'openai',models:[{id:'model',displayName:'Fixture',contextWindow:32768,maxOutputTokens:1024,isDefault:true,supportsReasoning:false}],
      async auth(){return 'extension-auth-fixture-secret'},async *stream(request,{credential}) {
        if (!request.tools.length) {yield {type:'text_delta',text:'AUX_OK'};yield {type:'usage',usage:{inputTokens:5,outputTokens:2}};yield {type:'done',stopReason:'end_turn'};return}
        const hasResult=request.messages.some(message=>message.content.some(block=>block.type==='tool_result'));
        if(!hasResult) {yield {type:'tool_call',id:'write-call',name:${JSON.stringify(name)},input:{text:'accepted'}};yield {type:'done',stopReason:'tool_use'}}
        else {yield {type:'text_delta',text:'Finished '+credential};yield {type:'usage',usage:{inputTokens:12,outputTokens:3}};yield {type:'done',stopReason:'end_turn'}}
      }});
    for(const name of ['session.start','turn.start','tool.before','permission.request','tool.after','turn.end','session.end']) api.on(name,event=>api.ui.status('event',event.name));
    api.registerCommand({name:'aux',description:'Auxiliary',async run(){return api.complete('ext_fixture_local/model','Fixture auxiliary task')}});
    api.registerCommand({name:'dialog',description:'Dialog',async run(){return JSON.stringify(await api.ui.dialog({message:'Choose',fields:[{name:'answer',label:'Answer',type:'string',required:true,choices:['yes','no']}]}))}});
  }`,
  )
  const config = validateConfig(
    { extensions: { entries: { fixture: { root: packageRoot, entry: "entry.ts", enabled: true } } } },
    "fixture",
  )
  const review = await reviewExtension(config, "fixture", root)
  trustExtension(root, review, review.fingerprint)
  const driver = new CodesplashDriver({ config })
  const session = await driver.openSession({
    cwd: root,
    localSessionId: "extensions-session",
    trustDataDirectory: root,
    interactiveExtensions: true,
    model: "ext_fixture_local/model",
    policy: { sandbox: "workspace-write", approvalPolicy: "on-request" },
  })
  const events: AgentEvent[] = []
  let completed!: () => void
  const turn = new Promise<void>((resolve) => {
    completed = resolve
  })
  const drain = (async () => {
    for await (const event of session.events) {
      events.push(event)
      if (event.kind === "turn.completed") completed()
      if (event.kind === "request.opened")
        await session.resolveRequest(event.payload.id, {
          choice: "accept",
          ...(event.payload.requestKind === "elicitation" ? { data: { answer: "yes" } } : {}),
        })
    }
  })()
  try {
    const dialog = await session.extensionsCommand?.("run fixture/dialog")
    expect(dialog).toEqual({ result: '{"action":"accept","content":{"answer":"yes"}}' })
    expect(await session.extensionsCommand?.("run fixture/aux")).toEqual({ result: "AUX_OK" })
    await session.send({ text: "Write the fixture" })
    await turn
    if (!(await Bun.file(join(root, "result.txt")).exists()))
      throw new Error(
        JSON.stringify(
          events.filter((event) =>
            ["error", "warning", "item.updated", "turn.completed"].includes(event.kind),
          ),
        ),
      )
    expect(await Bun.file(join(root, "result.txt")).text()).toBe("accepted")
    expect(
      events.some((event) => event.kind === "item.updated" && event.payload.output === "extension progress"),
    ).toBe(true)
    expect(
      events.some(
        (event) => event.kind === "request.opened" && event.payload.title.includes("fixture/write"),
      ),
    ).toBe(true)
    expect(JSON.stringify(events)).not.toContain("extension-auth-fixture-secret")
    expect(
      events.filter((event) => event.kind === "extension.ui").map((event) => event.payload.text),
    ).toEqual(
      expect.arrayContaining([
        "session.start",
        "turn.start",
        "tool.before",
        "permission.request",
        "tool.after",
        "turn.end",
      ]),
    )
    const usage = events.filter((event) => event.kind === "usage.updated").at(-1)
    expect(usage?.payload.inputTokens).toBe(17)
    expect(usage?.payload.hasUnpricedUsage).toBe(true)
    expect((await session.listModels?.())?.some((model) => model.id === "ext_fixture_local/model")).toBe(true)
    await expect(session.extensionsCommand?.("reload")).rejects.toThrow("new session")
  } finally {
    await session.close()
    await drain
    await rm(root, { recursive: true, force: true })
  }
  expect(events.some((event) => event.kind === "extension.ui" && event.payload.text === "session.end")).toBe(
    true,
  )
})
