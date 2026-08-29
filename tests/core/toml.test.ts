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

  test("serializes deeply nested tables and arrays of tables and round-trips them", () => {
    const table = {
      codesplash: { fallbackModel: "gpt-5.1" },
      providers: {
        ollama: {
          protocol: "openai",
          baseUrl: "http://localhost:11434/v1",
          requiresKey: false,
          models: [
            { id: "qwen3:8b", default: true, pricing: { inputPerMTok: 0, outputPerMTok: 0 } },
            { id: "llama4:70b", contextWindow: 32768 },
          ],
        },
        "my-gateway": {
          protocol: "anthropic",
          baseUrl: "https://gateway.example.com",
          models: [{ id: "claude-proxy" }],
        },
      },
    }

    const source = stringifyToml(table)
    expect(source).toContain("[codesplash]")
    expect(source).toContain("[providers.ollama]")
    expect(source).toContain("[[providers.ollama.models]]")
    expect(source).toContain("[providers.ollama.models.pricing]")
    expect(source).toContain("[providers.my-gateway]")
    expect(Bun.TOML.parse(source)).toEqual(table)
  })

  test("serializes inline scalar arrays", () => {
    const table = { tags: ["a", "b"], counts: [1, 2, 3], flags: [true, false] }
    const source = stringifyToml(table)
    expect(source).toContain('tags = ["a", "b"]')
    expect(Bun.TOML.parse(source)).toEqual(table)
  })

  test("rejects unsupported shapes and unrepresentable control characters", () => {
    expect(() => stringifyToml({ bad: [{ table: true }, "scalar"] })).toThrow(
      "arrays mixing tables with other values",
    )
    expect(() => stringifyToml({ bad: Number.POSITIVE_INFINITY })).toThrow("non-finite")
    expect(() => stringifyToml({ bad: `bel ${String.fromCharCode(7)}` })).toThrow("control character U+0007")
  })
})
