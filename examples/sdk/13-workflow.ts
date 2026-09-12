import { createHash } from "node:crypto"
import type { AutomationRecord, WorkflowDefinition } from "codesplash-agent"
import { assert, fixture, join } from "./fixture.ts"

await fixture(async ({ root, open }) => {
  const session = await open({ respond: async () => ({ choice: "accept" }) })
  // Reviewing the full definition authorizes these literal actions. No template evaluator runs.
  const definition: WorkflowDefinition = {
    version: 1,
    name: "local-report",
    enabled: true,
    limits: { tokens: 200000, timeoutMs: 30000, rounds: 1 },
    steps: [
      { id: "left", kind: "prompt", agent: "builtin/explore", prompt: "Inspect one aspect" },
      { id: "right", kind: "prompt", agent: "builtin/explore", prompt: "Inspect another aspect" },
      { id: "join", kind: "parallel", needs: ["left", "right"] },
      { id: "write", kind: "command", needs: ["join"], command: "printf report > report.txt" },
    ],
  }
  const fingerprint = createHash("sha256").update(JSON.stringify(definition)).digest("hex")
  const started = (await session.workflows({ action: "start", definition, fingerprint })) as {
    text: string
    isError?: boolean
  }
  assert.ok(!started.isError, started.text)
  const record = JSON.parse(started.text) as AutomationRecord
  await session.tasks({ action: "wait", ids: [record.task!], all: true, timeoutMs: 30000 })
  const listed = (await session.workflows({ action: "list" })) as { text: string }
  const final = (JSON.parse(listed.text) as AutomationRecord[]).find((r) => r.id === record.id)!
  assert.equal(final.status, "complete", final.reason)
  assert.equal(final.steps.length, 4)
  assert.equal(await Bun.file(join(root, "report.txt")).text(), "report")
})
