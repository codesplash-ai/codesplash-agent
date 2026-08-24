import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { statSync } from "node:fs"
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  applyStoredCredentials,
  credentialsFilePath,
  deleteApiKey,
  PROVIDER_ENV_VARS,
  resolveApiKey,
  setApiKey,
  spawnEnvWithoutStoredCredentials,
} from "../../../src/engines/codesplash/auth.ts"
import type { ProviderId } from "../../../src/engines/codesplash/contracts.ts"

const cleanups: string[] = []

afterAll(async () => {
  for (const path of cleanups) await rm(path, { recursive: true, force: true })
})

async function makeTempDir(): Promise<string> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "codesplash-auth-")))
  cleanups.push(base)
  return base
}

/** A fake process.env pointing the store at a temp CODESPLASH_AGENT_CONFIG_DIR. */
async function makeEnv(extra: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> {
  return { CODESPLASH_AGENT_CONFIG_DIR: await makeTempDir(), ...extra }
}

describe("credentialsFilePath", () => {
  test("lives in the config directory from CODESPLASH_AGENT_CONFIG_DIR", async () => {
    const env = await makeEnv()
    expect(credentialsFilePath(env)).toBe(join(env.CODESPLASH_AGENT_CONFIG_DIR as string, "credentials.json"))
  })
})

describe("round-trip", () => {
  test("setApiKey then resolveApiKey returns the stored key", async () => {
    const env = await makeEnv()
    setApiKey("anthropic", "stored-anthropic-key", env)
    expect(resolveApiKey("anthropic", env)).toEqual({ key: "stored-anthropic-key", source: "stored" })
    expect(resolveApiKey("openai", env)).toBeUndefined()
  })

  test("stores both providers independently and trims the key", async () => {
    const env = await makeEnv()
    setApiKey("anthropic", "  padded-key  ", env)
    setApiKey("openai", "openai-key", env)
    expect(resolveApiKey("anthropic", env)).toEqual({ key: "padded-key", source: "stored" })
    expect(resolveApiKey("openai", env)).toEqual({ key: "openai-key", source: "stored" })
  })

  test("overwrites an existing key for the same provider", async () => {
    const env = await makeEnv()
    setApiKey("openai", "first", env)
    setApiKey("openai", "second", env)
    expect(resolveApiKey("openai", env)).toEqual({ key: "second", source: "stored" })
  })

  test("leaves no temp files behind after writes", async () => {
    const env = await makeEnv()
    setApiKey("anthropic", "a-key", env)
    deleteApiKey("anthropic", env)
    setApiKey("openai", "o-key", env)
    const entries = await readdir(env.CODESPLASH_AGENT_CONFIG_DIR as string)
    expect(entries).toEqual(["credentials.json"])
  })

  test("rejects empty and whitespace-only keys without writing", async () => {
    const env = await makeEnv()
    expect(() => setApiKey("anthropic", "", env)).toThrow("API key must be a non-empty string")
    expect(() => setApiKey("anthropic", "   \n\t", env)).toThrow("API key must be a non-empty string")
    expect(resolveApiKey("anthropic", env)).toBeUndefined()
  })
})

describe("precedence", () => {
  test("environment variable wins over a stored credential", async () => {
    const env = await makeEnv({ ANTHROPIC_API_KEY: "env-anthropic-key" })
    setApiKey("anthropic", "stored-anthropic-key", env)
    expect(resolveApiKey("anthropic", env)).toEqual({ key: "env-anthropic-key", source: "env" })
  })

  test("a set-but-blank environment variable suppresses the stored credential", async () => {
    // `OPENAI_API_KEY="" codesplash ...` is an explicit opt-out; it must never resolve a blank
    // key, and it must not silently fall back to a credential the user asked to bypass.
    const env = await makeEnv({ OPENAI_API_KEY: "   " })
    setApiKey("openai", "stored-openai-key", env)
    expect(resolveApiKey("openai", env)).toBeUndefined()
  })

  test("environment source works with no store file at all", async () => {
    const env = await makeEnv({ OPENAI_API_KEY: "env-only" })
    expect(resolveApiKey("openai", env)).toEqual({ key: "env-only", source: "env" })
  })
})

describe("deletion", () => {
  test("deleteApiKey removes only the named provider and reports removal", async () => {
    const env = await makeEnv()
    setApiKey("anthropic", "a-key", env)
    setApiKey("openai", "o-key", env)

    expect(deleteApiKey("anthropic", env)).toBe(true)
    expect(resolveApiKey("anthropic", env)).toBeUndefined()
    expect(resolveApiKey("openai", env)).toEqual({ key: "o-key", source: "stored" })

    expect(deleteApiKey("anthropic", env)).toBe(false)
  })

  test("deleting from an absent store is a no-op", async () => {
    const env = await makeEnv()
    expect(deleteApiKey("openai", env)).toBe(false)
  })
})

describe("file permissions", () => {
  test("credentials.json is written 0600 and created directories are 0700", async () => {
    const base = await makeTempDir()
    const env: NodeJS.ProcessEnv = { CODESPLASH_AGENT_CONFIG_DIR: join(base, "nested", "config") }
    setApiKey("anthropic", "perm-check-key", env)

    const fileMode = statSync(credentialsFilePath(env)).mode & 0o777
    expect(fileMode).toBe(0o600)
    const directoryMode = statSync(join(base, "nested", "config")).mode & 0o777
    expect(directoryMode).toBe(0o700)
  })

  test("permissions stay 0600 across overwrites", async () => {
    const env = await makeEnv()
    setApiKey("openai", "one", env)
    setApiKey("openai", "two", env)
    expect(statSync(credentialsFilePath(env)).mode & 0o777).toBe(0o600)
  })
})

describe("malformed-file tolerance", () => {
  test("non-JSON content reads as an empty store and never throws", async () => {
    const env = await makeEnv()
    await writeFile(credentialsFilePath(env), "not json {{{ sk-secret-inside", "utf8")

    expect(resolveApiKey("anthropic", env)).toBeUndefined()
    expect(deleteApiKey("anthropic", env)).toBe(false)
    expect(() => applyStoredCredentials(env)).not.toThrow()
  })

  test("setApiKey replaces a malformed file with a valid store", async () => {
    const env = await makeEnv()
    await writeFile(credentialsFilePath(env), '{"keys":{"anthropic":"sk-truncated', "utf8")

    setApiKey("openai", "fresh-key", env)

    expect(resolveApiKey("openai", env)).toEqual({ key: "fresh-key", source: "stored" })
    const parsed = JSON.parse(await readFile(credentialsFilePath(env), "utf8"))
    expect(parsed).toEqual({ schemaVersion: 1, keys: { openai: "fresh-key" } })
  })

  test("wrong-shaped JSON degrades to an empty store, keeping only valid string keys", async () => {
    const env = await makeEnv()
    await writeFile(
      credentialsFilePath(env),
      JSON.stringify({ schemaVersion: 99, keys: { anthropic: "  kept-key  ", openai: 42, junk: true } }),
      "utf8",
    )

    expect(resolveApiKey("anthropic", env)).toEqual({ key: "kept-key", source: "stored" })
    expect(resolveApiKey("openai", env)).toBeUndefined()
  })

  test("JSON that is not an object reads as empty", async () => {
    const env = await makeEnv()
    await writeFile(credentialsFilePath(env), '["not", "a", "store"]', "utf8")
    expect(resolveApiKey("anthropic", env)).toBeUndefined()
  })
})

describe("key text never appears in thrown errors", () => {
  test("empty-key validation error carries no key material", async () => {
    const env = await makeEnv()
    let message = ""
    try {
      setApiKey("anthropic", "   ", env)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toBe("API key must be a non-empty string")
  })

  test("an unknown provider error never echoes the argument (a mixed-up key)", async () => {
    const env = await makeEnv()
    const leaked = "sk-super-secret-key"
    for (const call of [
      () => setApiKey(leaked as ProviderId, "whatever", env),
      () => deleteApiKey(leaked as ProviderId, env),
      () => resolveApiKey(leaked as ProviderId, env),
    ]) {
      let message = ""
      try {
        call()
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).not.toBe("")
      expect(message).not.toContain(leaked)
    }
  })
})

describe("applyStoredCredentials", () => {
  test("fills unset env vars from the store and leaves set ones alone", async () => {
    const env = await makeEnv({ ANTHROPIC_API_KEY: "env-anthropic" })
    setApiKey("anthropic", "stored-anthropic", env)
    setApiKey("openai", "stored-openai", env)

    applyStoredCredentials(env)

    expect(env.ANTHROPIC_API_KEY).toBe("env-anthropic")
    expect(env.OPENAI_API_KEY).toBe("stored-openai")
  })

  test("leaves an explicitly blank env var alone (explicit suppression)", async () => {
    const env = await makeEnv({ OPENAI_API_KEY: "" })
    setApiKey("openai", "stored-openai", env)
    applyStoredCredentials(env)
    expect(env.OPENAI_API_KEY).toBe("")
  })

  test("leaves env untouched when nothing is stored", async () => {
    const env = await makeEnv()
    applyStoredCredentials(env)
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
  })
})

describe("spawnEnvWithoutStoredCredentials", () => {
  test("strips store-injected keys and keeps shell-provided ones", async () => {
    const env = await makeEnv({ ANTHROPIC_API_KEY: "shell-anthropic-key" })
    setApiKey("openai", "stored-openai-secret", env)
    applyStoredCredentials(env)
    expect(env.OPENAI_API_KEY).toBe("stored-openai-secret")

    const spawnEnv = spawnEnvWithoutStoredCredentials(env)
    expect(spawnEnv.OPENAI_API_KEY).toBeUndefined()
    expect(spawnEnv.ANTHROPIC_API_KEY).toBe("shell-anthropic-key")
    // The provider adapters still read the injected key from the original env.
    expect(env.OPENAI_API_KEY).toBe("stored-openai-secret")
  })

  test("never strips a same-named variable whose value did not come from the store", async () => {
    const env = await makeEnv({ OPENAI_API_KEY: "shell-openai-key" })
    setApiKey("openai", "stored-openai-other", env)
    applyStoredCredentials(env)
    expect(spawnEnvWithoutStoredCredentials(env).OPENAI_API_KEY).toBe("shell-openai-key")
  })
})

describe("process.env defaults", () => {
  const saved = {
    configDir: process.env.CODESPLASH_AGENT_CONFIG_DIR,
    anthropic: process.env.ANTHROPIC_API_KEY,
    openai: process.env.OPENAI_API_KEY,
  }

  afterEach(() => {
    restore("CODESPLASH_AGENT_CONFIG_DIR", saved.configDir)
    restore("ANTHROPIC_API_KEY", saved.anthropic)
    restore("OPENAI_API_KEY", saved.openai)
  })

  function restore(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }

  /** Reads process.env through a non-literal key so `delete` narrowing does not stick. */
  function readEnv(name: string): string | undefined {
    return process.env[name]
  }

  test("all functions default to process.env", async () => {
    process.env.CODESPLASH_AGENT_CONFIG_DIR = await makeTempDir()
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY

    setApiKey("anthropic", "default-env-key")
    expect(resolveApiKey("anthropic")).toEqual({ key: "default-env-key", source: "stored" })

    applyStoredCredentials()
    expect(readEnv("ANTHROPIC_API_KEY")).toBe("default-env-key")

    expect(deleteApiKey("anthropic")).toBe(true)
    delete process.env.ANTHROPIC_API_KEY
    expect(resolveApiKey("anthropic")).toBeUndefined()
  })
})

describe("provider env var mapping", () => {
  test("matches the variables the provider adapters read", () => {
    expect(PROVIDER_ENV_VARS).toEqual({ anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" })
  })
})
