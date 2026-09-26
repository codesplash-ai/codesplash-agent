import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { pullRequestReference } from "../../src/commands/pr.ts"
import { parseDeepLink } from "../../src/server/deep-link.ts"
import { advertisement } from "../../src/server/discovery.ts"
import { Hub } from "../../src/server/hub.ts"
import { fileHyperlink, markdownFileCitations } from "../../src/server/hyperlinks.ts"
import { generatedContract } from "../../src/server/protocol.ts"
import { vscodePackage } from "../../src/server/vsix.ts"
import { webClient } from "../../src/server/web.ts"
import { fixture } from "./fixture.ts"

test("generated contracts, bundled editor package and browser script are executable", () => {
  const packet = advertisement(4096, "192.0.2.1", "fixture")
  expect(packet.readUInt16BE(6)).toBe(4)
  expect(packet.toString()).toContain("auth=required")
  expect(() => advertisement(0, "0.0.0.0", "fixture")).toThrow()
  const contract = generatedContract()
  expect(contract.types).toContain('"turn/start"')
  expect(contract.openapi.paths["/rpc"]).toBeDefined()
  expect(vscodePackage().readUInt32LE(0)).toBe(0x04034b50)
  expect(vscodePackage().toString()).toContain("codesplash.attach")
  const script = webClient.match(/<script>([\s\S]*)<\/script>/)![1]!
  expect(() => new Function(script)).not.toThrow()
})
test("deep links, PR references and terminal citations cannot encode commands or escape workspace", () => {
  const id = randomUUID()
  expect(parseDeepLink(`codesplash://session/${id}`).threadId).toBe(id)
  for (const url of [
    `codesplash://session/${id}?prompt=run`,
    `codesplash://user@session/${id}`,
    `codesplash://session:80/${id}`,
  ])
    expect(() => parseDeepLink(url)).toThrow()
  expect(pullRequestReference("https://github.com/a/b/pull/1")).toEqual({ repository: "a/b", number: 1 })
  expect(() => pullRequestReference("https://evil.example/a/b/pull/1")).toThrow()
  expect(markdownFileCitations("See `src/test.ts:12`", "/workspace")).toBe(
    "See [src/test.ts:12](<file:///workspace/src/test.ts#L12>)",
  )
  expect(markdownFileCitations("../secret.ts:1", "/workspace")).toBe("../secret.ts:1")
  expect(fileHyperlink("x\x1b]52;;bad", "/workspace", "x.ts")).not.toContain("\x1b")
})
test("approval callbacks require the current writer and a single decision; snapshots stay immutable", async () => {
  const f = await fixture(true),
    hub = await Hub.open(f.options)
  const a = hub.connect(() => {}),
    b = hub.connect(() => {})
  let id = 0
  const rpc = async (client: typeof a, method: string, params = {}, key = ++id) => {
    const result = await hub.dispatch(client, { jsonrpc: "2.0", id: key, method, params })
    if (!result || "error" in result) throw new Error(JSON.stringify(result))
    return result.result as any
  }
  try {
    await rpc(a, "initialize", { version: 1, client: "writer" })
    await rpc(b, "initialize", { version: 1, client: "reader" })
    const { threadId, inputEpoch } = await rpc(a, "thread/create", { cwd: f.cwd })
    const before = await rpc(a, "thread/snapshot", { threadId }, 1000)
    const { lease } = await rpc(a, "lease/acquire", { threadId, mode: "shared" })
    const ack = await rpc(a, "turn/start", {
      threadId,
      lease,
      text: "write a file",
      submissionId: `${inputEpoch}.approval`,
    })
    let pending: any[] = []
    for (let tries = 0; tries < 100; tries++) {
      pending = (await rpc(a, "thread/snapshot", { threadId })).pending
      if (pending.length) break
      await Bun.sleep(10)
    }
    expect(pending.length).toBe(1)
    expect(existsSync(join(f.cwd, "approved.txt"))).toBe(false)
    await expect(
      rpc(b, "request/respond", { threadId, lease, requestId: pending[0].id, choice: "accept" }),
    ).rejects.toThrow("lease")
    await rpc(a, "request/respond", { threadId, lease, requestId: pending[0].id, choice: "accept" })
    await hub.threads.get(threadId)!.session!.waitForInput(ack.id)
    expect(await readFile(join(f.cwd, "approved.txt"), "utf8")).toContain("approved")
    await expect(
      rpc(a, "request/respond", { threadId, lease, requestId: pending[0].id, choice: "accept" }),
    ).rejects.toThrow("stale")
    expect(await rpc(a, "thread/snapshot", { threadId }, 1000)).toEqual(before)
    expect((await rpc(a, "thread/snapshot", { threadId })).pending).toEqual([])
  } finally {
    await hub.close()
    await f.clean()
  }
}, 30000)
