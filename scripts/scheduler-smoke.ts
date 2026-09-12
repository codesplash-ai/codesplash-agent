/** Real compiled finite scheduler owners with reviewed definitions and local scripted providers. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"

const binary = resolve(process.argv[2] ?? "out/codesplash"),
  root = await realpath(await mkdtemp(join(tmpdir(), "cs-m7f-smoke-")))
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
      signal: AbortSignal.timeout(90000),
      timeoutMs: 90000,
      maxBytes: 2 * 1024 * 1024,
      structured: true,
    })
    assert.equal(value.exitCode, 0, value.stdout + value.stderr)
    return value.stdout
  }
  const review = JSON.parse(await run(["extensions", "show", "fixture"]))
  await run(["extensions", "trust", "fixture", "--fingerprint", review.fingerprint])
  const spec = {
    name: "compiled",
    prompt: "Inspect evidence.txt",
    interval: "1m",
    watch: ".",
    limits: { tokens: 65536, timeoutMs: 30000, rounds: 1 },
    maxOccurrences: 2,
    totalTokens: 131072,
    expiresAfterMs: 3600000,
  }
  const source = join(root, "schedule.json")
  await Bun.write(source, JSON.stringify(spec))
  const created = JSON.parse(await run(["scheduler", "create", source, "--write"]))
  assert.equal(created.created[0].enabled, false)
  const id = created.created[0].id,
    fingerprint = created.created[0].fingerprint
  const flags = [
    "--apply",
    "--trust",
    "--approve",
    "--model",
    "ext_fixture_local/model",
    "--store",
    join(root, "sessions"),
  ]
  await run(["scheduler", "enable", id, "--fingerprint", fingerprint, ...flags])
  const manual = await run(["scheduler", "run", id, ...flags])
  assert.match(manual, /"status": "completed"/)
  const journal = JSON.parse(await run(["scheduler", "list"]))
  assert.equal(journal.occurrences.length, 1)
  assert.equal(journal.schedules[0].used, 6)
  // A real file notification waits for the one-minute cadence, then dispatches a native child.
  const worker = run(["scheduler", "worker", "--duration-ms", "70000", ...flags])
  await new Promise((resolve) => setTimeout(resolve, 2500))
  await Bun.write(join(cwd, "evidence.txt"), "external watched edit")
  await worker
  const after = JSON.parse(await run(["scheduler", "list"]))
  assert.equal(after.occurrences.length, 2)
  assert.equal(after.occurrences[1].status, "completed")
  assert.equal(after.schedules[0].enabled, false)
  assert.equal(after.schedules[0].used, 12)
  await run(["scheduler", "delete", id, "--apply"])
  console.log(
    "Compiled scheduler smoke passed: disabled definition, explicit enable, native occurrence, durable usage receipt, actual one-minute file-trigger dispatch and finite worker teardown",
  )
  passed = true
} finally {
  if (passed) await rm(root, { recursive: true, force: true })
  else console.error(`Scheduler smoke evidence retained: ${root}`)
}
