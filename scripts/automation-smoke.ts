/** Real compiled finite automation owners with reviewed definitions and local scripted providers. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"

const binary = resolve(process.argv[2] ?? "out/codesplash"),
  root = await realpath(await mkdtemp(join(tmpdir(), "cs-m7e-smoke-")))
const cwd = join(root, "repo"),
  config = join(root, "config"),
  extension = join(root, "extension")
let passed = false
try {
  for (const path of [cwd, config, extension]) await mkdir(path)
  await Bun.write(join(cwd, "evidence.txt"), "real compiled evidence")
  await Bun.write(
    join(extension, "entry.ts"),
    `export default api => api.registerProvider({name:'local',displayName:'Automation fixture',protocol:'openai',models:[{id:'model',displayName:'Local',contextWindow:131072,maxOutputTokens:1024,isDefault:true,supportsReasoning:false}],async *stream(request){
    const verifier=request.system.includes('You are a verifier'), last=request.messages.at(-1)?.content.find(b=>b.type==='tool_result');
    if(verifier&&!last)yield {type:'tool_call',id:'evidence',name:'read_file',input:{path:'evidence.txt'}};
    else yield {type:'text_delta',text:verifier?'{"complete":true,"evidence":"evidence.txt was observed"}':'Local worker completed'};
    yield {type:'usage',usage:{inputTokens:4,outputTokens:2}};yield {type:'done',stopReason:verifier&&!last?'tool_use':'end_turn'};
  }})`,
  )
  await Bun.write(
    join(config, "config.toml"),
    `[memory]\nenabled=false\n[extensions.entries.fixture]\nroot=${JSON.stringify(extension)}\nentry="entry.ts"\nenabled=true\n`,
  )
  const env = {
    ...process.env,
    CODESPLASH_AGENT_CONFIG_DIR: config,
    CODESPLASH_AGENT_DATA_DIR: join(root, "data"),
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
  }
  for (const key of ["CODESPLASH_CONFIG", "CODESPLASH_PROFILE", "CODESPLASH_PERMISSION_MODE"])
    delete (env as NodeJS.ProcessEnv)[key]
  const run = async (args: string[]) => {
    const value = await runProcess([binary, ...args], {
      cwd,
      env,
      signal: AbortSignal.timeout(60000),
      timeoutMs: 60000,
      maxBytes: 2 * 1024 * 1024,
      structured: true,
    })
    assert.equal(value.exitCode, 0, value.stdout + value.stderr)
    return value.stdout
  }
  const review = JSON.parse(await run(["extensions", "show", "fixture"]))
  await run(["extensions", "trust", "fixture", "--fingerprint", review.fingerprint])
  const flags = [
    "--apply",
    "--trust",
    "--approve",
    "--model",
    "ext_fixture_local/model",
    "--store",
    join(root, "sessions"),
  ]
  const goal = await run([
    "automation",
    "goal",
    "Inspect evidence.txt",
    "--tokens",
    "200000",
    "--timeout-ms",
    "30000",
    "--rounds",
    "2",
    ...flags,
  ])
  assert.match(goal, /"status": "complete"/)
  assert.match(goal, /"used": 18/)
  const { session } = JSON.parse(goal.split("\n")[0]!)
  const journal = JSON.parse(await run(["automation", "inspect", session, "--store", join(root, "sessions")]))
  assert.equal(journal.records[0].status, "complete")
  await run(["workflows", "create", "compiled", "--write"])
  const path = join(cwd, ".codesplash", "workflows", "compiled.json"),
    definition = JSON.parse(await Bun.file(path).text())
  definition.steps = [
    { id: "write", kind: "command", command: "printf compiled > workflow.txt" },
    {
      id: "verify",
      kind: "verification",
      needs: ["write"],
      prompt: "Read evidence.txt and verify the inspection objective",
    },
  ]
  await Bun.write(path, JSON.stringify(definition))
  const source = JSON.parse(await run(["workflows", "show", "compiled"]))
  const enabled = JSON.parse(
    await run(["workflows", "enable", "compiled", "--fingerprint", source.sourceFingerprint, "--apply"]),
  )
  const workflow = await run([
    "automation",
    "workflow",
    "compiled",
    "--fingerprint",
    enabled.fingerprint,
    ...flags,
  ])
  assert.match(workflow, /"status": "complete"/)
  assert.equal(await Bun.file(join(cwd, "workflow.txt")).text(), "compiled")
  console.log(
    "Compiled automation smoke passed: explicit goal, observed verifier, durable journal, reviewed workflow, sandboxed command and finite owner teardown",
  )
  passed = true
} finally {
  if (passed) await rm(root, { recursive: true, force: true })
  else console.error(`Automation smoke evidence retained: ${root}`)
}
