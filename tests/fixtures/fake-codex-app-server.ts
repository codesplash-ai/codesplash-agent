const decoder = new TextDecoder()
let buffer = ""
const reader = Bun.stdin.stream().getReader()

while (true) {
  const result = await reader.read()
  if (result.done) break
  const chunk = result.value
  buffer += decoder.decode(chunk, { stream: true })
  let newline = buffer.indexOf("\n")

  while (newline >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.length > 0) handleMessage(JSON.parse(line))
    newline = buffer.indexOf("\n")
  }
}

function handleMessage(message: {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
}): void {
  if (message.method === "initialize") {
    process.stdout.write(
      `${JSON.stringify({
        id: message.id,
        result: {
          userAgent: "fake-codex/0.147.0",
          codexHome: "/tmp/fake-codex",
          platformFamily: "unix",
          platformOs: "test",
        },
      })}\n`,
    )
    return
  }

  if (message.method === "account/read") {
    process.stderr.write("fake diagnostic\n")
    process.stdout.write(
      `${JSON.stringify({
        id: message.id,
        result: { account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true },
      })}\n`,
    )
    return
  }

  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-1" } } })
    return
  }

  if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: message.params?.threadId } } })
    return
  }

  if (message.method === "turn/start") {
    const threadId = String(message.params?.threadId)
    const input = message.params?.input as Array<{ text?: string }> | undefined
    const shouldApprove = input?.[0]?.text !== "interrupt"
    send({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress" } } })
    send({
      method: "turn/started",
      params: { threadId, turn: { id: "turn-1", status: "inProgress" } },
    })
    if (shouldApprove) {
      send({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId,
          turnId: "turn-1",
          itemId: "item-1",
          startedAtMs: Date.now(),
          environmentId: null,
          command: "touch approved.txt",
          cwd: "/tmp/project",
        },
      })
    }
    return
  }

  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: null })
    send({
      method: "turn/completed",
      params: {
        threadId: message.params?.threadId,
        turn: { id: message.params?.turnId, status: "interrupted" },
      },
    })
    return
  }

  if (message.id === "approval-1") {
    send({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    })
  }
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
