/** Actual standalone PTY control frames plus native compiled task tools, without a paid provider. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { childEnvironment } from "../src/engines/codesplash/sandbox/env-policy.ts"
import { runProcess } from "../src/engines/codesplash/sandbox/process.ts"
import { createProfile } from "../src/engines/codesplash/sandbox/profile.ts"
import { TerminalFrames, terminalBytes } from "../src/engines/codesplash/sandbox/terminal-protocol.ts"

if (!process.argv[2]) throw new Error("Usage: bun scripts/terminal-smoke.ts COMPILED_BINARY")
const binary = resolve(process.argv[2]),
  root = await realpath(await mkdtemp(join(tmpdir(), "terminal-smoke-")))
const cwd = join(root, "workspace"),
  temp = join(root, "temp"),
  config = join(root, "config"),
  extension = join(root, "extension")
try {
  for (const dir of [cwd, temp, config, extension]) await mkdir(dir)
  const pipe = new TransformStream<Uint8Array, Uint8Array>(),
    writer = pipe.writable.getWriter(),
    parser = new TerminalFrames()
  let text = "",
    result: unknown
  const abort = new AbortController(),
    deadline = setTimeout(() => abort.abort(), 15000)
  const execution = runProcess([binary, "--internal-sandbox-pty-supervisor"], {
    cwd,
    env: childEnvironment(temp),
    inputStream: pipe.readable,
    signal: abort.signal,
    timeoutMs: 15000,
    structured: true,
    onStdout: (bytes) =>
      parser.push(bytes, (value) => {
        const frame = value as { kind: string; data: string; result?: unknown }
        if (frame.kind === "output") text += Buffer.from(terminalBytes(frame.data)).toString()
        if (frame.kind === "result") result = frame.result
        if (frame.kind === "ready")
          void writer
            .write(
              Buffer.from(
                `${JSON.stringify({ kind: "resize", seq: 1, cols: 93, rows: 29 })}\n${JSON.stringify({ kind: "stdin", seq: 2, data: Buffer.from("COMPILED_INPUT\n").toString("base64") })}\n`,
              ),
            )
            .catch(() => abort.abort())
      }),
  })
  try {
    await writer.write(
      Buffer.from(
        `${JSON.stringify({ profile: createProfile(cwd, "read-only"), argv: ["/bin/sh", "-c", 'test -t 0 && test -t 1 && printf "COMPILED_TTY\\n"; read value; stty size; printf "%s\\n" "$value"; if printf bad > denied; then printf BAD_WRITE; else printf WRITE_DENIED; fi'], terminal: { cols: 80, rows: 24 }, temp, timeoutMs: 5000 })}\n`,
      ),
    )
    const outer = await execution
    assert.equal(outer.exitCode, 0, JSON.stringify(outer))
    assert.deepEqual(result, { kind: "success", exitCode: 0, stdout: "", stderr: "" })
    for (const marker of ["COMPILED_TTY", "COMPILED_INPUT", "29 93", "WRITE_DENIED"])
      assert.match(text, new RegExp(marker))
    assert.doesNotMatch(text, /BAD_WRITE/)
  } finally {
    clearTimeout(deadline)
    abort.abort()
    await execution
    await writer.abort().catch(() => {})
  }
  await writeFile(
    join(extension, "entry.ts"),
    `export default api => {
    let stage=0,id,deadline,call=0;
    api.registerProvider({name:'local',displayName:'Tasks',protocol:'openai',models:[{id:'model',displayName:'Tasks',contextWindow:32768,maxOutputTokens:1024,isDefault:true,supportsReasoning:false}],async *stream(request){
      const results=request.messages.flatMap(m=>m.content).filter(b=>b.type==='tool_result');
      const last=results.at(-1); if(last?.isError) throw new Error(last.text);
      let name,input;
      if(stage===0){name='exec_command';input={command:'cat',readOnly:true,background:true};stage=1}
      else if(stage===1){id=JSON.parse(last.text).task.id;deadline=Date.now()+15000;name='task_wait';input={ids:[id],timeoutMs:1000};stage=2}
      else if(stage===2){name='task_output';input={id};stage=3}
      else if(stage===3){
        const page=JSON.parse(last.text);
        if(!page.terminalReady){
          if(Date.now()>=deadline || !['queued','running'].includes(page.task.status)) throw new Error('Terminal did not become ready: '+last.text);
          await new Promise(resolve=>setTimeout(resolve,250));name='task_output';input={id};
        }else{name='write_stdin';input={id,text:'COMPILED_TASK_INPUT\\n'};stage=4}
      }
      else if(stage===4){deadline=Date.now()+15000;name='task_output';input={id};stage=5}
      else if(stage===5){
        if(!last.text.includes('COMPILED_TASK_INPUT')){
          if(Date.now()>=deadline) throw new Error('Missing task output: '+last.text);
          await new Promise(resolve=>setTimeout(resolve,250));name='task_output';input={id};
        }else{name='task_kill';input={id};stage=6}
      }
      else if(stage===6){name='task_wait';input={ids:[id],all:true,timeoutMs:15000};stage=7}
      else {if(!JSON.stringify(last).includes('COMPILED_TASK_INPUT')) throw new Error('Missing task output');yield {type:'text_delta',text:'COMPILED_TASKS_OK'};yield {type:'done',stopReason:'end_turn'};return}
      yield {type:'tool_call',id:'stage-'+(++call),name,input};yield {type:'done',stopReason:'tool_use'}
    }})
  }`,
  )
  await writeFile(
    join(config, "config.toml"),
    `[extensions.entries.fixture]\nroot=${JSON.stringify(extension)}\nentry="entry.ts"\nenabled=true\n`,
  )
  const env = {
    ...process.env,
    CODESPLASH_AGENT_CONFIG_DIR: config,
    CODESPLASH_AGENT_DATA_DIR: join(root, "data"),
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
  }
  for (const name of ["CODESPLASH_CONFIG", "CODESPLASH_PROFILE", "CODESPLASH_PERMISSION_MODE"])
    delete (env as NodeJS.ProcessEnv)[name]
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
  const output = await run([
    "run",
    "--model",
    "ext_fixture_local/model",
    "--auto",
    "--trust",
    "--no-history",
    "--output-format",
    "stream-json",
    "Exercise owned command tasks",
  ])
  assert.match(output, /COMPILED_TASKS_OK/)
  console.log(
    "Compiled terminal/task smoke passed: PTY sizing/stdin, denied write, task output/wait/kill and owned close",
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
