import { assert, fixture } from "./fixture.ts"

await fixture(async ({ open }) => {
  // The fixture approves its own known local commands. A product should ask its user.
  const session = await open({ respond: async () => ({ choice: "accept" }) })
  const started = (await session.runCommand('read value; printf "Received: %s\\n" "$value"', false)) as {
    text: string
    isError?: boolean
  }
  assert.ok(!started.isError, started.text)
  const { task } = JSON.parse(started.text) as { task: { id: string } }
  const monitor = session.monitorTask(task.id)
  const observed = (async () => {
    let text = ""
    for await (const page of monitor) text += page.text
    return text
  })()
  try {
    // A task ID is available before a cold PTY has finished starting. Inspect readiness explicitly.
    const deadline = Date.now() + 15000
    for (;;) {
      const page = (await session.tasks({ action: "output", id: task.id })) as {
        terminalReady: boolean
        task: { status: string }
      }
      if (page.terminalReady) break
      assert.ok(["queued", "running"].includes(page.task.status), JSON.stringify(page))
      assert.ok(Date.now() < deadline, `Terminal did not become ready: ${JSON.stringify(page)}`)
      await Bun.sleep(25)
    }
    const input = (await session.tasks({ action: "stdin", id: task.id, text: "hello\n" })) as {
      isError?: boolean
      text: string
    }
    assert.ok(!input.isError, input.text)
    const results = (await session.tasks({
      action: "wait",
      ids: [task.id],
      all: true,
      timeoutMs: 30000,
    })) as Array<{ task: { status: string } }>
    assert.equal(results[0]?.task.status, "completed")
    assert.match(await observed, /Received: hello/)
  } finally {
    await monitor.return?.()
  }
})
