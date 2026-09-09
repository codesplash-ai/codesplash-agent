import { expect, test } from "bun:test"
import { BranchStore, validNativeContext } from "../../src/core/session/branches.ts"
import type { ChatMessage } from "../../src/engines/codesplash/contracts.ts"

const messages = (text: string): ChatMessage[] => [{ role: "user", content: [{ type: "text", text }] }]
const metadata = { kind: "turn" as const, label: "turn", eventSequence: 1, usage: {} }
test("retained context keeps displaced branches and exact opaque blocks through compaction", () => {
  const store = new BranchStore(),
    first = store.capture({ ...metadata, messages: messages("original") })
  const opaque: ChatMessage[] = [
    ...messages("original"),
    {
      role: "assistant",
      content: [
        { type: "thinking", text: "reasoning", signature: "raw-signature" },
        { type: "tool_call", id: "tool", name: "read_file", input: { path: "a" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", toolCallId: "tool", text: "result" },
        { type: "image", mediaType: "image/png", base64Data: "RAW-BYTES" },
      ],
    },
  ]
  const second = store.capture({ ...metadata, messages: opaque })
  store.capture({ ...metadata, kind: "compaction", messages: messages("summary") })
  expect(store.context(second.id)).toEqual(opaque)
  store.prepareSwitch(first.id, store.view().revision)
  expect(store.view().switch?.to).toBe(first.id)
  store.finishSwitch()
  const branch = store.capture({ ...metadata, messages: messages("alternate") })
  expect(branch.parent).toBe(first.id)
  expect(store.context(second.id)).toEqual(opaque)
  expect(store.view().nodes).toHaveLength(4)
})
test("branch guards refuse incomplete exchanges, stale head switches and pruning live ancestry", () => {
  const store = new BranchStore(),
    first = store.capture({ ...metadata, messages: messages("first") })
  const revision = store.view().revision
  const second = store.capture({ ...metadata, messages: messages("second") })
  expect(() => store.prepareSwitch(first.id, revision)).toThrow("changed")
  expect(() => store.prune([first.id], store.view().revision)).toThrow("abandoned")
  expect(
    validNativeContext([
      { role: "assistant", content: [{ type: "tool_call", id: "pending", name: "write_file", input: {} }] },
    ]),
  ).toBe(false)
  store.prepareSwitch(first.id, store.view().revision)
  store.finishSwitch()
  expect(store.prune([second.id], store.view().revision).removed).toEqual([second.id])
  expect(() => store.context(second.id)).toThrow("not found")
})

test("durable forks publish independent context/evidence without copying billable usage or grants", async () => {
  const { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { SessionStore, readSessionEvents } = await import("../../src/core/sessions.ts")
  const { createAgentEvent } = await import("../../src/core/events.ts")
  const { forkLocalSession } = await import("../../src/core/session/fork.ts")
  const root = mkdtempSync(join(tmpdir(), "m5-fork-"))
  const handle = await new SessionStore(root).create({
    schemaVersion: 2,
    engine: "codesplash",
    localSessionId: "parent",
    projectId: "project",
    projectPath: "/project",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastStatus: "closed",
    lastSequence: -1,
  })
  handle.acquire()
  try {
    const event = createAgentEvent(
      { engine: "codesplash", localSessionId: "parent", sequence: 0 },
      { kind: "user.message", payload: { id: "u1", text: "original" } },
    )
    const usage = createAgentEvent(
      { engine: "codesplash", localSessionId: "parent", sequence: 1 },
      { kind: "usage.updated", payload: { estimatedCostUsd: 2, inputTokens: 100 } },
    )
    await handle.appendEventLines([JSON.stringify(event), JSON.stringify(usage)])
    writeFileSync(join(handle.directory, "sandbox-profile.json"), "source policy")
    mkdirSync(join(handle.directory, "tool-outputs"))
    const outputId = crypto.randomUUID(),
      output = "retained output".repeat(100000)
    writeFileSync(join(handle.directory, "tool-outputs", outputId), output)
    const branches = new BranchStore(handle.state)
    const node = branches.capture({
      ...metadata,
      messages: messages("original"),
      eventSequence: 1,
      usage: { estimatedCostUsd: 2 },
      notes: { todo: "retain this note" },
    })
    const fork = await forkLocalSession(branches, node.id)
    const child = await new SessionStore(root).open("project", fork.localSessionId)
    const graph = new BranchStore(child.state)
    expect(graph.context()).toEqual(messages("original"))
    expect(graph.view().origin).toMatchObject({
      sessionId: "parent",
      inheritedUsage: { estimatedCostUsd: 2 },
    })
    expect(graph.node().notes).toEqual({ todo: "retain this note" })
    const replay = await readSessionEvents(child.directory)
    expect(replay.events.map((event) => event.kind)).toEqual(["user.message"])
    expect(replay.events[0]?.localSessionId).toBe(fork.localSessionId)
    expect(existsSync(join(child.directory, "sandbox-profile.json"))).toBe(false)
    expect(readFileSync(join(child.directory, "tool-outputs", outputId), "utf8")).toBe(output)
    child.acquire()
    graph.capture({ ...metadata, messages: messages("independent child") })
    child.release()
    expect(branches.context(node.id)).toEqual(messages("original"))
  } finally {
    handle.release()
    rmSync(root, { recursive: true, force: true })
  }
})
