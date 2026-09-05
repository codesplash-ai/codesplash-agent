/**
 * Plan-mode tools: spec-only, intrinsic like ask_user. The loop intercepts calls by name
 * (ENTER_PLAN_MODE_TOOL_NAME / EXIT_PLAN_MODE_TOOL_NAME), performs the mode switch and the
 * plan-approval request itself, and never calls run().
 */
import { ENTER_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME, type HarnessTool } from "../contracts.ts"

export const enterPlanModeTool: HarnessTool = {
  name: ENTER_PLAN_MODE_TOOL_NAME,
  description:
    "Switch this session into plan mode for non-trivial work that deserves a reviewed plan. In plan " +
    "mode you investigate read-only, write the plan to .codesplash/plan.md, and then call " +
    "exit_plan_mode so the user can approve it. Errors if the session is already in plan mode.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  isReadOnly: () => true,
  permission: () => ({ kind: "none" }),
  run: async () => {
    throw new Error("enter_plan_mode is intrinsic: the harness loop executes it; run() must never be called.")
  },
}

export const exitPlanModeTool: HarnessTool = {
  name: EXIT_PLAN_MODE_TOOL_NAME,
  description:
    "Present the plan for user approval and leave plan mode when they approve. Provide the plan text " +
    "in `plan`, or omit it to use the contents of .codesplash/plan.md. If the user chooses to keep " +
    "planning, plan mode stays on.",
  inputSchema: {
    type: "object",
    properties: {
      plan: {
        type: "string",
        description: "The plan to review. When omitted, the contents of .codesplash/plan.md are used.",
      },
    },
    additionalProperties: false,
  },
  isReadOnly: () => true,
  permission: () => ({ kind: "none" }),
  run: async () => {
    throw new Error("exit_plan_mode is intrinsic: the harness loop executes it; run() must never be called.")
  },
}
