/**
 * ask_user: spec-only tool. The loop intercepts calls by name (ASK_USER_TOOL_NAME), opens a
 * "user-input" request, and turns the decision into the tool result; run() must never execute.
 */
import { ASK_USER_TOOL_NAME, type HarnessTool } from "../contracts.ts"

export const askUserTool: HarnessTool = {
  name: ASK_USER_TOOL_NAME,
  description:
    "Ask the user a multiple-choice question when you need their input to proceed. Provide the " +
    "question and 2-6 short answer options; the harness pauses and returns the option the user picks.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to put to the user." },
      options: {
        type: "array",
        description: "Between 2 and 6 short answer options.",
        items: { type: "string" },
        minItems: 2,
        maxItems: 6,
      },
    },
    required: ["question", "options"],
    additionalProperties: false,
  },
  isReadOnly: () => true,
  permission: () => ({ kind: "none" }),
  run: async () => {
    throw new Error("ask_user is intrinsic: the harness loop executes it; run() must never be called.")
  },
}
