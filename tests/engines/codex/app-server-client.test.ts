import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import {
  CodexAppServerClient,
  codexVersionCompatibility,
  MINIMUM_CODEX_CLI_VERSION,
  SUPPORTED_CODEX_CLI_VERSION,
} from "../../../src/engines/codex/app-server-client.ts"

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

describe("codexVersionCompatibility", () => {
  test("the tested baseline is compatible without a warning", () => {
    expect(codexVersionCompatibility(SUPPORTED_CODEX_CLI_VERSION)).toEqual({ compatible: true })
  })

  test("newer versions are compatible but carry an untested warning", () => {
    const newerPatch = codexVersionCompatibility("0.147.1")
    expect(newerPatch.compatible).toBe(true)
    expect(newerPatch.warning).toContain("newer than the tested baseline")

    const newerMinor = codexVersionCompatibility("0.150.0")
    expect(newerMinor.compatible).toBe(true)
    expect(newerMinor.warning).toContain(SUPPORTED_CODEX_CLI_VERSION)
  })

  test("versions older than the minimum are refused", () => {
    expect(codexVersionCompatibility("0.146.9").compatible).toBe(false)
    expect(codexVersionCompatibility("0.99.0").compatible).toBe(false)
  })

  test("a missing version is refused", () => {
    expect(codexVersionCompatibility(undefined).compatible).toBe(false)
  })

  test("the minimum never exceeds the tested baseline", () => {
    expect(codexVersionCompatibility(MINIMUM_CODEX_CLI_VERSION).compatible).toBe(true)
  })
})
