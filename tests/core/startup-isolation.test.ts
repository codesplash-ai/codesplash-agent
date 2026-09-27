import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { startStartupBridge } from "../../src/core/startup-bridge.ts"
import { startupArgv, startupProfile } from "../../src/core/startup-isolation.ts"

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "whole-agent OS boundary covers Bun filesystem operations and descendants while preserving state and nested sandbox",
  async () => {
    const root = realpathSync(
      mkdtempSync(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "startup-test-")),
    )
    const workspace = join(root, "work"),
      configDirectory = join(root, "config"),
      dataDirectory = join(root, "data"),
      temp = join(root, "temp"),
      outside = join(root, "private")
    for (const p of [workspace, configDirectory, dataDirectory, temp]) mkdirSync(p)
    writeFileSync(outside, "host-secret")
    const profile = startupProfile({ version: 1, workspace, configDirectory, dataDirectory })
    const modulePath = resolve("src/engines/codesplash/sandbox/runtime.ts"),
      profilePath = resolve("src/engines/codesplash/sandbox/profile.ts")
    const script = join(workspace, "probe.ts")
    writeFileSync(
      script,
      `import {readFileSync,writeFileSync} from "node:fs";
import {NativeSandbox} from ${JSON.stringify(modulePath)}; import {createProfile} from ${JSON.stringify(profilePath)};
let denied=false;try{readFileSync(${JSON.stringify(outside)})}catch{denied=true}if(!denied)throw Error("host read escaped");
writeFileSync(${JSON.stringify(join(dataDirectory, "state"))},"persisted");
writeFileSync(${JSON.stringify(join(workspace, "work"))},"changed");
const child=Bun.spawn(["/bin/cat",${JSON.stringify(outside)}],{stdout:"pipe",stderr:"pipe"}); if(await child.exited===0)throw Error("descendant escaped");
const sandbox=new NativeSandbox(createProfile(${JSON.stringify(workspace)},"workspace-write"));
try {const r=await sandbox.execute(["/bin/sh","-c",${JSON.stringify(`cat '${join(dataDirectory, "state")}' >/dev/null 2>&1 && exit 42; echo NESTED_PASS`)}],new AbortController().signal);if(r.kind!=="success"||!r.stdout.includes("NESTED_PASS"))throw Error(JSON.stringify(r));}finally{await sandbox.close()}
const streams = new NativeSandbox(createProfile(${JSON.stringify(workspace)},"workspace-write"));
try {
  let output="";let ready;const received=new Promise(resolve=>{ready=resolve});
  const duplex=await streams.openDuplex(["/bin/cat"],new AbortController().signal,bytes=>{output+=Buffer.from(bytes).toString();if(output.includes("DUPLEX_PASS"))ready()});
  await duplex.write(Buffer.from("DUPLEX_PASS\\n"));await Promise.race([received,new Promise((_,reject)=>setTimeout(()=>reject(Error("duplex timeout")),5000).unref())]);await duplex.close();
  let terminal="";const pty=await streams.openTerminal(["/bin/sh","-c","printf PTY_PASS"],{cols:80,rows:24,timeoutMs:5000},new AbortController().signal,bytes=>{terminal+=Buffer.from(bytes).toString()});
  await pty.finished;if(!terminal.includes("PTY_PASS"))throw Error("PTY failed");
}finally{await streams.close()}
console.log("STARTUP_PASS");`,
    )
    const bridge = await startStartupBridge(profile, temp)
    try {
      const child = Bun.spawn(startupArgv(profile, temp, [process.execPath, script]), {
        cwd: workspace,
        env: {
          CODESPLASH_STARTUP_BRIDGE: bridge.path,
          CODESPLASH_STARTUP_TOKEN: bridge.token,
          PATH: process.env.PATH,
          HOME: temp,
          TMPDIR: temp,
          CODESPLASH_AGENT_CONFIG_DIR: configDirectory,
          CODESPLASH_AGENT_DATA_DIR: dataDirectory,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, err }).toEqual({ code: 0, err: "" })
      expect(out).toContain("STARTUP_PASS")
      expect(readFileSync(join(dataDirectory, "state"), "utf8")).toBe("persisted")
    } finally {
      await bridge.close()
      rmSync(root, { recursive: true, force: true })
    }
  },
  60000,
)

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "startup bridge refuses forged roots and out-of-workspace plan writes",
  async () => {
    const { createConnection } = await import("node:net")
    const { createProfile } = await import("../../src/engines/codesplash/sandbox/profile.ts")
    const root = realpathSync(
      mkdtempSync(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "startup-deny-")),
    )
    const work = join(root, "work"),
      config = join(root, "config"),
      data = join(root, "data"),
      owner = join(root, "owner"),
      temp = join(owner, "job")
    for (const path of [work, config, data, owner, temp]) mkdirSync(path)
    const bridge = await startStartupBridge(
      startupProfile({ version: 1, workspace: work, configDirectory: config, dataDirectory: data }),
      owner,
    )
    try {
      for (const extra of [
        { profile: createProfile(root, "workspace-write") },
        { planFile: join(root, "escape") },
      ]) {
        const socket = createConnection({ path: bridge.path })
        const ended = new Promise<string>((resolve, reject) => {
          let out = ""
          socket.on("data", (chunk) => {
            out += chunk
          })
          socket.once("end", () => resolve(out))
          socket.once("error", reject)
        })
        const input = {
          profile: createProfile(work, "workspace-write"),
          argv: ["/bin/sh", "-c", "exit 92"],
          temp,
          timeoutMs: 1000,
          ...extra,
        }
        socket.write(
          `${JSON.stringify({ token: bridge.token, role: "supervisor", input: JSON.stringify(input) })}\n`,
        )
        expect(await ended).toBe("")
        socket.destroy()
      }
    } finally {
      await bridge.close()
      rmSync(root, { recursive: true, force: true })
    }
  },
)
