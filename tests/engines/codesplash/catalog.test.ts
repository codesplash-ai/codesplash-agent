import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig, CustomProviderConfig } from "../../../src/core/index.ts"
import { defaultConfig } from "../../../src/core/index.ts"
import {
  buildProviderRegistry,
  customProviderAvailable,
  modelCatalog,
  parseModelSelector,
} from "../../../src/engines/codesplash/catalog.ts"
import { anthropicModels } from "../../../src/engines/codesplash/providers/anthropic.ts"
import { openaiModels } from "../../../src/engines/codesplash/providers/openai.ts"

const ANTHROPIC_KEY = "unit-test-anthropic-key-value"
const OPENAI_KEY = "unit-test-openai-key-value"
const OLLAMA_KEY = "unit-test-ollama-key-value"

/** Isolated env: the credential store points at an empty temp dir so no real keys leak in. */
function environment(keys: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    CODESPLASH_AGENT_CONFIG_DIR: join(tmpdir(), `codesplash-catalog-test-${randomUUID()}`),
    ...keys,
  }
}

function config(providers: CustomProviderConfig[] = []): AgentConfig {
  return { ...structuredClone(defaultConfig), providers }
}

function ollamaProvider(overrides: Partial<CustomProviderConfig> = {}): CustomProviderConfig {
  return {
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
      {
        id: "llama4:70b",
        displayName: "llama4:70b",
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        supportsReasoning: true,
        isDefault: false,
      },
    ],
    ...overrides,
  }
}

describe("buildProviderRegistry", () => {
  test("builds built-ins only from resolvable keys, anthropic first", () => {
    const registry = buildProviderRegistry(
      config(),
      environment({ ANTHROPIC_API_KEY: ANTHROPIC_KEY, OPENAI_API_KEY: OPENAI_KEY }),
    )
    expect(registry.providers.map((runtime) => runtime.id)).toEqual(["anthropic", "openai"])
    expect(registry.providers.map((runtime) => runtime.protocol)).toEqual(["anthropic", "openai"])
    expect(registry.providers.map((runtime) => runtime.keyEnvVar)).toEqual([
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
    ])
    expect(registry.models.map((model) => model.id)).toEqual(
      [...anthropicModels, ...openaiModels].map((model) => model.id),
    )
    expect(registry.defaultModel().id).toBe("claude-fable-5")
    expect(JSON.stringify(registry.providers.map(({ client, ...rest }) => rest))).not.toContain(ANTHROPIC_KEY)
  })

  test("omits built-ins whose key does not resolve and defaults to openai without an anthropic key", () => {
    const registry = buildProviderRegistry(config(), environment({ OPENAI_API_KEY: OPENAI_KEY }))
    expect(registry.providers.map((runtime) => runtime.id)).toEqual(["openai"])
    expect(registry.defaultModel().id).toBe("gpt-5.1")
    expect(registry.find("claude-fable-5")).toBeUndefined()
  })

  test("includes a custom openai-protocol provider after the built-ins with its own models", () => {
    const registry = buildProviderRegistry(
      config([ollamaProvider()]),
      environment({ ANTHROPIC_API_KEY: ANTHROPIC_KEY }),
    )
    expect(registry.providers.map((runtime) => runtime.id)).toEqual(["anthropic", "ollama"])

    const runtime = registry.providers[1]
    expect(runtime?.protocol).toBe("openai")
    expect(runtime?.displayName).toBe("Ollama")
    expect(runtime?.baseUrl).toBe("http://localhost:11434/v1")
    expect(runtime?.requiresKey).toBe(false)
    expect(runtime?.client.id).toBe("openai")
    expect(runtime?.client.models.map((model) => model.id)).toEqual(["qwen3:8b", "llama4:70b"])

    const model = registry.find("qwen3:8b")
    expect(model).toMatchObject({
      id: "qwen3:8b",
      provider: "ollama",
      protocol: "openai",
      contextWindow: 32_768,
      maxOutputTokens: 8_192,
      isDefault: true,
      pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    })
    expect(model && registry.runtimeFor(model)).toBe(runtime)
  })

  test("a requiresKey=false provider is available without its key; requiresKey=true needs it", () => {
    const noKey = environment()
    expect(customProviderAvailable(ollamaProvider(), noKey)).toBe(true)
    expect(customProviderAvailable(ollamaProvider({ requiresKey: true }), noKey)).toBe(false)
    expect(
      customProviderAvailable(
        ollamaProvider({ requiresKey: true }),
        environment({ OLLAMA_API_KEY: OLLAMA_KEY }),
      ),
    ).toBe(true)

    const withoutKey = buildProviderRegistry(config([ollamaProvider({ requiresKey: true })]), noKey)
    expect(withoutKey.providers).toEqual([])
    const withKey = buildProviderRegistry(
      config([ollamaProvider({ requiresKey: true })]),
      environment({ OLLAMA_API_KEY: OLLAMA_KEY }),
    )
    expect(withKey.providers.map((runtime) => runtime.id)).toEqual(["ollama"])
  })

  test("defaultModel prefers anthropic, then openai, then the first custom provider", () => {
    const custom = config([ollamaProvider()])
    expect(
      buildProviderRegistry(custom, environment({ ANTHROPIC_API_KEY: ANTHROPIC_KEY })).defaultModel().id,
    ).toBe("claude-fable-5")
    expect(buildProviderRegistry(custom, environment({ OPENAI_API_KEY: OPENAI_KEY })).defaultModel().id).toBe(
      "gpt-5.1",
    )
    expect(buildProviderRegistry(custom, environment()).defaultModel().id).toBe("qwen3:8b")
    expect(() => buildProviderRegistry(config(), environment()).defaultModel()).toThrow(
      "No providers available",
    )
  })

  test("parseSelector matches an id containing colons before splitting off an effort", () => {
    const registry = buildProviderRegistry(
      config([ollamaProvider()]),
      environment({ ANTHROPIC_API_KEY: ANTHROPIC_KEY }),
    )
    expect(registry.parseSelector("qwen3:8b").model.id).toBe("qwen3:8b")
    expect(registry.parseSelector("claude-fable-5:high")).toMatchObject({
      model: { id: "claude-fable-5" },
      effort: "high",
    })
    expect(() => registry.parseSelector("gpt-5.1")).toThrow('Unknown model "gpt-5.1"')
    expect(() => registry.parseSelector("claude-fable-5:extreme")).toThrow("Invalid reasoning effort")
  })
})

describe("static catalog compatibility surface", () => {
  test("parseModelSelector still parses the built-in catalog", () => {
    expect(parseModelSelector("claude-fable-5:low")).toMatchObject({
      model: { id: "claude-fable-5" },
      effort: "low",
    })
    expect(() => parseModelSelector("nope")).toThrow('Unknown model "nope"')
  })

  test("every built-in model names its runtime provider and protocol identically", () => {
    for (const model of modelCatalog) {
      expect(model.provider).toBe(model.protocol)
    }
  })
})
