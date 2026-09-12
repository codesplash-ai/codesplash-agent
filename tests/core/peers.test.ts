import { expect, test } from "bun:test"
import { createConnection } from "node:net"
import { PeerEndpoint, sendPeerEndpoint } from "../../src/core/orchestration/peer-socket.ts"
import { PeerMailbox } from "../../src/core/orchestration/peers.ts"
import { MemorySessionState } from "../../src/core/session/control.ts"

const mailbox = () => new PeerMailbox(crypto.randomUUID(), new MemorySessionState())
test("peer mailboxes preserve attribution, bound admission and recover queued intent", () => {
  const box = mailbox(),
    id = crypto.randomUUID(),
    task = crypto.randomUUID()
  box.register({ id, task, parent: box.root, agent: "explore" })
  box.send(box.root, task, "A")
  expect(box.inbox(id)[0]?.sender).toBe(box.root)
  const reopened = new PeerMailbox(box.root, box.state)
  expect(reopened.inbox(id, true).map((m) => m.text)).toEqual(["A"])
  expect(box.inbox(id)).toEqual([])
  expect(() => box.send("spoofed", id, "bad")).toThrow("Unknown")
  expect(() => box.send(box.root, id, "x".repeat(16385))).toThrow("16384")
  for (let i = 0; i < 256; i++) box.send(box.root, id, "queued")
  expect(() => box.send(box.root, id, "overflow")).toThrow("full")
  expect(box.inbox(id, true)).toHaveLength(16)
})
test("real Unix endpoints authenticate, label external senders and refuse stale sockets", async () => {
  const box = mailbox(),
    endpoint = new PeerEndpoint(box)
  const opened = await endpoint.open()
  try {
    await sendPeerEndpoint(opened.endpoint, "root", "EXTERNAL_MESSAGE")
    expect(box.inbox("root")[0]).toMatchObject({
      text: "EXTERNAL_MESSAGE",
      sender: "external capability holder",
      external: true,
    })
    const value = (await Bun.file(opened.endpoint).json()) as { socket: string }
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(value.socket),
        chunks: string[] = []
      socket.on("error", reject)
      socket.on("data", (b) => chunks.push(b.toString()))
      socket.on("end", () => resolve(chunks.join("")))
      socket.on("connect", () =>
        socket.write(
          `${JSON.stringify({ version: 1, token: "0".repeat(64), target: "root", text: "forged" })}\n`,
        ),
      )
    })
    expect(reply).toContain('"ok":false')
    expect(box.inbox("root")).toHaveLength(1)
  } finally {
    await endpoint.close()
  }
  await expect(sendPeerEndpoint(opened.endpoint, "root", "stale")).rejects.toThrow()
})
