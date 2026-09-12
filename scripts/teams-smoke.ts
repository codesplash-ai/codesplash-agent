/** Real compiled native teams with optional private terminal presentation and local providers. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"

const binary = resolve(process.argv[2] ?? "out/codesplash"),
  root = await realpath(await mkdtemp(join(tmpdir(), "cs-m7g-smoke-")))
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
  assert.match(await run(["agent", "--help"]), /codesplash agents list/)
  const review = JSON.parse(await run(["extensions", "show", "fixture"]))
  await run(["extensions", "trust", "fixture", "--fingerprint", review.fingerprint])
  const spec = {
    name: "compiled-team",
    members: [
      { name: "reader", agent: "builtin/explore", role: "reviewer", prompt: "Inspect evidence.txt" },
      { name: "writer", agent: "builtin/general", role: "worker", prompt: "Report a bounded outcome" },
    ],
  }
  const source = join(root, "team.json")
  await Bun.write(source, JSON.stringify(spec))
  const owned = await run([
    "teams",
    "run",
    source,
    "--apply",
    "--trust",
    "--approve",
    ...(Bun.which("tmux") ? ["--panes"] : []),
    "--duration-ms",
    "30000",
    "--model",
    "ext_fixture_local/model",
    "--store",
    join(root, "sessions"),
  ])
  assert.match(owned, /"status": "completed"/)
  assert.match(owned, /"inputTokens": 4/)
  const identity = JSON.parse(owned.split("\n")[0]!)
  const saved = JSON.parse(
    await run(["teams", "inspect", identity.session, "--store", join(root, "sessions")]),
  )
  assert.equal(saved.teams[0].members.length, 2)
  assert.ok(saved.teams[0].members.every((m: { task?: string }) => m.task))
  if (Bun.which("tmux")) {
    const pane = JSON.parse(owned.split("\n")[1]!)
    assert.equal(pane.windows.length, 1)
    const { existsSync } = await import("node:fs")
    assert.equal(existsSync(pane.socket), false, "Finite owner removed its private tmux server")
  }
  console.log(
    `Compiled teams smoke passed: native named children, inclusive usage, durable roster and ${Bun.which("tmux") ? "real private tmux viewer with finite teardown" : "in-process backend (tmux unavailable)"}`,
  )
  passed = true
} finally {
  if (passed) await rm(root, { recursive: true, force: true })
  else console.error(`Teams smoke evidence retained: ${root}`)
}
