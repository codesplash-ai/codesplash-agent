import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentEvent } from "../../src/core/events.ts"
import { create } from "../../src/sdk/runtime.ts"
import { type Connection, Hub } from "../../src/server/hub.ts"
import { publicEvent } from "../../src/server/protocol.ts"
import { ndjson, serve } from "../../src/server/transport.ts"
import { fixture } from "./fixture.ts"

let sequence = 0
async function rpc(hub: Hub, c: Connection, method: string, params = {}, id: string | number = ++sequence) {
  const response = await hub.dispatch(c, { jsonrpc: "2.0", id, method, params })
  if (response && "error" in response) throw new Error(`${response.error.code}: ${response.error.message}`)
  return response && "result" in response ? (response.result as Record<string, unknown>) : {}
}
test("native owner negotiates, serializes writers, deduplicates turns and resumes without effects", async () => {
  const f = await fixture()
  let hub = await Hub.open(f.options)
  try {
    const notices: unknown[] = [],
      a = hub.connect((n) => notices.push(n)),
      b = hub.connect(() => {})
    await expect(rpc(hub, a, "thread/list")).rejects.toThrow("Initialize")
    await rpc(hub, a, "initialize", { version: 1, client: "test" })
    await rpc(hub, b, "initialize", { version: 1, client: "test2" })
    await expect(rpc(hub, a, "thread/create", { cwd: "/" })).rejects.toThrow("outside")
    const { threadId, inputEpoch } = await rpc(hub, a, "thread/create", { cwd: f.cwd })
    const lease = (await rpc(hub, a, "lease/acquire", { threadId, mode: "exclusive" })).lease
    await expect(rpc(hub, b, "lease/acquire", { threadId, mode: "shared" })).rejects.toThrow("conflict")
    const start = { threadId, lease, text: "hi", submissionId: `${inputEpoch}.once` }
    const one = await rpc(hub, a, "turn/start", start, "same")
    expect(await rpc(hub, a, "turn/start", start, "same")).toEqual(one)
    await hub.threads.get(threadId as string)!.session!.waitForInput(one.id as string)
    expect(f.calls()).toBe(1)
    await expect(rpc(hub, a, "turn/start", { ...start, text: "changed" }, "same")).rejects.toThrow("reused")
    const stolen = (await rpc(hub, b, "lease/acquire", { threadId, mode: "exclusive", steal: true })).lease
    await expect(rpc(hub, a, "turn/interrupt", { threadId, lease })).rejects.toThrow("lease")
    await rpc(hub, b, "lease/release", { threadId, lease: stolen })
    expect(JSON.stringify(notices)).toContain("served")
    await hub.close()
    hub = await Hub.open(f.options)
    const c = hub.connect(() => {})
    await rpc(hub, c, "initialize", { version: 1, client: "resumed" })
    const snapshot = await rpc(hub, c, "thread/snapshot", { threadId })
    expect(snapshot.live).toBe(false)
    expect(JSON.stringify(snapshot)).toContain("served")
    await rpc(hub, c, "thread/resume", { threadId })
    expect(f.calls()).toBe(1)
    expect((await rpc(hub, c, "thread/snapshot", { threadId })).pending).toEqual([])
  } finally {
    await hub.close()
    await f.clean()
  }
})
test("public events remove reasoning, raw payloads and credential fields", () => {
  const env = { engine: "codesplash" as const, localSessionId: "id", sequence: 0 }
  expect(
    publicEvent(createAgentEvent(env, { kind: "reasoning.delta", payload: { id: "r", text: "private" } })),
  ).toBeUndefined()
  const e = createAgentEvent(env, {
    kind: "message.delta",
    payload: { id: "a", text: "Bearer fixture-secret" },
  })
  e.raw = { secret: "leak" }
  expect(JSON.stringify(publicEvent(e))).not.toContain("fixture-secret")
  expect(JSON.stringify(publicEvent(e))).not.toContain("leak")
})
test("NDJSON handles fragmented UTF8, blank lines, trailing frames and bounds before parsing", async () => {
  const frame = Buffer.from('\n{"text":"héllo"}\n{"ok":true}')
  async function* chunks() {
    for (const byte of frame) yield new Uint8Array([byte])
  }
  expect(await Array.fromAsync(ndjson(chunks()))).toEqual([{ text: "héllo" }, { ok: true }])
  await expect(Array.fromAsync(ndjson(chunks(), 4))).rejects.toThrow("limit")
})
test("HTTP requires auth and same origin, locks ownership, and initializes versioned connections", async () => {
  const f = await fixture(),
    token = "test".repeat(10)
  const daemon = await serve({ ...f.options, port: 0, token })
  try {
    await expect(serve({ ...f.options, port: 0, token })).rejects.toThrow("active")
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { version: 1, client: "http" },
    })
    const headers = { "content-type": "application/json", authorization: `Bearer ${token}` }
    expect((await fetch(`${daemon.url}rpc`, { method: "POST", body })).status).toBe(401)
    expect(
      (
        await fetch(`${daemon.url}rpc`, {
          method: "POST",
          headers: { ...headers, origin: "https://evil.example" },
          body,
        })
      ).status,
    ).toBe(403)
    const init = await (await fetch(`${daemon.url}rpc`, { method: "POST", headers, body })).json()
    expect(init.result.version).toBe(1)
    const pair = await (await fetch(`${daemon.url}pair`, { method: "POST", headers })).json()
    const paired = await fetch(`${daemon.url}auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: pair.code }),
    })
    expect(paired.status).toBe(200)
    expect(paired.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict")
    expect(
      (
        await fetch(`${daemon.url}auth`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: pair.code }),
        })
      ).status,
    ).toBe(401)
  } finally {
    await daemon.close()
    await f.clean()
  }
})
