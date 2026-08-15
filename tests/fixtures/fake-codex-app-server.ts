const decoder = new TextDecoder()
let buffer = ""
const reader = Bun.stdin.stream().getReader()
let turnCount = 0
const pendingApprovals = new Map<string, { threadId: string; turnId: string }>()

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
    send({ id: message.id, result: { thread: { id: "thread-1" }, model: "gpt-test" } })
    return
  }

  if (message.method === "thread/resume") {
    send({
      id: message.id,
      result: { thread: { id: message.params?.threadId }, model: "gpt-test" },
    })
    return
  }

  if (message.method === "turn/start") {
    if (message.params?.summary !== "auto") {
      send({ id: message.id, error: { code: -32602, message: "reasoning summary must be auto" } })
      return
    }
    const threadId = String(message.params?.threadId)
    const input = message.params?.input as Array<{ text?: string }> | undefined
    const text = input?.[0]?.text
    const turnId = `turn-${++turnCount}`
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } })
    send({
      method: "turn/started",
      params: { threadId, turn: { id: turnId, status: "inProgress" } },
    })

    if (text === "interrupt") return
    if (text === "crash") {
      process.stderr.write("Authorization: Bearer fake-secret-token-value\n")
      setTimeout(() => process.exit(17), 5)
      return
    }
    if (text === "stream") {
      send({
        method: "item/started",
        params: {
          threadId,
          turnId,
          item: {
            type: "commandExecution",
            id: `command-${turnCount}`,
            command: "bun test",
            cwd: "/tmp/project",
            processId: null,
            status: "inProgress",
            commandActions: [],
            aggregatedOutput: "",
            exitCode: null,
            durationMs: null,
          },
        },
      })
      send({
        method: "item/agentMessage/delta",
        params: { threadId, turnId, itemId: `message-${turnCount}`, delta: "Done" },
      })
      send({
        method: "turn/diff/updated",
        params: { threadId, turnId, diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new" },
      })
      send({
        method: "thread/tokenUsage/updated",
        params: {
          threadId,
          turnId,
          tokenUsage: {
            total: {
              inputTokens: 10,
              cachedInputTokens: 0,
              outputTokens: 4,
              reasoningOutputTokens: 0,
              totalTokens: 14,
            },
            last: {
              inputTokens: 10,
              cachedInputTokens: 0,
              outputTokens: 4,
              reasoningOutputTokens: 0,
              totalTokens: 14,
            },
            modelContextWindow: 1000,
          },
        },
      })
      send({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: { type: "agentMessage", id: `message-${turnCount}`, text: "Done", phase: null },
        },
      })
      send({
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status: "completed" } },
      })
      return
    }

    const approvalId = `approval-${turnCount}`
    pendingApprovals.set(approvalId, { threadId, turnId })
    send({
      id: approvalId,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId,
        turnId,
        itemId: `item-${turnCount}`,
        startedAtMs: Date.now(),
        environmentId: null,
        command: "touch approved.txt",
        cwd: "/tmp/project",
      },
    })
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

  if (message.id !== undefined) {
    const approval = pendingApprovals.get(String(message.id))
    if (!approval) return
    pendingApprovals.delete(String(message.id))
    send({
      method: "turn/completed",
      params: {
        threadId: approval.threadId,
        turn: { id: approval.turnId, status: "completed" },
      },
    })
  }
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
