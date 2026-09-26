import type { ExecutionLimits } from "codesplash-agent"
import { assert, fixture, localProvider } from "./fixture.ts"

await fixture(async ({ open }) => {
  const provider = localProvider('{"ok":true}')
  provider.models[0]!.pricing = { inputPerMTok: 1, outputPerMTok: 2 }
  const execution: ExecutionLimits = { allowedTools: ["read_file"], excludedTools: ["bash"], maxBudgetUsd: 1 }
  const session = await open({
    providers: [provider],
    execution,
    outputSchema: {
      type: "object",
      properties: { ok: { const: true } },
      required: ["ok"],
      additionalProperties: false,
    },
  })
  assert.equal((await session.prompt("Return the fixture JSON")).status, "completed")
  assert.equal((await session.prompt("Return it again")).status, "completed")
  assert.ok((session.usage.estimatedCostUsd ?? 0) > 0)
  assert.ok((session.usage.estimatedCostUsd ?? 1) < 1)
})
