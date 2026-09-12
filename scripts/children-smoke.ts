/** Real compiled native child dispatch and read-only enforcement, using a disposable local provider. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"

if (!process.argv[2]) throw new Error("Usage: bun scripts/children-smoke.ts COMPILED_BINARY")
const binary = resolve(process.argv[2]),
  root = await realpath(await mkdtemp(join(tmpdir(), "children-smoke-")))
const cwd = join(root, "workspace"),
  config = join(root, "config"),
  extension = join(root, "extension")
try {
  for (const path of [cwd, config, extension]) await mkdir(path)
  await writeFile(
    join(extension, "entry.ts"),
    `export default api => api.registerProvider({name:'local',displayName:'Child fixture',protocol:'openai',models:[{id:'model',displayName:'Local',contextWindow:131072,maxOutputTokens:1024,isDefault:true,supportsReasoning:false}],async *stream(request){
    const child=request.system.includes('[Child role'); const results=request.messages.flatMap(m=>m.content).filter(b=>b.type==='tool_result'); const last=results.at(-1);
    if(child && !last) yield {type:'tool_call',id:'write',name:'write_file',input:{path:'forbidden.txt',content:'bad'}};
    else if(child) yield {type:'text_delta',text:'CHILD_DENIED:'+Boolean(last.isError)};
    else if(!last) yield {type:'tool_call',id:'child',name:'agent',input:{agent:'project/reviewer',prompt:'Inspect without writing',yieldMs:30000}};
    else {if(last.isError || !last.text.includes('CHILD_DENIED:true') || !last.text.includes('completed'))throw new Error('Bad child result: '+last.text);yield {type:'text_delta',text:'COMPILED_CHILD_OK'}};
    yield {type:'usage',usage:{inputTokens:4,outputTokens:2}};yield {type:'done',stopReason:!last?'tool_use':'end_turn'};
  }})`,
  )
  await writeFile(
    join(config, "config.toml"),
    `[memory]\nenabled=false\n[extensions.entries.fixture]\nroot=${JSON.stringify(extension)}\nentry="entry.ts"\nenabled=true\n`,
  )
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODESPLASH_AGENT_CONFIG_DIR: config,
    CODESPLASH_AGENT_DATA_DIR: join(root, "data"),
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
  }
  for (const name of ["CODESPLASH_CONFIG", "CODESPLASH_PROFILE", "CODESPLASH_PERMISSION_MODE"])
    delete env[name]
  const run = async (args: string[]) => {
    const result = await runProcess([binary, ...args], {
      cwd,
      env,
      signal: AbortSignal.timeout(45000),
      timeoutMs: 45000,
      maxBytes: 2 * 1024 * 1024,
      structured: true,
    })
    assert.equal(result.exitCode, 0, result.stdout + result.stderr)
    return result.stdout
  }
  await run(["agents", "create", "reviewer", "--write"])
  const agent = JSON.parse(await run(["agents", "show", "project/reviewer", "--trust"]))
  assert.equal(agent.enabled, false)
  await run(["agents", "enable", "project/reviewer", "--fingerprint", agent.fingerprint, "--trust"])
  const review = JSON.parse(await run(["extensions", "show", "fixture"]))
  await run(["extensions", "trust", "fixture", "--fingerprint", review.fingerprint])
  const output = await run([
    "run",
    "--model",
    "ext_fixture_local/model",
    "--auto",
    "--trust",
    "--no-history",
    "--output-format",
    "stream-json",
    "Run the child fixture",
  ])
  assert.match(output, /COMPILED_CHILD_OK/)
  assert.equal(await Bun.file(join(cwd, "forbidden.txt")).exists(), false)
  console.log(
    "Compiled child smoke passed: definition review/activation, scoped native session, denied write, task result and aggregate usage",
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
