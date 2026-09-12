import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { TeamPanes } from "../../src/core/orchestration/panes.ts"
import { queryPeerEndpoint, sendPeerEndpoint } from "../../src/core/orchestration/peer-socket.ts"
import { PeerMailbox } from "../../src/core/orchestration/peers.ts"
import { TeamStore, teamSpec } from "../../src/core/orchestration/teams.ts"
import { MemorySessionState } from "../../src/core/session/control.ts"

const spec = {
  name: "review",
  members: [{ name: "worker", agent: "builtin/general", role: "reviewer", prompt: "Inspect evidence" }],
}
test("team rosters validate exact bounded definitions, task lineage and coordinator recovery", () => {
  const state = new MemorySessionState(),
    store = new TeamStore(state),
    team = store.create(spec),
    task = crypto.randomUUID()
  expect(() => store.create(spec)).toThrow("name")
  expect(() => teamSpec({ ...spec, permission: "bypass" })).toThrow()
  expect(() => teamSpec({ ...spec, members: [...spec.members, ...spec.members] })).toThrow("duplicate")
  expect(() => teamSpec({ ...spec, name: "../escape" })).toThrow()
  store.dispatched(team.id, "worker", task)
  store.coordinator(team.id)
  expect(new TeamStore(state).read()).toMatchObject({
    coordinator: team.id,
    teams: [{ members: [{ task }] }],
  })
  expect(() => store.remove(team.id)).toThrow("coordinator")
  store.coordinator()
  store.remove(team.id)
  expect(store.read().teams).toHaveLength(0)
  for (let i = 0; i < 8; i++) store.create({ ...spec, name: `team${i}` })
  expect(() => store.create({ ...spec, name: "overflow" })).toThrow("limit")
})
test("peer routing isolates named teams and keeps inclusive usage and identities across resume", () => {
  const box = new PeerMailbox(crypto.randomUUID(), new MemorySessionState()),
    a = crypto.randomUUID(),
    b = crypto.randomUUID()
  const member = (team?: string) => ({
    id: crypto.randomUUID(),
    task: crypto.randomUUID(),
    parent: box.root,
    agent: "general",
    ...(team ? { team, member: crypto.randomUUID() } : {}),
  })
  const first = member(a),
    second = member(a),
    other = member(b),
    ungrouped = member()
  for (const m of [first, second, other, ungrouped]) box.register(m)
  box.send(first.id, second.id, "same team")
  box.send(first.id, "root", "report")
  expect(() => box.send(first.id, other.id, "cross team")).toThrow("outside")
  expect(() => box.send(ungrouped.id, first.id, "cross team")).toThrow("outside")
  expect(box.graph(first.id).map((m) => m.id)).toEqual([first.id, second.id])
  expect(box.graph()).toHaveLength(4)
  box.addUsage(first.id, { inputTokens: 4, outputTokens: 2 })
  box.register({ ...first, task: crypto.randomUUID() })
  box.addUsage(first.id, { inputTokens: 3, outputTokens: 1 })
  expect(box.graph()[0]?.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 })
  expect(() => box.register({ ...first, team: b })).toThrow("membership")
  for (let i = 2; i < 16; i++) box.register(member(a))
  expect(() => box.register(member(a))).toThrow("limit")
})
test("actual private tmux viewer uses read-only capability and closes only its owned server", async () => {
  const box = new PeerMailbox(crypto.randomUUID(), new MemorySessionState()),
    team = crypto.randomUUID(),
    panes = new TeamPanes(box, (id) => {
      if (id !== team) throw new Error("Unknown team")
      return { name: "TEAM_PANE_MARKER", members: [] }
    })
  if (!Bun.which("tmux")) {
    expect(panes.status().available).toBe(false)
    await expect(panes.open(team)).rejects.toThrow("unavailable")
    await panes.close()
    return
  }
  let endpoint = ""
  try {
    const status = await panes.open(team)
    endpoint = panes.endpoint.path
    expect(status.windows).toHaveLength(1)
    expect(await queryPeerEndpoint(endpoint, team)).toMatchObject({ name: "TEAM_PANE_MARKER" })
    await expect(sendPeerEndpoint(endpoint, "root", "cannot send through viewer")).rejects.toThrow()
    let captured = "",
      end = Date.now() + 10000
    while (Date.now() < end) {
      captured = await panes.command(["capture-pane", "-p", "-t", status.windows[0]!.window])
      if (captured.includes("TEAM_PANE_MARKER")) break
      await Bun.sleep(100)
    }
    expect(captured).toContain("TEAM_PANE_MARKER")
    expect(box.inbox("root")).toHaveLength(0)
  } finally {
    await panes.close()
  }
  expect(existsSync(panes.socket)).toBe(false)
  await expect(queryPeerEndpoint(endpoint, team)).rejects.toThrow()
}, 30000)
test("closing during pane startup revokes the capability without leaving an owner", async () => {
  const box = new PeerMailbox(crypto.randomUUID(), new MemorySessionState()),
    panes = new TeamPanes(box, () => ({ ready: true }))
  const opening = panes.open(crypto.randomUUID()).catch(() => undefined)
  await panes.close()
  await opening
  expect(panes.status().windows).toHaveLength(0)
  await expect(queryPeerEndpoint(panes.endpoint.path, "closed")).rejects.toThrow()
})
