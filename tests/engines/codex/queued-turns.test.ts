import { expect, test } from "bun:test"
import { InputQueue } from "../../../src/core/session/input-queue.ts"
import { JsonRpcRemoteError } from "../../../src/engines/codex/json-rpc.ts"
import { CodexQueuedTurns } from "../../../src/engines/codex/queued-turns.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
const tick = () => Bun.sleep(5)
test("Codex reserves synchronously and does not resurrect completion before the start response", async () => {
  const queue = new InputQueue({ cwd: "/project" }),
    start = deferred<string>(),
    calls: string[] = []
  const turns = new CodexQueuedTurns(queue, {
    start: async (input) => {
      calls.push(input.text)
      return calls.length === 1 ? start.promise : "two"
    },
    steer: async () => "one",
    interrupt: async () => {},
    error: () => {},
  })
  const sending = turns.send({ text: "first" })
  await expect(turns.send({ text: "duplicate" })).rejects.toThrow("already running")
  const second = turns.submit({ text: "second" })
  turns.started("one")
  turns.completed("one", "completed")
  await tick()
  expect(calls).toEqual(["first"])
  start.resolve("one")
  await sending
  await tick()
  expect(calls).toEqual(["first", "second"])
  turns.completed("two", "completed")
  await tick()
  expect(queue.snapshot().items.find((item) => item.id === second.id)?.status).toBe("completed")
  await turns.close()
})
test("Codex interject waits for matching terminal confirmation and ignores unrelated turns", async () => {
  const queue = new InputQueue({ cwd: "/project" }),
    calls: string[] = [],
    interrupts: string[] = []
  const turns = new CodexQueuedTurns(queue, {
    start: async (input) => {
      calls.push(input.text)
      return input.text
    },
    steer: async () => "first",
    interrupt: async (id) => {
      interrupts.push(id)
    },
    error: () => {},
  })
  await turns.send({ text: "first" })
  turns.submit({ text: "second" }, "interject")
  await tick()
  expect(interrupts).toEqual(["first"])
  expect(calls).toEqual(["first"])
  turns.completed("unrelated", "completed")
  await tick()
  expect(calls).toEqual(["first"])
  turns.completed("first", "cancelled")
  await tick()
  expect(calls).toEqual(["first", "second"])
  turns.completed("second", "completed")
  await turns.close()
})
test("Codex steering is admitted on the active turn and waits for its terminal result", async () => {
  const queue = new InputQueue({ cwd: "/project" }),
    calls: string[] = [],
    steer = deferred<string>()
  const turns = new CodexQueuedTurns(queue, {
    start: async (input) => {
      calls.push(input.text)
      return input.text
    },
    steer: async (input, id, expected) => {
      calls.push(`${input.text}:${expected}:${id}`)
      return steer.promise
    },
    interrupt: async () => {},
    error: () => {},
  })
  await turns.send({ text: "first" })
  const ack = turns.submit({ text: "direction" }, "steering")
  turns.submit({ text: "follow-up" })
  await tick()
  expect(calls[1]).toBe(`direction:first:${ack.id}`)
  turns.completed("first", "completed")
  await tick()
  expect(calls).toHaveLength(2)
  steer.resolve("first")
  await tick()
  expect(queue.snapshot().items.find((item) => item.id === ack.id)).toMatchObject({
    status: "completed",
    boundary: "within-turn",
  })
  expect(calls[2]).toBe("follow-up")
  turns.completed("follow-up", "completed")
  await turns.close()
})
test("Codex method rejection blocks steering while transport loss marks admission uncertain", async () => {
  for (const remote of [true, false]) {
    const queue = new InputQueue({ cwd: "/project" })
    const turns = new CodexQueuedTurns(queue, {
      start: async () => "first",
      steer: async () => {
        throw remote ? new JsonRpcRemoteError(-32601, "turn/steer unsupported") : new Error("connection lost")
      },
      interrupt: async () => {},
      error: () => {},
    })
    await turns.send({ text: "first" })
    const ack = turns.submit({ text: "direction" }, "steering")
    await tick()
    expect(queue.snapshot().items.find((item) => item.id === ack.id)?.status).toBe(
      remote ? "blocked" : "execution-uncertain",
    )
    expect(queue.snapshot().paused).toBe(true)
    turns.completed("first", "completed")
    await turns.close()
  }
})
test("Codex disconnect never retries potentially executing work", async () => {
  const queue = new InputQueue({ cwd: "/project" }),
    calls: string[] = []
  const turns = new CodexQueuedTurns(queue, {
    start: async (input) => {
      calls.push(input.text)
      return "first"
    },
    steer: async () => "first",
    interrupt: async () => {},
    error: () => {},
  })
  await turns.send({ text: "first" })
  turns.submit({ text: "pending" })
  turns.disconnected()
  await tick()
  expect(queue.snapshot().items.map((item) => item.status)).toEqual(["execution-uncertain", "queued"])
  expect(calls).toEqual(["first"])
  await turns.close()
})
