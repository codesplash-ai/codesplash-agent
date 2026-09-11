import { expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validateConfig } from "../../../src/core/config.ts"
import type { HookEvent } from "../../../src/core/hooks.ts"
import { MemorySessionState } from "../../../src/core/session/control.ts"
import { HookReceipts } from "../../../src/engines/codesplash/hooks/receipts.ts"
import { hookTrusted, reviewHook, trustHook } from "../../../src/engines/codesplash/hooks/trust.ts"
import { createProfile } from "../../../src/engines/codesplash/sandbox/profile.ts"
import { NativeSandbox } from "../../../src/engines/codesplash/sandbox/runtime.ts"

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hooks-fixture-"))),
    script = join(root, "hook.sh")
  await writeFile(script, "printf '{\"version\":1}'\n")
  const config = validateConfig(
    {
      hooks: {
        handlers: {
          fixture: {
            kind: "command",
            command: "/bin/sh",
            args: [script],
            events: ["tool.before"],
            once: "session",
          },
        },
      },
    },
    "fixture",
  )
  return { root, script, config, close: () => rm(root, { recursive: true, force: true }) }
}

test("hook executable receipts bind source content and once intent survives a replaced owner", async () => {
  const value = await fixture()
  try {
    const review = await reviewHook(value.config, "fixture", value.root)
    expect(hookTrusted(value.root, review)).toBe(false)
    trustHook(value.root, review, review.fingerprint)
    expect(hookTrusted(value.root, review)).toBe(true)
    const state = new MemorySessionState(),
      receipts = new HookReceipts(state)
    const event: HookEvent = {
      version: 1,
      id: "event",
      name: "tool.before",
      sessionId: "session",
      turnId: "turn",
      operationId: "operation",
      generation: "source",
      metadata: { toolName: "bash" },
      fields: { input: { private: "DO_NOT_RETAIN_PAYLOAD" } },
    }
    const receipt = receipts.begin(review, event, "runtime")
    expect(receipt?.status).toBe("pending")
    expect(JSON.stringify(state.read())).not.toContain("DO_NOT_RETAIN_PAYLOAD")
    expect(() => new HookReceipts(state).begin(review, { ...event, id: "new-process" }, "reopened")).toThrow(
      "uncertain",
    )
    if (!receipt) throw new Error("Missing receipt")
    receipts.acknowledge(receipt.key)
    expect(new HookReceipts(state).begin(review, event, "reopened")).toBeUndefined()
    await writeFile(value.script, 'printf \'{"version":1,"decision":"deny"}\'\n')
    const changed = await reviewHook(value.config, "fixture", value.root)
    expect(hookTrusted(value.root, changed)).toBe(false)
    expect(changed.fingerprint).not.toBe(review.fingerprint)
    expect(receipts.begin(changed, event, "new-source")?.status).toBe("pending")
    expect(state.durable).toBe(false)
  } finally {
    await value.close()
  }
})

test("fixed handler commands receive JSON stdin and never inherit temporary write grants", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hooks-fixed-"))),
    cwd = join(root, "workspace"),
    outside = join(root, "outside.txt")
  await import("node:fs/promises").then(({ mkdir }) => mkdir(cwd))
  await writeFile(outside, "untouched")
  const sandbox = new NativeSandbox(createProfile(cwd, "workspace-write"))
  sandbox.grant({ resource: "write", target: outside, scope: "session" })
  const script = `const value = JSON.parse(await Bun.stdin.text());
let blocked = false;
try { await Bun.write(${JSON.stringify(outside)}, "changed") } catch { blocked = true }
let workspaceBlocked = false;
try { await Bun.write(${JSON.stringify(join(cwd, "effect.txt"))}, "changed") } catch { workspaceBlocked = true }
console.log(JSON.stringify({version: value.version, blocked, workspaceBlocked}));`
  try {
    const readonly = await sandbox.executeFixed(
      [process.execPath, "-e", script],
      '{"version":1}',
      AbortSignal.timeout(8000),
      { mode: "default", environment: [], timeoutMs: 5000, writeWorkspace: false },
    )
    expect(readonly.kind).toBe("success")
    expect(JSON.parse(readonly.stdout)).toEqual({ version: 1, blocked: true, workspaceBlocked: true })
    const writing = await sandbox.executeFixed(
      [process.execPath, "-e", script],
      '{"version":1}',
      AbortSignal.timeout(8000),
      { mode: "default", environment: [], timeoutMs: 5000, writeWorkspace: true },
    )
    expect(writing.kind).toBe("success")
    expect(JSON.parse(writing.stdout)).toEqual({ version: 1, blocked: true, workspaceBlocked: false })
    expect(await readFile(outside, "utf8")).toBe("untouched")
    const plan = await sandbox.executeFixed(
      [process.execPath, "-e", script],
      '{"version":1}',
      AbortSignal.timeout(8000),
      { mode: "plan", environment: [], timeoutMs: 5000, writeWorkspace: true },
    )
    expect(JSON.parse(plan.stdout).workspaceBlocked).toBe(true)
    await expect(
      sandbox.executeFixed(["/bin/cat"], "{}", AbortSignal.timeout(1000), {
        mode: "default",
        environment: ["UNGRANTED"],
        timeoutMs: 1000,
        writeWorkspace: false,
      }),
    ).rejects.toThrow("fixed sandbox grant")
  } finally {
    await sandbox.close()
    await rm(root, { recursive: true, force: true })
  }
}, 20000)
