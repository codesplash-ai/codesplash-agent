import { resolve } from "node:path"
import type { AgentEvent, EngineSession } from "../../core/index.ts"
import { CodexDriver } from "./driver.ts"

const EVENT_TIMEOUT_MS = 120_000

export async function runCodexLiveSmoke(): Promise<void> {
  const driver = new CodexDriver()
  const localSessionId = `live-smoke-${Date.now()}`
  const session = await driver.openSession({ cwd: process.cwd(), localSessionId })
  const threadId = session.nativeSessionId
  const outsideWorkspacePath = resolve(process.cwd(), "..", "codesplash-agent-outside-smoke.txt")
  if (!threadId) throw new Error("Codex did not return a thread id")

  try {
    const events = session.events[Symbol.asyncIterator]()
    await session.send({
      text: [
        "This is an approval transport smoke test.",
        `Use a shell command to create ${outsideWorkspacePath} containing smoke.`,
        "Do not perform any other action. The client will decline the approval request.",
      ].join(" "),
    })

    const approval = await consumeUntilCompleted(session, events)
    if (!approval) throw new Error("The live turn completed without an approval request")

    await session.send({
      text: "Run the shell command `sleep 30`. After it finishes, reply with exactly SLEEP_DONE.",
    })
    await nextMatching(events, (event) => event.kind === "item.updated" && event.payload.status === "running")
    await session.interrupt()
    const interrupted = await nextMatching(events, (event) => event.kind === "turn.completed")
    if (interrupted.kind !== "turn.completed" || interrupted.payload.status !== "interrupted") {
      throw new Error(`Expected interrupted turn, received ${interrupted.kind}`)
    }
  } finally {
    await session.close()
  }

  const resumed = await driver.openSession({
    cwd: process.cwd(),
    localSessionId: `${localSessionId}-resumed`,
    nativeSessionId: threadId,
  })
  try {
    if (resumed.nativeSessionId !== threadId) throw new Error("Resumed thread id did not match")
    const events = resumed.events[Symbol.asyncIterator]()
    await resumed.send({ text: "Reply with exactly RESUME_OK and no other text." })
    const response = await consumeCompletedMessage(events)
    if (response.trim() !== "RESUME_OK") {
      throw new Error(`Expected RESUME_OK after resume, received ${JSON.stringify(response.trim())}`)
    }
  } finally {
    await resumed.close()
  }

  process.stdout.write(`Codex live smoke check passed
Approval: declined without applying the outside-workspace write
Interrupt: acknowledged
Resume: ${threadId}
Post-resume turn: RESUME_OK
`)
}

async function consumeCompletedMessage(events: AsyncIterator<AgentEvent>): Promise<string> {
  let message = ""
  while (true) {
    const event = await nextEvent(events)
    if (event.kind === "message.delta") message += event.payload.text
    if (event.kind === "message.completed" && event.payload.text) message = event.payload.text
    if (event.kind === "turn.completed") return message
    if (event.kind === "error" && !event.payload.recoverable) throw new Error(event.payload.message)
  }
}

async function consumeUntilCompleted(
  session: EngineSession,
  events: AsyncIterator<AgentEvent>,
): Promise<boolean> {
  let approval = false

  while (true) {
    const event = await nextEvent(events)
    if (event.kind === "request.opened") {
      approval = true
      await session.resolveRequest(event.payload.id, { choice: "decline" })
    }
    if (event.kind === "turn.completed") return approval
    if (event.kind === "error" && !event.payload.recoverable) throw new Error(event.payload.message)
  }
}

async function nextMatching(
  events: AsyncIterator<AgentEvent>,
  predicate: (event: AgentEvent) => boolean,
): Promise<AgentEvent> {
  while (true) {
    const event = await nextEvent(events)
    if (predicate(event)) return event
  }
}

async function nextEvent(events: AsyncIterator<AgentEvent>): Promise<AgentEvent> {
  const result = await Promise.race([
    events.next(),
    Bun.sleep(EVENT_TIMEOUT_MS).then(() => {
      throw new Error(`Timed out waiting for Codex event after ${EVENT_TIMEOUT_MS}ms`)
    }),
  ])
  if (result.done) throw new Error("Codex event stream ended unexpectedly")
  return result.value
}
