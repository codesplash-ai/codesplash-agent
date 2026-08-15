import { type AgentEvent, createAgentEvent } from "../core/index.ts"

const envelope = { engine: "codex" as const, localSessionId: "fixture-session" }

export const fixtureEvents: AgentEvent[] = [
  createAgentEvent(
    { ...envelope, sequence: 0 },
    { kind: "session.status", payload: { status: "ready", detail: "fixture" } },
  ),
  createAgentEvent({ ...envelope, sequence: 1 }, { kind: "turn.started", payload: {} }),
  createAgentEvent(
    { ...envelope, sequence: 2 },
    {
      kind: "message.delta",
      payload: { id: "message-1", text: "I’ll inspect the failing test and keep the change scoped.\n\n" },
    },
  ),
  createAgentEvent(
    { ...envelope, sequence: 3 },
    {
      kind: "item.updated",
      payload: {
        id: "tool-1",
        label: "Read package.json",
        status: "completed",
        output: "Found Bun project",
      },
    },
  ),
  createAgentEvent(
    { ...envelope, sequence: 4 },
    {
      kind: "message.delta",
      payload: { id: "message-1", text: "The reducer needs one small correction:" },
    },
  ),
  createAgentEvent(
    { ...envelope, sequence: 5 },
    {
      kind: "diff.updated",
      payload: {
        id: "diff-1",
        path: "src/reducer.ts",
        unified: [
          "diff --git a/src/reducer.ts b/src/reducer.ts",
          "index 1111111..2222222 100644",
          "--- a/src/reducer.ts",
          "+++ b/src/reducer.ts",
          "@@ -1,2 +1,2 @@",
          "-return previous",
          "+return next",
          " context",
          "",
        ].join("\n"),
      },
    },
  ),
  createAgentEvent(
    { ...envelope, sequence: 6 },
    {
      kind: "request.opened",
      payload: {
        id: "approval-1",
        requestKind: "approval",
        title: "Run command?",
        detail: "bun test",
        choices: ["accept", "decline"],
      },
    },
  ),
  createAgentEvent(
    { ...envelope, sequence: 7 },
    { kind: "usage.updated", payload: { inputTokens: 1_248, cachedInputTokens: 920, outputTokens: 186 } },
  ),
]
