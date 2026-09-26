import { expect, test } from "bun:test"
import { Adapter } from "../../src/server/adapters.ts"
import { Hub } from "../../src/server/hub.ts"
import { fixture } from "./fixture.ts"

for (const dialect of ["acp", "mcp"] as const)
  test(`${dialect} negotiates, runs a native turn and advertises only supported controls`, async () => {
    const f = await fixture(),
      hub = await Hub.open(f.options),
      messages: Array<Record<string, unknown>> = []
    const adapter = new Adapter(hub, dialect, (v) => messages.push(v as Record<string, unknown>), f.cwd)
    let id = 0
    const call = async (method: string, params: unknown = {}) => {
      const n = ++id
      await adapter.handle({ jsonrpc: "2.0", id: n, method, params })
      return messages.findLast((v) => v.id === n) as { result?: Record<string, unknown>; error?: unknown }
    }
    try {
      expect((await call("ping")).error).toBeDefined()
      expect(
        (
          await call(
            "initialize",
            dialect === "acp" ? { protocolVersion: 1 } : { protocolVersion: "2025-11-25", capabilities: {} },
          )
        ).result,
      ).toBeDefined()
      if (dialect === "mcp") await adapter.handle({ jsonrpc: "2.0", method: "notifications/initialized" })
      if (dialect === "acp") {
        expect(
          (await call("session/new", { cwd: f.cwd, mcpServers: [{ command: "unreviewed" }] })).error,
        ).toBeDefined()
        const sessionId = (await call("session/new", { cwd: f.cwd, mcpServers: [] })).result!.sessionId
        expect(
          (await call("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] })).result,
        ).toEqual({ stopReason: "end_turn" })
        expect(JSON.stringify(messages)).toContain("agent_message_chunk")
        expect(
          (await call("session/prompt", { sessionId, prompt: [{ type: "image", data: "not supported" }] }))
            .error,
        ).toBeDefined()
      } else {
        expect(JSON.stringify((await call("tools/list")).result)).toContain("codesplash-reply")
        const result = (await call("tools/call", { name: "codesplash", arguments: { prompt: "hello" } }))
          .result!
        expect(JSON.stringify(result)).toContain("served")
        expect(result.isError).toBe(false)
      }
      expect(f.calls()).toBe(1)
    } finally {
      await adapter.close()
      await hub.close()
      await f.clean()
    }
  })

for (const dialect of ["acp", "mcp"] as const)
  test(`${dialect} forwards a native approval callback and executes only after the client answer`, async () => {
    const f = await fixture(true),
      hub = await Hub.open(f.options),
      messages: any[] = []
    let callbacks = 0
    const adapter = new Adapter(
      hub,
      dialect,
      (value: any) => {
        messages.push(value)
        if (["session/request_permission", "elicitation/create"].includes(value.method)) {
          callbacks++
          void adapter.handle({
            jsonrpc: "2.0",
            id: value.id,
            result:
              dialect === "acp"
                ? { outcome: { outcome: "selected", optionId: "accept" } }
                : { action: "accept", content: { choice: "accept" } },
          })
        }
      },
      f.cwd,
    )
    let id = 0
    const call = async (method: string, params: unknown) => {
      const n = ++id
      await adapter.handle({ jsonrpc: "2.0", id: n, method, params })
      const response = messages.findLast((v) => v.id === n)
      if (response.error) throw Error(JSON.stringify(response.error))
      return response.result
    }
    try {
      await call(
        "initialize",
        dialect === "acp"
          ? { protocolVersion: 1 }
          : { protocolVersion: "2025-11-25", capabilities: { elicitation: { form: {} } } },
      )
      if (dialect === "acp") {
        const { sessionId } = await call("session/new", { cwd: f.cwd, mcpServers: [] })
        expect(
          await call("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "write the approved fixture" }],
          }),
        ).toEqual({ stopReason: "end_turn" })
      } else {
        await adapter.handle({ jsonrpc: "2.0", method: "notifications/initialized" })
        expect(
          (
            await call("tools/call", {
              name: "codesplash",
              arguments: { prompt: "write the approved fixture" },
            })
          ).isError,
        ).toBe(false)
      }
      expect(callbacks).toBe(1)
      expect(await Bun.file(`${f.cwd}/approved.txt`).text()).toContain("approved")
    } finally {
      await adapter.close()
      await hub.close()
      await f.clean()
    }
  }, 30000)
