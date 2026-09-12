import type { SessionUsageSnapshot } from "../../../core/engine.ts"
import { TeamPanes } from "../../../core/orchestration/panes.ts"
import {
  type TeamDashboard,
  type TeamRequest,
  TeamStore,
  type TeamView,
  teamSpec,
} from "../../../core/orchestration/teams.ts"
import type { SessionStateAccess } from "../../../core/session/control.ts"
import { safeSessionText } from "../../../core/session/repository.ts"
import type { HarnessTool, ToolContext } from "../contracts.ts"
import type { NativeChildren } from "./children.ts"
import type { NativeCommands } from "./commands.ts"

export class NativeTeams {
  readonly store: TeamStore
  #panes?: TeamPanes
  #closed = false
  #busy = false
  constructor(
    readonly host: {
      root: boolean
      state: SessionStateAccess
      children: NativeChildren
      commands: NativeCommands
      usage(): SessionUsageSnapshot
      sanitize(text: string): string
      authorize(action: string, context?: ToolContext): Promise<void>
    },
  ) {
    this.store = new TeamStore(host.state)
  }
  #view(id: string): TeamView {
    const team = this.store.select(id),
      edges = this.host.children.mailbox.graph().filter((m) => m.team === team.id),
      tasks = this.host.commands.tasks.list()
    return {
      id: team.id,
      name: team.name,
      edges,
      members: [
        ...team.members.map((m) => {
          const peer = edges.find((p) => p.member === m.name)
          return {
            name: m.name,
            agent: m.agent,
            role: m.role,
            peer,
            task: tasks.find((t) => t.id === (m.task ?? peer?.task)),
          }
        }),
        ...edges
          .filter((p) => !team.members.some((m) => m.name === p.member))
          .map((peer) => ({
            name: peer.member ?? peer.id,
            agent: peer.agent,
            role: "delegate",
            peer,
            task: tasks.find((t) => t.id === peer.task),
          })),
      ],
    }
  }
  dashboard(): TeamDashboard {
    const state = this.store.read()
    return {
      coordinator: state.coordinator,
      teams: state.teams.map((t) => this.#view(t.id)),
      usage: this.host.usage(),
      panes: this.#panes?.status() ?? { available: !!Bun.which("tmux"), windows: [] },
    }
  }
  #row(team: string, member: string) {
    const view = this.#view(team),
      row = view.members.find((m) => m.name === member || m.peer?.id === member || m.task?.id === member)
    if (!row) throw new Error("Unknown member under this team")
    return { view, row }
  }
  #peek(team: string, member: string) {
    const { row } = this.#row(team, member)
    if (!row.task) return { ...row, output: "Member has not been dispatched" }
    try {
      const page = this.host.commands.output(row.task.id, 0, 4096)
      return {
        ...row,
        output:
          page.output.end > 4096
            ? this.host.commands.output(row.task.id, page.output.end - 4096, 4096).output.text
            : page.output.text,
      }
    } catch {
      return { ...row, output: "Live output unavailable after owner restart; inspect recorded child history" }
    }
  }
  async control(raw: unknown, context?: ToolContext): Promise<unknown> {
    if (!this.host.root)
      throw new Error("Team management belongs to the root owner; use scoped peer controls")
    if (this.#closed) throw new Error("Team owner closed")
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected team request")
    const v = raw as TeamRequest,
      fields: Record<string, string[]> = {
        list: [],
        create: ["spec"],
        delete: ["team"],
        coordinator: ["team"],
        peek: ["team", "member"],
        interrupt: ["team", "member"],
        reply: ["team", "member", "text"],
        dispatch: ["team", "member", "prompt", "reviewUncertain"],
        panes: ["team"],
        "close-panes": [],
      }
    if (!fields[v.action] || Object.keys(v).some((k) => k !== "action" && !fields[v.action]!.includes(k)))
      throw new Error("Invalid team action or field")
    if (v.action === "close-panes") {
      await this.#panes?.close()
      this.#panes = undefined
      return this.dashboard()
    }
    await this.host.authorize(v.action, context)
    if (v.action === "list") return this.dashboard()
    if (v.action === "create") {
      const spec = teamSpec(v.spec)
      for (const m of spec.members) {
        m.prompt = this.host.sanitize(m.prompt)
        m.role = this.host.sanitize(m.role)
      }
      return this.store.create(spec)
    }
    if (v.action === "coordinator") return this.store.coordinator(v.team)
    if (typeof v.team !== "string" || v.team.length > 128) throw new Error("Expected owned team")
    const team = this.store.select(v.team)
    if (v.action === "panes") {
      this.#panes ??= new TeamPanes(this.host.children.mailbox, (id) => {
        const view = this.#view(id)
        const brief = (text: string, bytes: number) =>
          Buffer.from(safeSessionText(text)).subarray(0, bytes).toString("utf8")
        return {
          id: view.id,
          name: view.name,
          members: view.members.map((m) => ({
            name: m.name,
            role: brief(m.role, 96),
            agent: brief(m.agent, 128),
            parent: m.peer?.parent,
            status: m.task?.status ?? "idle",
            usage: m.peer?.usage,
            output: brief(this.#peek(id, m.name).output, 256),
          })),
        }
      })
      return this.#panes.open(team.id)
    }
    if (v.action === "delete") {
      const tasks = this.host.commands.tasks.list(),
        ids = new Set([
          ...team.members.map((m) => m.task),
          ...this.host.children.mailbox
            .graph()
            .filter((m) => m.team === team.id)
            .map((m) => m.task),
        ])
      if (tasks.some((t) => ids.has(t.id) && ["running", "queued", "execution-uncertain"].includes(t.status)))
        throw new Error("Stop or review team work before deletion")
      if (this.#panes?.status().windows.some((w) => w.team === team.id))
        throw new Error("Close team panes before deletion")
      this.store.remove(team.id)
      return { deleted: team.id }
    }
    if (typeof v.member !== "string" || v.member.length > 128) throw new Error("Expected team member")
    const { row } = this.#row(team.id, v.member)
    if (v.action === "peek") return this.#peek(team.id, v.member)
    if (v.action === "reply") {
      if (!row.peer) throw new Error("Dispatch the member before sending data")
      return this.host.children.mailbox.send(
        "root",
        row.peer.id,
        this.host.sanitize(typeof v.text === "string" ? v.text : ""),
      )
    }
    if (v.action === "interrupt") {
      if (!row.task) throw new Error("Member has no task")
      this.host.commands.tasks.interrupt(row.task.id)
      return { interrupted: row.task.id }
    }
    if (v.action !== "dispatch") throw new Error("Unknown team action")
    if (this.#busy) throw new Error("Another team dispatch is being admitted")
    if (!context?.runInternal) throw new Error("Dispatch requires native child admission")
    if (row.task && ["running", "queued"].includes(row.task.status))
      throw new Error("Member still has active work")
    const definition = team.members.find((m) => m.name === row.name)
    if (!definition) throw new Error("Nested delegates are resumed by their owning coordinator")
    if (v.reviewUncertain !== undefined && typeof v.reviewUncertain !== "boolean")
      throw new Error("Invalid review flag")
    const prompt = v.prompt ?? definition.prompt
    if (
      typeof prompt !== "string" ||
      !prompt.trim() ||
      prompt.includes("\0") ||
      Buffer.byteLength(prompt) > 4096
    )
      throw new Error("Team dispatch prompt requires 1–4096 bytes")
    this.#busy = true
    this.host.children.teamAdmission = { team: team.id, member: definition.name }
    try {
      const result = await context.runInternal("agent", {
        agent: definition.agent,
        persona: definition.role,
        prompt,
        ...(row.peer
          ? {
              resume: row.peer.id,
              ...(v.reviewUncertain !== undefined ? { reviewUncertain: v.reviewUncertain } : {}),
            }
          : {}),
        background: true,
      })
      if (result.isError) throw new Error(result.text)
      const task = JSON.parse(result.text).task.id as string
      this.store.dispatched(team.id, definition.name, task)
      return { team: team.id, member: definition.name, task }
    } finally {
      this.host.children.teamAdmission = undefined
      this.#busy = false
    }
  }
  tools(): HarnessTool[] {
    return [
      {
        name: "teams",
        description:
          "Manage bounded named teams. Reply queues data; dispatch explicitly runs/resumes a native child. Inspect live dashboard, peek, interrupt, select root coordinator mode, or open optional read-only tmux views.",
        effects: "external",
        isReadOnly: () => true,
        alwaysAsk: (raw) =>
          ["create", "dispatch", "coordinator", "panes", "delete"].includes((raw as TeamRequest)?.action),
        permission: (raw) =>
          ["list", "peek", "reply", "interrupt", "close-panes"].includes((raw as TeamRequest)?.action)
            ? { kind: "none" }
            : { kind: "approval", title: "Control native team?", detail: JSON.stringify(raw) },
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "list",
                "create",
                "delete",
                "coordinator",
                "peek",
                "reply",
                "dispatch",
                "interrupt",
                "panes",
                "close-panes",
              ],
            },
            team: { type: "string" },
            member: { type: "string" },
            text: { type: "string", maxLength: 16384 },
            prompt: { type: "string", maxLength: 4096 },
            reviewUncertain: { type: "boolean" },
            spec: {
              type: "object",
              properties: {
                name: { type: "string" },
                members: {
                  type: "array",
                  maxItems: 16,
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      agent: { type: "string" },
                      role: { type: "string" },
                      prompt: { type: "string" },
                    },
                    required: ["name", "agent", "role", "prompt"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["name", "members"],
              additionalProperties: false,
            },
          },
          required: ["action"],
          additionalProperties: false,
        },
        run: async (raw, context) => ({
          label: "Teams",
          text: JSON.stringify(await this.control(raw, context)),
        }),
      },
    ]
  }
  async close() {
    this.#closed = true
    await this.#panes?.close()
  }
}
