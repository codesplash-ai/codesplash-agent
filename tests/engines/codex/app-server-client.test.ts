import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { CodexAppServerClient } from "../../../src/engines/codex/app-server-client.ts"

describe("CodexAppServerClient", () => {
  test("initializes and reads account state through a child process", async () => {
    const fixture = new URL("../../fixtures/fake-codex-app-server.ts", import.meta.url)
    const client = new CodexAppServerClient({
      command: [process.execPath, fileURLToPath(fixture)],
      shutdownTimeoutMs: 100,
    })

    try {
      const initialized = await client.initialize()
      expect(initialized.userAgent).toBe("fake-codex/0.147.0")

      const account = await client.readAccount()
      expect(account.account).toEqual({ type: "chatgpt", email: null, planType: "plus" })
      expect(client.process.getStderr()).toContain("fake diagnostic")
    } finally {
      await client.close()
    }

    await expect(client.process.exited).resolves.toBe(0)
  })
})
