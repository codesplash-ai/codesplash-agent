import { join } from "node:path"
import {
  type AutomationJournal,
  type AutomationRecord,
  type AutomationStep,
  boundedText,
  limitsOf,
  object,
  type WorkflowDefinition,
  workflowFingerprint,
  workflowOf,
} from "../../../core/orchestration/automation.ts"
import type { TaskContext } from "../../../core/orchestration/tasks.ts"
import { bytes } from "../../../core/session/files.ts"
import type { HarnessTool } from "../contracts.ts"
import type { NativeChildren } from "./children.ts"
import type { NativeCommands } from "./commands.ts"
import { ChildBudget } from "./scope.ts"

type Host = {
  journal: AutomationJournal
  children: NativeChildren
  commands: NativeCommands
  root: boolean
  cwd: string
  identity(): Promise<string>
  canRead(path: string): Promise<boolean>
  admit(
    name: "agent" | "exec_command",
    input: unknown,
    parent: string,
    budget: ChildBudget,
    signal: AbortSignal,
  ): Promise<unknown>
}
const active = (s: string) => s === "queued" || s === "running"
const short = (text: string) => Buffer.from(text).subarray(0, 1024).toString("utf8")
export class NativeAutomation {
  readonly #live = new Map<string, Promise<unknown>>()
  #closed = false
  constructor(readonly host: Host) {
    host.journal.recover()
  }
  #get(id: string) {
    const record = this.host.journal.list().find((r) => r.id === id)
    if (!record) throw new Error("Unknown automation record")
    return record
  }
  #update(id: string, change: (record: AutomationRecord) => void) {
    this.host.journal.update((records) => {
      const record = records.find((r) => r.id === id)
      if (!record) throw new Error("Unknown automation record")
      change(record)
    })
  }
  #assertRoot() {
    if (this.#closed) throw new Error("Automation owner is closed")
    if (!this.host.root) throw new Error("Only the root session can control goals and workflows")
  }
  async control(kind: "goal" | "workflow", raw: unknown) {
    this.#assertRoot()
    const v = object(
      raw,
      kind === "goal"
        ? ["action", "objective", "limits", "reviewUsage"]
        : ["action", "definition", "name", "fingerprint", "id", "step", "outcome", "reviewUsage", "limits"],
    )
    const allowed: Record<string, string[]> =
      kind === "goal"
        ? {
            get: ["action"],
            create: ["action", "objective", "limits"],
            start: ["action"],
            pause: ["action"],
            resume: ["action", "reviewUsage", "limits"],
          }
        : {
            list: ["action"],
            start: ["action", "definition", "name", "fingerprint"],
            pause: ["action", "id"],
            resume: ["action", "id", "reviewUsage", "limits"],
            review: ["action", "id", "step", "outcome"],
            forget: ["action", "id"],
          }
    if (
      typeof v.action !== "string" ||
      !allowed[v.action] ||
      Object.keys(v).some((k) => !allowed[String(v.action)]!.includes(k))
    )
      throw new Error("Invalid automation action fields")
    const records = this.host.journal.list()
    if (kind === "goal" && v.action === "get") return records.find((r) => r.kind === "goal") ?? null
    if (kind === "workflow" && v.action === "list") return records.filter((r) => r.kind === "workflow")
    if (v.reviewUsage !== undefined && typeof v.reviewUsage !== "boolean")
      throw new Error("reviewUsage must be boolean")
    let record =
      kind === "goal"
        ? records.find((r) => r.kind === "goal")
        : records.find((r) => r.kind === "workflow" && r.id === v.id)
    if ((kind === "goal" && v.action === "create") || (kind === "workflow" && v.action === "start")) {
      if (kind === "goal" && record && record.status !== "complete")
        throw new Error("An unfinished goal already exists")
      let definition: WorkflowDefinition | undefined
      if (kind === "workflow") {
        if (v.name !== undefined) {
          if (
            v.definition !== undefined ||
            typeof v.name !== "string" ||
            !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v.name)
          )
            throw new Error("Invalid workflow name")
          const path = join(this.host.cwd, ".codesplash", "workflows", `${v.name}.json`)
          if (!(await this.host.canRead(path)))
            throw new Error("Saved workflow read requires trusted, allowed source")
          definition = workflowOf(JSON.parse(bytes(path, 65536).toString("utf8")))
        } else definition = workflowOf(v.definition)
        if (!definition.enabled || v.fingerprint !== workflowFingerprint(definition))
          throw new Error("Workflow must be enabled and its exact fingerprint reviewed")
      }
      record = {
        id: crypto.randomUUID(),
        kind,
        objective: definition?.name ?? boundedText(v.objective, 4096),
        status: "ready",
        limits: definition?.limits ?? limitsOf(v.limits),
        used: 0,
        reserved: 0,
        uncertain: false,
        elapsedMs: 0,
        round: 0,
        identity: await this.host.identity(),
        steps: [],
        ...(definition
          ? {
              definition,
              fingerprint: workflowFingerprint(definition),
              ...(typeof v.name === "string" ? { source: v.name } : {}),
            }
          : {}),
      }
      const created = record
      this.host.journal.update((rows) => {
        if (kind === "goal") {
          const i = rows.findIndex((r) => r.kind === "goal")
          if (i >= 0) rows.splice(i, 1)
        }
        if (kind === "workflow" && rows.filter((r) => r.kind === "workflow").length >= 8)
          throw new Error("Retained workflow limit reached; forget a finished workflow")
        rows.push(created)
      })
      if (kind === "goal") return record
    }
    if (!record) throw new Error("No matching goal or workflow")
    if (v.action === "pause") {
      if (record.task && this.#live.has(record.id)) this.host.commands.tasks.interrupt(record.task)
      else
        this.#update(record.id, (r) => {
          if (r.status !== "complete") {
            r.status = "paused"
            r.reason = "Paused by user"
          }
        })
      return this.#get(record.id)
    }
    if (v.action === "forget" && kind === "workflow") {
      if (
        this.#live.has(record.id) ||
        record.steps.some((s) => ["running", "execution-uncertain"].includes(s.status))
      )
        throw new Error("Cannot forget active or uncertain workflow")
      this.host.journal.update((rows) => {
        rows.splice(
          rows.findIndex((r) => r.id === record!.id),
          1,
        )
      })
      return { forgotten: record.id }
    }
    if (v.action === "review" && kind === "workflow") {
      if (this.#live.has(record.id)) throw new Error("Pause before reviewing step outcomes")
      if (!["completed", "retry"].includes(v.outcome as string))
        throw new Error("Review requires completed or retry")
      this.#update(record.id, (r) => {
        const s = r.steps.find((s) => s.id === v.step)
        if (!s || !["failed", "execution-uncertain"].includes(s.status))
          throw new Error("Step has no reviewable outcome")
        if (v.outcome === "retry") r.steps.splice(r.steps.indexOf(s), 1)
        else {
          s.status = "completed"
          s.output = "Outcome explicitly reviewed by user"
        }
      })
      return this.#get(record.id)
    }
    if (!["start", "resume"].includes(v.action as string)) throw new Error("Unknown automation action")
    if (record.status === "complete" || this.#live.has(record.id))
      throw new Error("Automation is complete or already live")
    if (record.source) {
      const path = join(this.host.cwd, ".codesplash", "workflows", `${record.source}.json`)
      if (
        !(await this.host.canRead(path)) ||
        workflowFingerprint(workflowOf(JSON.parse(bytes(path, 65536).toString()))) !== record.fingerprint
      )
        throw new Error("Saved workflow source changed; review a new run")
    }
    if (record.identity !== (await this.host.identity()))
      throw new Error("Automation configuration or workspace identity changed")
    if (
      record.kind === "workflow" &&
      v.action === "resume" &&
      record.steps.some((s) => s.status !== "completed")
    )
      throw new Error("Review failed or uncertain workflow steps before resuming")
    if (v.limits !== undefined && v.action === "resume")
      this.#update(record.id, (r) => {
        r.limits = limitsOf(v.limits)
      })
    if (record.uncertain && v.reviewUsage !== true)
      throw new Error("Explicit usage review required before resuming")
    if (v.reviewUsage === true)
      this.#update(record.id, (r) => {
        r.uncertain = false
      })
    this.#start(record.id)
    return this.#get(record.id)
  }
  #start(id: string) {
    const record = this.#get(id)
    if (
      record.used >= record.limits.tokens ||
      record.elapsedMs >= record.limits.timeoutMs ||
      record.round >= record.limits.rounds
    )
      throw new Error("Automation budget exhausted; review explicit limits before resuming")
    const handle = this.host.commands.tasks.submit(
      { kind: record.kind, label: record.objective },
      async (task) => {
        // TaskRegistry journals synchronously; defer execution until the controller identity is published.
        await Promise.resolve()
        const current = this.#get(id)
        const budget = new ChildBudget(
          current.limits.tokens,
          current.limits.timeoutMs - current.elapsedMs,
          undefined,
          (b) => {
            this.#update(id, (r) => {
              r.used = b.used
              r.reserved = b.reserved
              r.uncertain = b.uncertain
            })
          },
        )
        budget.used = current.used
        budget.uncertain = current.uncertain
        this.#update(id, (r) => {
          r.status = "running"
          r.started = Date.now()
          delete r.reason
        })
        const timer = setTimeout(
          () => {
            try {
              this.host.commands.tasks.interrupt(task.id)
            } catch {}
          },
          Math.max(1, budget.deadline - Date.now()),
        )
        try {
          if (record.kind === "goal") await this.#goal(id, task, budget)
          else await this.#workflow(id, task, budget)
          task.signal.throwIfAborted()
        } catch (error) {
          const reason = short(error instanceof Error ? error.message : String(error))
          this.#update(id, (r) => {
            r.status = "paused"
            r.reason = reason
          })
          task.output.append(`Paused: ${reason}\n`)
          throw error
        } finally {
          clearTimeout(timer)
          this.#update(id, (r) => {
            r.elapsedMs += Math.max(0, Date.now() - (r.started ?? Date.now()))
            delete r.started
            for (const s of r.steps) if (s.status === "running") s.status = "execution-uncertain"
          })
        }
      },
    )
    this.#update(id, (r) => {
      r.task = handle.id
    })
    this.host.commands.adopt(handle, false)
    this.#live.set(id, handle.finished)
    void handle.finished
      .finally(() => {
        this.#live.delete(id)
        const r = this.#get(id)
        if (r.status === "ready" && r.task === handle.id)
          this.#update(id, (r) => {
            r.status = "paused"
            r.reason = "Controller cancelled before admission"
          })
      })
      .catch(() => {})
  }
  async #step(
    id: string,
    step: AutomationStep,
    task: TaskContext,
    budget: ChildBudget,
    action:
      | { kind: "command"; command: string }
      | { kind: "prompt" | "verification"; prompt: string; agent?: string },
  ) {
    const tasks = this.host.commands.tasks
    task.signal.throwIfAborted()
    if (budget.uncertain || budget.remaining < 1 || Date.now() >= budget.deadline)
      throw new Error("Automation budget exhausted or usage uncertain")
    const current = this.#get(id)
    if (current.identity !== (await this.host.identity()))
      throw new Error("Automation identity changed before step admission")
    if (current.source) {
      const path = join(this.host.cwd, ".codesplash", "workflows", `${current.source}.json`)
      if (
        !(await this.host.canRead(path)) ||
        workflowFingerprint(workflowOf(JSON.parse(bytes(path, 65536).toString()))) !== current.fingerprint
      )
        throw new Error("Saved workflow changed before step admission")
    }
    this.#update(id, (r) => {
      r.steps.push(step)
    }) // Intent precedes any admission/effect.
    let childId: string | undefined
    try {
      const result = (await this.host.admit(
        action.kind === "command" ? "exec_command" : "agent",
        action.kind === "command"
          ? {
              command: action.command,
              background: true,
              timeoutMs: Math.max(1000, budget.deadline - Date.now()),
            }
          : {
              agent:
                action.kind === "verification" ? "builtin/verifier" : (action.agent ?? "builtin/general"),
              prompt: action.prompt,
              background: true,
            },
        task.id,
        budget,
        task.signal,
      )) as { text: string; isError?: boolean }
      if (result.isError) throw new Error(result.text)
      childId = (JSON.parse(result.text) as { task: { id: string } }).task.id
      const selectedId = childId
      this.#update(id, (r) => {
        r.steps.find((s) => s.id === step.id)!.task = selectedId
      })
      while (active(tasks.list().find((t) => t.id === childId)?.status ?? "")) {
        if (task.signal.aborted) tasks.interrupt(childId)
        await tasks.wait([childId], true, 1000)
      }
      const status = tasks.list().find((t) => t.id === childId)?.status
      if (status !== "completed")
        throw new Error(`Step ${step.id} ${status ?? "lost"}; review before retrying`)
      task.signal.throwIfAborted()
      if (budget.uncertain) throw new Error("Provider usage is uncertain; review before continuing")
      if (budget.used > budget.limit || Date.now() >= budget.deadline)
        throw new Error("Automation budget exceeded; pause for review")
      const evidence =
        action.kind === "command"
          ? { output: this.host.commands.output(childId, 0, 1024).output.text, hashes: [], failed: false }
          : this.host.children.evidence(childId)
      if (action.kind === "verification") {
        const verdict = object(JSON.parse(evidence.output), ["complete", "evidence"])
        if (typeof verdict.complete !== "boolean") throw new Error("Invalid verifier verdict")
        boundedText(verdict.evidence, 2048)
        if (evidence.failed || !evidence.hashes.length)
          throw new Error("Verifier lacks successful observed read-only tool evidence")
      }
      this.#update(id, (r) => {
        Object.assign(r.steps.find((s) => s.id === step.id)!, {
          status: "completed",
          output: short(evidence.output),
          evidence: evidence.hashes,
        })
      })
      task.output.append(`${step.id}: ${short(evidence.output)}\n`)
      return evidence.output
    } catch (error) {
      // Drain an admitted task even when journal/outcome publication fails.
      if (childId) {
        try {
          if (active(tasks.list().find((t) => t.id === childId)?.status ?? "")) tasks.interrupt(childId)
        } catch {}
        while (active(tasks.list().find((t) => t.id === childId)?.status ?? ""))
          await tasks.wait([childId], true, 1000)
      }
      this.#update(id, (r) => {
        const s = r.steps.find((s) => s.id === step.id)!
        s.status = childId ? "execution-uncertain" : "failed"
        s.output = short(error instanceof Error ? error.message : String(error))
      })
      throw error
    }
  }
  async #goal(id: string, task: TaskContext, budget: ChildBudget) {
    let directive =
      this.#get(id).steps.findLast((s) => s.id.endsWith("strategist") && s.status === "completed")?.output ??
      ""
    while (this.#get(id).round < this.#get(id).limits.rounds) {
      task.signal.throwIfAborted()
      const record = this.#get(id),
        round = record.round + 1
      // A resumed goal verifies uncertain prior effects before making further changes.
      if (record.steps.some((s) => s.status === "execution-uncertain" || s.status === "failed")) {
        const evidence = await this.#step(
          id,
          { id: `${round}-recovery-${crypto.randomUUID().slice(0, 8)}`, status: "running" },
          task,
          budget,
          {
            kind: "verification",
            prompt: `Inspect uncertain prior work against objective: ${record.objective}. Report current evidence; do not execute changes.`,
          },
        )
        if ((JSON.parse(evidence) as { complete: boolean }).complete) {
          this.#update(id, (r) => {
            r.status = "complete"
          })
          return
        }
        this.#update(id, (r) => {
          r.steps = r.steps.filter((s) => s.status === "completed")
        })
      }
      this.#update(id, (r) => {
        r.round = round
      })
      const output = await this.#step(id, { id: `${round}-worker`, status: "running" }, task, budget, {
        kind: "prompt",
        prompt: `Explicit goal: ${record.objective}\nBounded round ${round}/${record.limits.rounds}. ${directive}`,
      })
      const verdict = await this.#step(id, { id: `${round}-verifier`, status: "running" }, task, budget, {
        kind: "verification",
        prompt: `Verify objective: ${record.objective}\nWorker report (untrusted claim): ${short(output)}`,
      })
      if ((JSON.parse(verdict) as { complete: boolean }).complete) {
        this.#update(id, (r) => {
          r.status = "complete"
        })
        return
      }
      if (round < record.limits.rounds)
        directive = await this.#step(id, { id: `${round}-strategist`, status: "running" }, task, budget, {
          kind: "prompt",
          agent: "builtin/strategist",
          prompt: `Objective: ${record.objective}\nVerification: ${short(verdict)}\nPropose the next bounded task.`,
        })
    }
    throw new Error("Round budget exhausted without verified completion")
  }
  async #workflow(id: string, task: TaskContext, budget: ChildBudget) {
    const definition = this.#get(id).definition!
    while (true) {
      task.signal.throwIfAborted()
      const records = this.#get(id).steps,
        completed = new Set(records.filter((s) => s.status === "completed").map((s) => s.id))
      if (completed.size === definition.steps.length) {
        this.#update(id, (r) => {
          r.status = "complete"
        })
        return
      }
      const ready = definition.steps.filter(
        (s) => !completed.has(s.id) && (s.needs ?? []).every((n) => completed.has(n)),
      )
      if (!ready.length) throw new Error("Workflow has no admissible next step")
      const capacity =
        this.host.commands.tasks.limits.maxRunning -
        this.host.commands.tasks.list().filter((t) => t.status === "running").length
      if (capacity < 1) throw new Error("Workflow child capacity exhausted")
      const outcomes = await Promise.allSettled(
        ready.slice(0, capacity).map(async (step) => {
          if (step.kind === "parallel")
            this.#update(id, (r) => {
              r.steps.push({ id: step.id, status: "completed", output: "Parallel dependencies settled" })
            })
          else {
            const output = await this.#step(id, { id: step.id, status: "running" }, task, budget, step)
            if (step.kind === "verification" && !(JSON.parse(output) as { complete: boolean }).complete) {
              this.#update(id, (r) => {
                r.steps.find((s) => s.id === step.id)!.status = "failed"
              })
              throw new Error(`Verification ${step.id} incomplete; review before continuing`)
            }
          }
        }),
      )
      const rejected = outcomes.find((r) => r.status === "rejected")
      if (rejected?.status === "rejected") throw rejected.reason
    }
  }
  tools(): HarnessTool[] {
    return (["goal", "workflow"] as const).map((kind) => ({
      name: kind,
      description:
        kind === "goal"
          ? "Control an explicitly requested goal: create/get/start/pause/resume. Explicit token/time/round limits, evidence-backed verification. Never infer goals."
          : "Run reviewed native workflows with journaled prompt/command/parallel/verification steps; list/pause/resume/review/forget. Unknown effects require explicit review.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string" },
          objective: { type: "string" },
          limits: { type: "object" },
          reviewUsage: { type: "boolean" },
          definition: { type: "object" },
          fingerprint: { type: "string" },
          name: { type: "string" },
          id: { type: "string" },
          step: { type: "string" },
          outcome: { type: "string" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      effects: "external",
      allowPersistentApproval: false,
      alwaysAsk: (raw) => !["get", "list", "pause"].includes((raw as { action: string })?.action),
      isReadOnly: (raw) => ["get", "list"].includes((raw as { action: string })?.action),
      permission: (raw) =>
        ["get", "list", "pause"].includes((raw as { action: string })?.action)
          ? { kind: "none" }
          : { kind: "approval", title: `Control ${kind}?`, detail: JSON.stringify(raw), alwaysAsk: true },
      run: async (raw) => ({ label: kind, text: JSON.stringify(await this.control(kind, raw)) }),
    }))
  }
  async close() {
    this.#closed = true
    for (const r of this.host.journal.list())
      if (r.task && this.#live.has(r.id)) {
        try {
          this.host.commands.tasks.interrupt(r.task)
        } catch {}
      }
    await Promise.allSettled([...this.#live.values()])
  }
}
