import { expect, test } from "bun:test"
import { join } from "node:path"
import { atomic } from "../../src/core/session/files.ts"
import { Hub } from "../../src/server/hub.ts"
import { fetchShare, ShareStore } from "../../src/server/sharing.ts"
import { fixture } from "./fixture.ts"

test("sharing exports redacted native history, revokes bearer URLs and honors the kill switch", async () => {
  const f = await fixture(),
    hub = await Hub.open(f.options),
    client = hub.connect(() => {})
  let id = 0
  const rpc = async (method: string, params: unknown) => {
    const r = await hub.dispatch(client, { jsonrpc: "2.0", id: ++id, method, params })
    if (!r || "error" in r) throw Error(JSON.stringify(r))
    return r.result as Record<string, unknown>
  }
  const shares = new ShareStore(join(f.cwd, "shares"), "manual")
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(r) {
      return (await shares.route(r)) ?? new Response("Not found", { status: 404 })
    },
  })
  try {
    await rpc("initialize", { version: 1, client: "sharing-test" })
    const { threadId } = await rpc("thread/create", { cwd: f.cwd }),
      session = hub.threads.get(threadId as string)!.session!
    await session.prompt(`Discuss ${f.cwd} and person@example.com; api_key=private-secret-value`)
    const share = await shares.create(session.id, session, server.url.href)
    const bundle = await fetchShare(share.url)
    expect(bundle.payload.redacted).toBe(true)
    expect(JSON.stringify(bundle)).not.toContain(f.cwd)
    expect(JSON.stringify(bundle)).not.toContain("person@example.com")
    expect(JSON.stringify(bundle)).not.toContain("private-secret-value")
    await expect(shares.revoke("wrong-thread", share.shareId)).rejects.toThrow("another thread")
    await shares.revoke(session.id, share.shareId)
    await expect(fetchShare(share.url)).rejects.toThrow("unavailable")
    const second = await shares.create(session.id, session, server.url.href)
    atomic(join(shares.root, "disabled"), "operator kill switch")
    await expect(fetchShare(second.url)).rejects.toThrow("unavailable")
    await expect(shares.create(session.id, session, server.url.href)).rejects.toThrow("disabled")
  } finally {
    await server.stop(true)
    await shares.close()
    await hub.close()
    await f.clean()
  }
})
