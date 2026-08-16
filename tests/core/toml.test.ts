import { describe, expect, test } from "bun:test"
import { stringifyToml } from "../../src/core/toml.ts"

describe("stringifyToml", () => {
  test("serializes root scalars and one level of section tables", () => {
    const source = stringifyToml({
      schemaVersion: 1,
      theme: "system",
      history: { enabled: true },
      codex: { sandbox: "workspace-write", approvalPolicy: "on-request" },
    })

    expect(source).toBe(
      [
        "schemaVersion = 1",
        'theme = "system"',
        "",
        "[history]",
        "enabled = true",
        "",
        "[codex]",
        'sandbox = "workspace-write"',
        'approvalPolicy = "on-request"',
        "",
      ].join("\n"),
    )
    expect(Bun.TOML.parse(source)).toEqual({
      schemaVersion: 1,
      theme: "system",
      history: { enabled: true },
      codex: { sandbox: "workspace-write", approvalPolicy: "on-request" },
    })
  })

  test("round-trips escaped strings through Bun.TOML.parse", () => {
    const del = String.fromCharCode(0x7f)
    const value = `quote " backslash \\ newline \n tab \t cr \r bs \b ff \f del ${del} unicode ✓`
    const source = stringifyToml({ value, "key with spaces": "ok" })

    expect(Bun.TOML.parse(source)).toEqual({ value, "key with spaces": "ok" })
  })

  test("rejects unsupported shapes and unrepresentable control characters", () => {
    expect(() =>
      stringifyToml({ section: { nested: { too: "deep" } } as unknown as Record<string, string> }),
    ).toThrow("nested tables beyond one level")
    expect(() => stringifyToml({ bad: Number.POSITIVE_INFINITY })).toThrow("non-finite")
    expect(() => stringifyToml({ bad: `bel ${String.fromCharCode(7)}` })).toThrow("control character U+0007")
  })
})
