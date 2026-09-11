/** Standalone extension fixture: external TS + ESM/CommonJS dependencies, provider/auth/tool path. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"

if (!process.argv[2]) throw new Error("Usage: bun scripts/extensions-smoke.ts /path/to/codesplash")
const binary = resolve(process.argv[2]),
  root = await realpath(await mkdtemp(join(tmpdir(), "codesplash-extensions-smoke-")))
const cwd = join(root, "workspace"),
  config = join(root, "config"),
  packageRoot = join(root, "package")
try {
  for (const folder of [cwd, config, join(packageRoot, "node_modules/fixture")])
    await mkdir(folder, { recursive: true })
  await writeFile(join(packageRoot, "dep.ts"), "export const text: string = 'EXTENSION_COMPILED_OK'")
  await writeFile(
    join(packageRoot, "node_modules/fixture/package.json"),
    '{"name":"fixture","main":"index.js"}',
  )
  await writeFile(join(packageRoot, "node_modules/fixture/index.js"), "module.exports = () => 'PACKAGE_OK'")
  await writeFile(
    join(packageRoot, "entry.ts"),
    `import {createHash} from 'node:crypto'; import {text} from './dep.ts'; import dependency from 'fixture';
export default api => {
  if(api.version!==1) throw new Error('API mismatch');
  const suffix=api.registerFlag('suffix',{type:'string',default:'FLAG_OK'});
  const tool='ext_fixture_'+createHash('sha256').update('write').digest('hex').slice(0,24);
  api.registerTool({name:'write',description:'Compiled fixture write',effects:'workspace',inputSchema:{type:'object',properties:{},additionalProperties:false},
    targets:()=>({paths:[api.cwd+'/result.txt']}),async run(input,ctx){ctx.progress('COMPILED_PROGRESS');await Bun.write(api.cwd+'/result.txt',text+':'+dependency()+':'+suffix);return {text:'written',label:'Fixture write',mutatedPaths:[api.cwd+'/result.txt']}}});
  api.registerProvider({name:'local',displayName:'Fixture',protocol:'openai',models:[{id:'model',displayName:'Fixture',contextWindow:32768,maxOutputTokens:1024,isDefault:true,supportsReasoning:false}],
    async auth(){return 'compiled-fixture-credential'},async *stream(request,{credential}){
      if(!request.messages.some(message=>message.content.some(block=>block.type==='tool_result'))){yield {type:'tool_call',id:'write',name:tool,input:{}};yield {type:'done',stopReason:'tool_use'}}
      else {yield {type:'text_delta',text:text+':'+credential};yield {type:'usage',usage:{inputTokens:20,outputTokens:4}};yield {type:'done',stopReason:'end_turn'}}
    }});
  api.on('session.end',()=>{api.ui.status('end','EXTENSION_CLOSED')});
}`,
  )
  await writeFile(
    join(config, "config.toml"),
    `[extensions.entries.fixture]\nroot=${JSON.stringify(packageRoot)}\nentry="entry.ts"\nenabled=true\n`,
  )
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODESPLASH_AGENT_CONFIG_DIR: config,
    CODESPLASH_AGENT_DATA_DIR: join(root, "data"),
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
  }
  for (const key of ["CODESPLASH_CONFIG", "CODESPLASH_PROFILE", "CODESPLASH_PERMISSION_MODE"]) delete env[key]
  const run = async (args: string[], okay = true) => {
    const result = await runProcess(
      [...(binary.endsWith(".js") ? [process.execPath, binary] : [binary]), ...args],
      {
        cwd,
        env,
        signal: AbortSignal.timeout(45000),
        timeoutMs: 45000,
        maxBytes: 2 * 1024 * 1024,
        structured: true,
      },
    )
    if (okay) assert.equal(result.exitCode, 0, result.stderr + result.stdout)
    else assert.notEqual(result.exitCode, 0)
    return result
  }
  const review = JSON.parse((await run(["extensions", "show", "fixture"])).stdout)
  assert.equal(review.trusted, false)
  assert.equal(review.files.length, 4)
  await run(["extensions", "trust", "fixture", "--fingerprint", review.fingerprint])
  const args = [
    "run",
    "--model",
    "ext_fixture_local/model",
    "--auto",
    "--trust",
    "--no-history",
    "--output-format",
    "stream-json",
    "Write the fixture",
  ]
  const result = await run(args)
  assert.equal(await readFile(join(cwd, "result.txt"), "utf8"), "EXTENSION_COMPILED_OK:PACKAGE_OK:FLAG_OK")
  assert.match(result.stdout, /COMPILED_PROGRESS/)
  assert.match(result.stdout, /EXTENSION_CLOSED/)
  assert.doesNotMatch(result.stdout + result.stderr, /compiled-fixture-credential/)
  await writeFile(join(packageRoot, "dep.ts"), "export const text='CHANGED'")
  const changed = await run(args, false)
  assert.match(changed.stderr + changed.stdout, /fingerprint trust/)
  const recovery = await run(
    ["run", "--no-extensions", "--model", "ext_fixture_local/model", "--no-history", "--trust", "Recovery"],
    false,
  )
  assert.match(recovery.stderr + recovery.stdout, /No API keys|No providers/)
  assert.doesNotMatch(recovery.stderr + recovery.stdout, /fingerprint trust/)
  console.log(
    "Extension smoke passed: external TS, relative/package dependencies, flags, provider/auth, streaming tool, usage, close, changed-source refusal and disabled recovery.",
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
