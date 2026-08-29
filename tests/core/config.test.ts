import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  applyConfigOverrides,
  type CustomProviderConfig,
  configDirectory,
  dataDirectory,
  defaultConfig,
  defaultKeyEnvVar,
  loadConfig,
  saveConfig,
  validateConfig,
} from "../../src/core/config.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe("agent config", () => {
  test("defaults to the full default config when no file exists", async () => {
    const directory = await temporaryDirectory()
    expect(await loadConfig(join(directory, "config.toml"))).toEqual(defaultConfig)
  })

  test("persists the full versioned config and round-trips it", async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, "nested", "config.toml")
    const config = {
      schemaVersion: 1 as const,
      theme: "light" as const,
      history: { enabled: false },
      codex: { sandbox: "read-only" as const, approvalPolicy: "untrusted" as const },
      codesplash: {},
      providers: [],
    }

    await saveConfig(config, path)

    expect(await loadConfig(path)).toEqual(config)
    expect(await readFile(path, "utf8")).toBe(
      [
        "schemaVersion = 1",
        'theme = "light"',
        "",
        "[history]",
        "enabled = false",
        "",
        "[codex]",
        'sandbox = "read-only"',
        'approvalPolicy = "untrusted"',
        "",
      ].join("\n"),
    )
  })

  test("fills defaults for omitted fields and ignores unknown keys", async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, "config.toml")
    await Bun.write(path, 'schemaVersion = 1\ntheme = "dark"\nfutureSetting = "x"\n[future]\nkey = 1\n')

    expect(await loadConfig(path)).toEqual({ ...structuredClone(defaultConfig), theme: "dark" })
  })

  test("aggregates every invalid field into one actionable error", async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, "config.toml")
    await Bun.write(
      path,
      [
        "schemaVersion = 2",
        'theme = "green"',
        "[history]",
        'enabled = "yes"',
        "[codex]",
        'sandbox = "yolo"',
      ].join("\n"),
    )

    const error = await loadConfig(path).then(
      () => null,
      (thrown: Error) => thrown,
    )
    expect(error?.message).toContain(`Invalid config at ${path}:`)
    expect(error?.message).toContain("schemaVersion: got 2, expected 1")
    expect(error?.message).toContain('theme: got "green", expected "system", "dark", or "light"')
    expect(error?.message).toContain('[history].enabled: got "yes", expected true or false')
    expect(error?.message).toContain('[codex].sandbox: got "yolo", expected "read-only" or "workspace-write"')
  })

  test("rejects danger-full-access as a persisted default", async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, "config.toml")
    await Bun.write(path, 'schemaVersion = 1\n[codex]\nsandbox = "danger-full-access"\n')

    expect(loadConfig(path)).rejects.toThrow("full access requires the --full-access flag per session")
  })

  test("parses [codesplash].fallbackModel and full [providers.*] tables with defaults applied", async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, "config.toml")
    await Bun.write(
      path,
      [
        "schemaVersion = 1",
        "[codesplash]",
        'fallbackModel = "gpt-5.1"',
        "[providers.ollama]",
        'protocol = "openai"',
        'baseUrl = "http://localhost:11434/v1"',
        "requiresKey = false",
        "[[providers.ollama.models]]",
        'id = "qwen3:8b"',
        "[[providers.ollama.models]]",
        'id = "llama4:70b"',
        'displayName = "Llama 4 70B"',
        "contextWindow = 32768",
        "maxOutputTokens = 8192",
        "supportsReasoning = true",
        "[providers.ollama.models.pricing]",
        "inputPerMTok = 0.0",
        "outputPerMTok = 0.0",
      ].join("\n"),
    )

    const config = await loadConfig(path)
    expect(config.codesplash.fallbackModel).toBe("gpt-5.1")
    expect(config.providers).toEqual([
      {
        id: "ollama",
        protocol: "openai",
        baseUrl: "http://localhost:11434/v1",
        displayName: "Ollama",
        keyEnvVar: "OLLAMA_API_KEY",
        requiresKey: false,
        models: [
          {
            id: "qwen3:8b",
            displayName: "qwen3:8b",
            contextWindow: 128_000,
            maxOutputTokens: 16_384,
            supportsReasoning: false,
            // No model sets default = true, so the first one is the default.
            isDefault: true,
          },
          {
            id: "llama4:70b",
            displayName: "Llama 4 70B",
            contextWindow: 32_768,
            maxOutputTokens: 8_192,
            supportsReasoning: true,
            isDefault: false,
            pricing: { inputPerMTok: 0, outputPerMTok: 0 },
          },
        ],
      },
    ])
  })

  test("aggregates custom provider validation errors: bad protocol, missing baseUrl, bad ids", () => {
    const parsed = {
      providers: {
        Broken: { protocol: "openai", baseUrl: "http://x", models: [{ id: "m1" }] },
        anthropic: { protocol: "anthropic", baseUrl: "http://x", models: [{ id: "m2" }] },
        weird: { protocol: "grpc", models: [{ id: "m3" }] },
        empty: { protocol: "openai", baseUrl: "http://x", models: [] },
      },
    }

    const error = capture(() => validateConfig(parsed, "test.toml"))
    expect(error.message).toContain("[providers.Broken]: provider ids must match")
    expect(error.message).toContain('[providers.anthropic]: "anthropic" is a built-in provider')
    expect(error.message).toContain(
      '[providers.weird].protocol: got "grpc", expected "anthropic" or "openai"',
    )
    expect(error.message).toContain("[providers.weird].baseUrl: required for custom providers")
    expect(error.message).toContain(
      "[providers.empty].models: at least one [[providers.empty.models]] table is required",
    )
  })

  test("refuses API keys inside [providers.*] without echoing the value, naming the env var", () => {
    const parsed = {
      providers: {
        ollama: {
          protocol: "openai",
          baseUrl: "http://localhost:11434/v1",
          key: "sk-super-secret-value-1234567890",
          apiKey: "sk-other-secret-value-1234567890",
          models: [{ id: "qwen3:8b" }],
        },
      },
    }

    const error = capture(() => validateConfig(parsed, "test.toml"))
    expect(error.message).toContain(
      "[providers.ollama].key: API keys never live in config.toml; set the OLLAMA_API_KEY environment variable instead",
    )
    expect(error.message).toContain("[providers.ollama].apiKey: API keys never live in config.toml")
    expect(error.message).not.toContain("sk-super-secret-value-1234567890")
    expect(error.message).not.toContain("sk-other-secret-value-1234567890")
  })

  test("refuses common credential-field aliases case-insensitively, in providers and models", () => {
    // A user who writes api_key/token/etc. must get the same refusal — not a silently ignored
    // unknown field that leaves their secret sitting in plaintext on disk, unused.
    const aliasCases = ["api_key", "api-key", "API_KEY", "Token", "secret", "password", "bearer"]
    for (const alias of aliasCases) {
      const parsed = {
        providers: {
          ollama: {
            protocol: "openai",
            baseUrl: "http://localhost:11434/v1",
            [alias]: "super-secret-value-1234567890",
            models: [{ id: "qwen3:8b" }],
          },
        },
      }
      const error = capture(() => validateConfig(parsed, "test.toml"))
      expect(error.message).toContain(
        `[providers.ollama].${alias}: API keys never live in config.toml; set the OLLAMA_API_KEY environment variable instead`,
      )
      expect(error.message).not.toContain("super-secret-value-1234567890")
    }

    // The alias refusal covers [[providers.*.models]] tables too.
    const modelParsed = {
      providers: {
        ollama: {
          protocol: "openai",
          baseUrl: "http://localhost:11434/v1",
          models: [{ id: "qwen3:8b", api_key: "super-secret-value-1234567890" }],
        },
      },
    }
    const modelError = capture(() => validateConfig(modelParsed, "test.toml"))
    expect(modelError.message).toContain(
      "[[providers.ollama.models]] #1.api_key: API keys never live in config.toml",
    )

    // Legitimate fields whose names merely contain "key" are untouched.
    const fine = validateConfig(
      {
        providers: {
          ollama: {
            protocol: "openai",
            baseUrl: "http://localhost:11434/v1",
            keyEnvVar: "MY_OLLAMA_KEY",
            requiresKey: false,
            models: [{ id: "qwen3:8b" }],
          },
        },
      },
      "test.toml",
    )
    expect(fine.providers[0]?.keyEnvVar).toBe("MY_OLLAMA_KEY")
  })

  test("rejects duplicate model ids across the whole config", () => {
    const parsed = {
      providers: {
        first: { protocol: "openai", baseUrl: "http://a", requiresKey: false, models: [{ id: "shared" }] },
        second: { protocol: "openai", baseUrl: "http://b", requiresKey: false, models: [{ id: "shared" }] },
      },
    }

    const error = capture(() => validateConfig(parsed, "test.toml"))
    expect(error.message).toContain(
      '[[providers.second.models]] #1.id: duplicate model id "shared" (already defined by [providers.first])',
    )
  })

  test("saveConfig round-trips [codesplash] and every [providers.*] table", async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, "config.toml")
    const providers: CustomProviderConfig[] = [
      {
        id: "ollama",
        protocol: "openai",
        baseUrl: "http://localhost:11434/v1",
        displayName: "Ollama",
        keyEnvVar: "OLLAMA_API_KEY",
        requiresKey: false,
        models: [
          {
            id: "qwen3:8b",
            displayName: "Qwen3 8B",
            contextWindow: 32_768,
            maxOutputTokens: 8_192,
            supportsReasoning: false,
            isDefault: true,
            pricing: { inputPerMTok: 0, outputPerMTok: 0 },
          },
        ],
      },
      {
        id: "my-gateway",
        protocol: "anthropic",
        baseUrl: "https://gateway.example.com",
        displayName: "My gateway",
        keyEnvVar: "MY_GATEWAY_API_KEY",
        requiresKey: true,
        models: [
          {
            id: "claude-proxy",
            displayName: "claude-proxy",
            contextWindow: 128_000,
            maxOutputTokens: 16_384,
            supportsReasoning: true,
            isDefault: true,
          },
        ],
      },
    ]
    const config = {
      ...structuredClone(defaultConfig),
      codesplash: { fallbackModel: "gpt-5.1" },
      providers,
    }

    await saveConfig(config, path)
    expect(await loadConfig(path)).toEqual(config)

    // A settings toggle (theme flip) re-saving the loaded config must not drop the tables.
    const reloaded = await loadConfig(path)
    reloaded.theme = "dark"
    await saveConfig(reloaded, path)
    expect(await loadConfig(path)).toEqual({ ...config, theme: "dark" })
  })

  test("applyConfigOverrides parses TOML scalars and falls back to raw strings", () => {
    const result = applyConfigOverrides({ theme: "light", codex: { sandbox: "read-only" } }, [
      "theme=dark",
      "history.enabled=false",
      "codesplash.fallbackModel=gpt-5.1",
      "providers.ollama.requiresKey=false",
    ]) as Record<string, unknown>

    expect(result.theme).toBe("dark")
    expect(result.history).toEqual({ enabled: false })
    // "gpt-5.1" is not a bare TOML scalar, so it falls back to the raw string.
    expect(result.codesplash).toEqual({ fallbackModel: "gpt-5.1" })
    expect(result.providers).toEqual({ ollama: { requiresKey: false } })
    expect(result.codex).toEqual({ sandbox: "read-only" })

    const quoted = applyConfigOverrides({}, ['theme="dark"', "count=3"]) as Record<string, unknown>
    expect(quoted.theme).toBe("dark")
    expect(quoted.count).toBe(3)
  })

  test("applyConfigOverrides does not mutate its input and returns it untouched for no overrides", () => {
    const parsed = { theme: "light" }
    expect(applyConfigOverrides(parsed, [])).toBe(parsed)
    applyConfigOverrides(parsed, ["theme=dark"])
    expect(parsed.theme).toBe("light")
  })

  test("applyConfigOverrides rejects malformed overrides without echoing secret-shaped values", () => {
    expect(() => applyConfigOverrides({}, ["no-equals-here"])).toThrow(
      'Invalid config override "no-equals-here": expected dotted.path=value',
    )
    expect(() => applyConfigOverrides({}, ["=value"])).toThrow("the key path is empty")
    expect(() => applyConfigOverrides({}, ["a..b=1"])).toThrow("the key path is empty")

    // A pasted credential missing its key= prefix must not be echoed back by the error.
    const error = capture(() => applyConfigOverrides({}, ["sk-abcdef1234567890abcdef"]))
    expect(error.message).toContain("Invalid config override")
    expect(error.message).not.toContain("sk-abcdef1234567890abcdef")
  })

  test("defaultKeyEnvVar upper-cases the provider id and maps non-alphanumerics to underscores", () => {
    expect(defaultKeyEnvVar("ollama")).toBe("OLLAMA_API_KEY")
    expect(defaultKeyEnvVar("my-gateway")).toBe("MY_GATEWAY_API_KEY")
  })

  // The implementation uses node:path.join, so expected values are built the same
  // way — on Windows hosts the separators are backslashes for every platform arg.
  test("uses the platform config directory and supports a test override", () => {
    expect(configDirectory({ CODESPLASH_AGENT_CONFIG_DIR: "/custom" }, "darwin", "/Users/test")).toBe(
      "/custom",
    )
    expect(configDirectory({}, "darwin", "/Users/test")).toBe(
      join("/Users/test", "Library", "Application Support", "codesplash-agent"),
    )
    expect(configDirectory({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/test")).toBe(
      join("/xdg", "codesplash-agent"),
    )
  })

  test("uses the platform data directory and supports a test override", () => {
    expect(dataDirectory({ CODESPLASH_AGENT_DATA_DIR: "/data" }, "linux", "/home/test")).toBe("/data")
    expect(dataDirectory({}, "darwin", "/Users/test")).toBe(
      join("/Users/test", "Library", "Application Support", "codesplash-agent"),
    )
    expect(dataDirectory({ XDG_DATA_HOME: "/xdg-data" }, "linux", "/home/test")).toBe(
      join("/xdg-data", "codesplash-agent"),
    )
    expect(dataDirectory({}, "linux", "/home/test")).toBe(
      join("/home/test", ".local", "share", "codesplash-agent"),
    )
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codesplash-agent-config-"))
  temporaryDirectories.push(directory)
  return directory
}

function capture(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    if (error instanceof Error) return error
    throw new Error(`expected an Error, got ${String(error)}`)
  }
  throw new Error("expected the call to throw")
}
