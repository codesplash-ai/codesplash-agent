import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validateConfig } from "../../../src/core/config.ts"
import type { HookEvent } from "../../../src/core/hooks.ts"
import { MemorySessionState } from "../../../src/core/session/control.ts"
import { HookManager } from "../../../src/engines/codesplash/hooks/manager.ts"
import { reviewHook, trustHook } from "../../../src/engines/codesplash/hooks/trust.ts"
import { createProfile } from "../../../src/engines/codesplash/sandbox/profile.ts"
import { NativeSandbox } from "../../../src/engines/codesplash/sandbox/runtime.ts"
import { ToolOutputStore } from "../../../src/engines/codesplash/tool-output-store.ts"

test("real HTTP hooks bound sharing, credentials, redirects, response size, timeout and plan effects", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hooks-http-")))
  const credential = "fixture-hook-credential-1234"
  const received: Array<{ body: HookEvent; auth: string | null }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as HookEvent
      received.push({ body, auth: request.headers.get("authorization") })
      if (body.fields.text === "redirect")
        return new Response(null, { status: 307, headers: { location: "/reposted" } })
      if (body.fields.text === "oversize")
        return new Response(JSON.stringify({ version: 1, text: "x".repeat(129 * 1024) }))
      if (body.fields.text === "timeout") {
        await Bun.sleep(300)
        return Response.json({ version: 1, text: "LATE" })
      }
      return Response.json({ version: 1, text: `revised ${credential}` })
    },
  })
  const config = validateConfig(
    {
      hooks: {
        handlers: {
          fixture: {
            kind: "http",
            url: server.url.href,
            enabled: true,
            allowLoopback: true,
            bearerEnv: "HOOK_TOKEN",
            timeoutMs: 200,
            events: ["input.admit"],
            share: ["text", "transition"],
            allowTextRewrite: true,
          },
        },
      },
    },
    "fixture",
  )
  const sandbox = new NativeSandbox(createProfile(root, "workspace-write"))
  let mode: "default" | "plan" = "default"
  const manager = new HookManager({
    config,
    resolveConfig: async () => config,
    cwd: root,
    dataDir: root,
    sandbox,
    mode: () => mode,
    state: new MemorySessionState(),
    outputs: new ToolOutputStore(),
    env: { HOOK_TOKEN: credential },
  })
  const event = (text: string): HookEvent => ({
    version: 1,
    id: crypto.randomUUID(),
    name: "input.admit",
    sessionId: "fixture",
    turnId: "turn",
    generation: "fixture",
    metadata: {},
    fields: { text, cwd: "NOT-SHARED", transition: { password: "STRUCTURAL-SECRET", safe: "retained" } },
  })
  try {
    const review = await reviewHook(config, "fixture", root)
    trustHook(root, review, review.fingerprint)
    const result = await manager.dispatch(event("first"), AbortSignal.timeout(5000))
    expect(result.fields.text).toBe("revised [REDACTED]")
    expect(received[0]?.auth).toBe(`Bearer ${credential}`)
    expect(received[0]?.body.fields).toEqual({
      text: "first",
      transition: { password: "[REDACTED]", safe: "retained" },
    })
    await expect(manager.dispatch(event("redirect"), AbortSignal.timeout(5000))).rejects.toThrow(
      "redirects and retries",
    )
    expect(received).toHaveLength(2)
    await expect(manager.dispatch(event("oversize"), AbortSignal.timeout(5000))).rejects.toThrow("128 KiB")
    await expect(manager.dispatch(event("timeout"), AbortSignal.timeout(5000))).rejects.toThrow()
    mode = "plan"
    await expect(manager.dispatch(event("blocked"), AbortSignal.timeout(5000))).rejects.toThrow(
      "external effects",
    )
    expect(received).toHaveLength(4)
    expect(
      manager.receipts.list().filter((entry) => entry.status === "uncertain").length,
    ).toBeGreaterThanOrEqual(3)
  } finally {
    await manager.close()
    await sandbox.close()
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 10000)
