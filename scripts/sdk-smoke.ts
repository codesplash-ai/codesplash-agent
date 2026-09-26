import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"
import { APP_VERSION } from "../src/version.ts"

const project = process.cwd(),
  root = await realpath(await mkdtemp(join(tmpdir(), "sdk-package-smoke-")))
const env = {
  ...process.env,
  CODESPLASH_AGENT_CONFIG_DIR: join(root, "config"),
  CODESPLASH_AGENT_DATA_DIR: join(root, "data"),
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
}
for (const key of ["CODESPLASH_CONFIG", "CODESPLASH_PROFILE", "CODESPLASH_PERMISSION_MODE"])
  delete (env as NodeJS.ProcessEnv)[key]
async function run(argv: string[], cwd = root) {
  const result = await runProcess(argv, {
    cwd,
    env,
    signal: AbortSignal.timeout(120000),
    timeoutMs: 120000,
    maxBytes: 4 * 1024 * 1024,
  })
  assert.equal(result.exitCode, 0, `${argv.join(" ")}\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}
try {
  await run([process.execPath, "run", "build"], project)
  const archive = resolve(`out/codesplash-agent-${APP_VERSION}-sdk.tgz`)
  await mkdir(resolve("out"), { recursive: true })
  await run([process.execPath, "pm", "pack", "--filename", archive], project)
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "external-sdk-consumer",
      private: true,
      type: "module",
      dependencies: { "codesplash-agent": `file:${archive}` },
      devDependencies: { typescript: "5.9.2", "@types/bun": "1.3.14" },
    }),
  )
  await run([process.execPath, "install", "--ignore-scripts"])
  const installed = join(root, "node_modules", "codesplash-agent")
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"))
  assert.ok(manifest.exports["."].types)
  assert.ok(
    (await readFile(join(installed, "dist/core/session/secure-path.c"), "utf8")).includes("cs_openat"),
  )
  await cp(join(installed, "examples/sdk"), join(root, "examples"), { recursive: true })
  await writeFile(
    join(root, "examples/runtime-assets.ts"),
    `
import {readFile,writeFile} from 'node:fs/promises';
import schema from 'codesplash-agent/config.schema.json';
import managed from 'codesplash-agent/managed.schema.json';
import {fixture,assert,join,localProvider} from './fixture.ts';
assert.ok(schema.properties);assert.ok(managed.properties);
await fixture(async({root,open})=>{
  const init=Bun.spawn(['git','-c','core.hooksPath=/dev/null','init','-q',root],{stdout:'pipe',stderr:'pipe'});assert.equal(await init.exited,0);
  await writeFile(join(root,'result.txt'),'before');
  const provider=localProvider();let stage=0;
  provider.stream=async function*(request){
    stage++;
    if(stage===1){yield {type:'tool_call',id:'shell',name:'bash',input:{command:'printf SDK_NATIVE_SHELL_OK',timeout:2000}};yield {type:'done',stopReason:'tool_use'}}
    else if(stage===2){assert.match(JSON.stringify(request.messages),/SDK_NATIVE_SHELL_OK/);yield {type:'tool_call',id:'write',name:'write_file',input:{path:'result.txt',content:'after'}};yield {type:'done',stopReason:'tool_use'}}
    else {yield {type:'text_delta',text:'done'};yield {type:'done',stopReason:'end_turn'}}
  };
  const session=await open({providers:[provider],persistence:{root:join(root,'sessions')},respond:async()=>({choice:'accept'})});
  assert.equal((await session.prompt('Exercise native runtime assets')).status,'completed');
  assert.equal(await readFile(join(root,'result.txt'),'utf8'),'after');
  const checkpoints=await session.sessionRecovery({action:'checkpoints'});
  const steps=(checkpoints.data as {steps:Array<{id:string;label:string}>}).steps;
  const checkpoint=steps.at(-1)?.id;assert.ok(checkpoint);
  const preview=await session.sessionRecovery({action:'restore',checkpoint,paths:['result.txt']});
  const revision=(preview.data as {revision:string}).revision;assert.ok(revision);
  await session.sessionRecovery({action:'restore',checkpoint,paths:['result.txt'],revision,apply:true});
  assert.equal(await readFile(join(root,'result.txt'),'utf8'),'before');
});
`,
  )
  await writeFile(
    join(root, "consumer.ts"),
    `import {createAgentSession, type AgentSession, type ExtensionTool} from 'codesplash-agent';
import {extensionModelId} from 'codesplash-agent/sdk';
import type {ExtensionFactory} from 'codesplash-agent/extensions';
const tool:ExtensionTool={name:'example',description:'Example',readOnly:true,inputSchema:{type:'object'},async run(_,ctx){ctx.progress('ready');return {text:'ok',label:'Example'}}};
const factory:ExtensionFactory=api=>api.registerTool(tool);
async function consumer(){const session:AgentSession=await createAgentSession({extensions:[{id:'example',factory}],model:extensionModelId('example','local','model')});try{const feed=session.events();await feed.return?.();await session.inspectContext();await session.prompt('hello')}finally{await session.close()}}
void consumer;
`,
  )
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "ES2024",
        lib: ["ES2024", "DOM", "DOM.Iterable"],
        types: ["node"],
        allowImportingTsExtensions: true,
        resolveJsonModule: true,
      },
      include: ["consumer.ts"],
    }),
  )
  await run([
    process.execPath,
    join(root, "node_modules/typescript/bin/tsc"),
    "-p",
    join(root, "tsconfig.json"),
  ])
  // Bun 1.3.14's upstream ambient declarations have four library errors against Node 24 types.
  // Keep the public consumer's library check strict; check example source with Bun's normal skipLibCheck.
  await writeFile(
    join(root, "examples-tsconfig.json"),
    JSON.stringify({
      extends: "./tsconfig.json",
      compilerOptions: { types: ["bun", "node"], skipLibCheck: true },
      include: ["examples/**/*.ts"],
    }),
  )
  await run([
    process.execPath,
    join(root, "node_modules/typescript/bin/tsc"),
    "-p",
    join(root, "examples-tsconfig.json"),
  ])
  const node = Bun.which("node")
  if (!node) throw new Error("Node is required for the SDK import compatibility probe")
  await run([
    node,
    "--input-type=module",
    "-e",
    `import assert from 'node:assert/strict'; import {createAgentSession} from 'codesplash-agent'; import 'codesplash-agent/extensions'; await assert.rejects(createAgentSession(),/requires Bun/); console.log('Node inert import and execution refusal passed')`,
  ])
  for (const file of [
    "01-minimal.ts",
    "02-recorded-resume.ts",
    "03-streaming-tool.ts",
    "04-mcp-resource-elicitation.ts",
    "05-hook.ts",
    "06-provider-auth.ts",
    "07-ui-extension.ts",
    "08-git-workflow.ts",
    "09-background-command.ts",
    "10-child-agent.ts",
    "11-worktrees-peers.ts",
    "12-goal.ts",
    "13-workflow.ts",
    "14-scheduler.ts",
    "15-teams.ts",
    "16-orchestration-integration.ts",
    "17-side-question.ts",
  ]) {
    assert.match(await run([process.execPath, join(root, "examples", file)]), /SDK_EXAMPLE_OK/)
    console.log(`Packed SDK example passed: ${file}`)
  }
  assert.match(await run([process.execPath, join(root, "examples/runtime-assets.ts")]), /SDK_EXAMPLE_OK/)
  console.log(
    `Packed native shell and checkpoint restore passed; Bun ${Bun.version}; Node ${(await run([node, "--version"])).trim()}`,
  )
  console.log("SDK_PACKAGE_SMOKE_OK: fresh install, strict types, assets, Node boundary, seventeen examples")
} finally {
  await rm(root, { recursive: true, force: true })
}
