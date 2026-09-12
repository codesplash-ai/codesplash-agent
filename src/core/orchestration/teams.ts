import type { SessionUsageSnapshot } from "../engine.ts"
import type { SessionStateAccess } from "../session/control.ts"
import type { PeerMember } from "./peers.ts"
import type { TaskRecord } from "./tasks.ts"

export type TeamMember = { name: string; agent: string; role: string; prompt: string; task?: string }
export type TeamSpec = { name: string; members: Omit<TeamMember, "task">[] }
export type TeamRecord = Omit<TeamSpec, "members"> & { id: string; members: TeamMember[] }
export type TeamRow = { name: string; agent: string; role: string; peer?: PeerMember; task?: TaskRecord }
export type TeamView = { id: string; name: string; members: TeamRow[]; edges: PeerMember[] }
export type TeamDashboard = {
  coordinator?: string
  teams: TeamView[]
  usage: SessionUsageSnapshot
  panes: { available: boolean; windows: { team: string; window: string }[]; socket?: string }
}
export type TeamRequest =
  | { action: "list" }
  | { action: "create"; spec: TeamSpec }
  | { action: "delete"; team: string }
  | { action: "coordinator"; team?: string }
  | { action: "peek" | "interrupt"; team: string; member: string }
  | { action: "reply"; team: string; member: string; text: string }
  | { action: "dispatch"; team: string; member: string; prompt?: string; reviewUncertain?: boolean }
  | { action: "panes"; team: string }
  | { action: "close-panes" }
type Journal = { version: 1; coordinator?: string; teams: TeamRecord[] }
export const teamName = (v: unknown): v is string =>
  typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v)
const uuid = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)
export function teamSpec(raw: unknown): TeamSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected team specification")
  const v = raw as TeamSpec
  if (
    Object.keys(v).some((k) => !["name", "members"].includes(k)) ||
    !teamName(v.name) ||
    !Array.isArray(v.members) ||
    !v.members.length ||
    v.members.length > 16
  )
    throw new Error("Team requires a literal name and 1–16 members")
  const names = new Set<string>()
  for (const m of v.members) {
    if (
      !m ||
      Object.keys(m).some((k) => !["name", "agent", "role", "prompt"].includes(k)) ||
      !teamName(m.name) ||
      names.has(m.name)
    )
      throw new Error("Invalid or duplicate team member")
    names.add(m.name)
    for (const [key, limit] of [
      ["agent", 256],
      ["role", 512],
      ["prompt", 4096],
    ] as const)
      if (
        typeof m[key] !== "string" ||
        !m[key].trim() ||
        m[key].includes("\0") ||
        Buffer.byteLength(m[key]) > limit
      )
        throw new Error(`Invalid team member ${key}`)
  }
  return structuredClone(v)
}
export class TeamStore {
  constructor(readonly state: SessionStateAccess) {}
  read(): Journal {
    const raw = this.state.read().state.values.teams as Journal | undefined
    if (!raw) return { version: 1, teams: [] }
    if (
      raw.version !== 1 ||
      Object.keys(raw).some((k) => !["version", "coordinator", "teams"].includes(k)) ||
      !Array.isArray(raw.teams) ||
      raw.teams.length > 8 ||
      Buffer.byteLength(JSON.stringify(raw)) > 128 * 1024
    )
      throw new Error("Corrupt team journal")
    const ids = new Set<string>(),
      names = new Set<string>()
    for (const team of raw.teams) {
      if (
        !team ||
        !uuid(team.id) ||
        ids.has(team.id) ||
        names.has(team.name) ||
        Object.keys(team).some((k) => !["id", "name", "members"].includes(k)) ||
        !Array.isArray(team.members)
      )
        throw new Error("Corrupt team identity")
      ids.add(team.id)
      names.add(team.name)
      teamSpec({
        name: team.name,
        members: team.members.map(({ task, ...m }) => {
          if (task !== undefined && !uuid(task)) throw new Error("Corrupt team task")
          return m
        }),
      })
    }
    if (raw.coordinator !== undefined && !ids.has(raw.coordinator))
      throw new Error("Corrupt coordinator selection")
    return structuredClone(raw)
  }
  #update(change: (v: Journal) => void) {
    const before = this.state.read(),
      v = this.read()
    change(v)
    if (Buffer.byteLength(JSON.stringify(v)) > 128 * 1024) throw new Error("Team journal byte limit reached")
    this.state.update(before.revision, "teams/update", (state) => {
      state.values.teams = v
    })
  }
  select(id: string): TeamRecord {
    const team = this.read().teams.find((t) => t.id === id || t.name === id)
    if (!team) throw new Error("Unknown owned team")
    return team
  }
  create(raw: unknown) {
    const spec = teamSpec(raw),
      team: TeamRecord = { ...spec, id: crypto.randomUUID() }
    this.#update((v) => {
      if (v.teams.length >= 8 || v.teams.some((t) => t.name === spec.name))
        throw new Error("Team name exists or team limit reached")
      v.teams.push(team)
    })
    return team
  }
  dispatched(id: string, member: string, task: string) {
    if (!uuid(task)) throw new Error("Invalid dispatched task")
    this.#update((v) => {
      const m = v.teams.find((t) => t.id === id)?.members.find((m) => m.name === member)
      if (!m) throw new Error("Unknown team member")
      m.task = task
    })
  }
  coordinator(id?: string) {
    const team = id === undefined ? undefined : this.select(id)
    this.#update((v) => {
      v.coordinator = team?.id
    })
    return { coordinator: team?.id }
  }
  remove(id: string) {
    const team = this.select(id)
    this.#update((v) => {
      if (v.coordinator === team.id) throw new Error("Leave coordinator mode before deleting its team")
      v.teams = v.teams.filter((t) => t.id !== team.id)
    })
  }
}
export const coordinatorTools = new Set([
  "teams",
  "agent",
  "list_agents",
  "peers",
  "send_message",
  "wait_agent",
  "interrupt_agent",
  "task_output",
  "task_wait",
  "task_monitor",
  "task_kill",
  "ask_user",
])
