import { describe, expect, test } from "bun:test"
import {
  type AgentEvent,
  AsyncQueue,
  createAgentEvent,
  type EngineCapabilities,
  type EngineDecision,
  type EngineSession,
  SessionController,
  type UserInput,
} from "../../src/core/index.ts"

const capabilities: EngineCapabilities = {
  nativeTranscript: true,
  approvals: true,
  interrupt: true,
  resume: true,
  fork: false,
  usage: "tokens",
  surface: "native",
}

class FakeSession implements EngineSession {
  readonly localSessionId = "local-1"
  readonly nativeSessionId = "native-1"
  readonly capabilities = capabilities
  readonly queue = new AsyncQueue<AgentEvent>()
  readonly events = this.queue
  readonly inputs: UserInput[] = []
  readonly decisions: Array<{ requestId: string; decision: EngineDecision }> = []
  interrupts = 0

  async send(input: UserInput): Promise<void> {
    this.inputs.push(input)
  }

  async resolveRequest(requestId: string, decision: EngineDecision): Promise<void> {
    this.decisions.push({ requestId, decision })
  }

  async interrupt(): Promise<void> {
    this.interrupts++
  }

  async close(): Promise<void> {
    this.queue.end()
  }
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      assertion()
      return
    } catch {
      await Bun.sleep(1)
    }
  }
  assertion()
}

describe("SessionController", () => {
  test("reduces events before notifying the UI and enforces live-turn commands", async () => {
    const session = new FakeSession()
    const controller = new SessionController(session)
    const statuses: string[] = []
    controller.subscribe((state) => statuses.push(state.turnStatus))
    controller.start()

    session.queue.push(
      createAgentEvent(
        {
          engine: "codex",
          localSessionId: session.localSessionId,
          sequence: 0,
          raw: { providerSecret: "must-not-reach-view-state" },
        },
        { kind: "turn.started", payload: {} },
      ),
    )
    await eventually(() => expect(controller.state.turnStatus).toBe("running"))

    await expect(controller.send({ text: "too soon" })).rejects.toThrow("current turn")
    await controller.interrupt()
    expect(session.interrupts).toBe(1)
    expect(statuses).toContain("running")
    expect(JSON.stringify(controller.state)).not.toContain("must-not-reach-view-state")

    await controller.close()
  })

  test("forwards messages and approval decisions through capability-checked commands", async () => {
    const session = new FakeSession()
    const controller = new SessionController(session)
    controller.start()

    await controller.send({ text: "hello" })
    await controller.resolveRequest("request-1", { choice: "decline" })

    expect(session.inputs).toEqual([{ text: "hello" }])
    expect(session.decisions).toEqual([{ requestId: "request-1", decision: { choice: "decline" } }])
    await controller.close()
  })

  test("coalesces rapid streaming deltas into stable view updates", async () => {
    const session = new FakeSession()
    const controller = new SessionController(session)
    const renderedText: string[] = []
    controller.subscribe((state) => {
      const message = state.transcript.find((item) => item.id === "message-1")
      if (message) renderedText.push(message.text)
    })
    controller.start()

    for (const [sequence, text] of ["one", " two", " three"].entries()) {
      session.queue.push(
        createAgentEvent(
          { engine: "codex", localSessionId: session.localSessionId, sequence },
          { kind: "message.delta", payload: { id: "message-1", text } },
        ),
      )
    }

    await Bun.sleep(60)
    expect(renderedText).toEqual(["one two three"])
    await controller.close()
  })
})
