import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "@opentui/react"
import type { TeamRequest } from "../../src/core/orchestration/teams.ts"
import type { SessionController } from "../../src/core/session-controller.ts"
import { brandThemes } from "../../src/tui/brand.ts"
import { TeamPanel } from "../../src/tui/team-panel.tsx"

test("rendered team dashboard peeks, queues reply, explicitly dispatches and interrupts selected member", async () => {
  const requests: TeamRequest[] = [],
    controller = {
      teams: async (request: TeamRequest) => {
        if (request.action === "list")
          return {
            text: JSON.stringify({
              teams: [
                {
                  id: "team",
                  name: "review",
                  members: [
                    {
                      name: "worker",
                      role: "reviewer",
                      agent: "general",
                      peer: { parent: "root", usage: { inputTokens: 4, outputTokens: 2 } },
                      task: { status: "running" },
                    },
                  ],
                  edges: [],
                },
              ],
              usage: { inputTokens: 4, outputTokens: 2 },
              panes: { available: true, windows: [] },
            }),
          }
        if (request.action === "peek") return { text: JSON.stringify({ output: "LIVE_TEAM_OUTPUT" }) }
        requests.push(request)
        return { text: "{}" }
      },
    } as unknown as SessionController
  const setup = await createTestRenderer({ width: 130, height: 32, kittyKeyboard: true }),
    root = createRoot(setup.renderer)
  const settle = async () => {
    await setup.flush()
    await Bun.sleep(20)
    await setup.flush()
  }
  try {
    root.render(<TeamPanel controller={controller} palette={brandThemes.dark} onClose={() => {}} />)
    await settle()
    expect(setup.captureCharFrame()).toContain("LIVE_TEAM_OUTPUT")
    expect(setup.captureCharFrame()).toContain("review/worker")
    setup.mockInput.pressKey("r")
    await settle()
    await setup.mockInput.typeText("reply data")
    setup.mockInput.pressEnter()
    await settle()
    setup.mockInput.pressKey("d")
    await settle()
    await setup.mockInput.typeText("perform review")
    setup.mockInput.pressEnter()
    await settle()
    setup.mockInput.pressKey("k")
    await settle()
    expect(requests).toEqual([
      { action: "reply", team: "team", member: "worker", text: "reply data" },
      { action: "dispatch", team: "team", member: "worker", prompt: "perform review" },
      { action: "interrupt", team: "team", member: "worker" },
    ])
  } finally {
    setup.renderer.destroy()
  }
})
