/**
 * Credential store for the first-party CodeSplash engine. API keys resolve with precedence
 * env var > stored credential; storage is a single `credentials.json` in the harness config
 * directory, written atomically with 0600 permissions like the config file. No OS keychain in
 * this cut (passing keys through `security`'s argv would leak them to `ps`).
 *
 * Keys must NEVER appear in errors, logs, doctor output, or test snapshots — every message this
 * module produces names paths and providers only, and malformed store content (which could
 * contain key text) is tolerated silently rather than echoed by a parser error.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  indexKeyring,
  keyringDelete,
  keyringGet,
  keyringProviders,
  keyringSet,
} from "../../core/identity/keyring.ts"
import { assertIdentityAllowed } from "../../core/identity/policy.ts"
import { configDirectory } from "../../core/index.ts"
import type { ProviderId } from "./contracts.ts"

export type ApiKeySource = "env" | "stored"

export type ResolvedApiKey = { key: string; source: ApiKeySource }

/** Environment variable each provider's adapter reads its key from. */
export const PROVIDER_ENV_VARS: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
}

const PROVIDER_IDS = Object.keys(PROVIDER_ENV_VARS) as ProviderId[]

/** On-disk shape of credentials.json. Unknown or invalid content degrades to an empty store. */
type CredentialStore = {
  schemaVersion: 1
  keys: Partial<Record<ProviderId, string>>
}

export function credentialsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDirectory(env), "credentials.json")
}

/**
 * Resolves the API key for a provider: a non-empty environment variable wins, then the stored
 * credential; undefined when neither is present. A variable that is set but blank is an explicit
 * suppression (`OPENAI_API_KEY="" codesplash ...`) and hides the stored credential too, matching
 * applyStoredCredentials.
 */
export function resolveApiKey(
  provider: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedApiKey | undefined {
  const fromEnv = env[envVarFor(provider)]
  if (isPresent(fromEnv)) {
    assertIdentityAllowed("api-key", undefined, provider, env)
    return { key: fromEnv, source: "env" }
  }
  if (fromEnv !== undefined) return undefined
  const stored = readStore(credentialsFilePath(env)).keys[provider]
  if (stored !== undefined) {
    assertIdentityAllowed("api-key", undefined, provider, env)
    return { key: stored, source: "stored" }
  }
  return undefined
}

/** Stores an API key for a provider. The key is trimmed and must be non-empty. */
export function setApiKey(provider: ProviderId, key: string, env: NodeJS.ProcessEnv = process.env): void {
  envVarFor(provider)
  assertIdentityAllowed("api-key", undefined, provider, env)
  const trimmed = typeof key === "string" ? key.trim() : ""
  if (trimmed === "") throw new Error("API key must be a non-empty string")
  if (keyringProviders(configDirectory(env)).includes(provider))
    throw new Error("This provider uses the OS credential store; use login --keyring to replace it")
  const path = credentialsFilePath(env)
  const store = readStore(path)
  store.keys[provider] = trimmed
  writeStore(path, store)
}

/** Removes a stored API key. Returns true when a credential was actually removed. */
export function deleteApiKey(provider: ProviderId, env: NodeJS.ProcessEnv = process.env): boolean {
  envVarFor(provider)
  const path = credentialsFilePath(env)
  const store = readStore(path)
  if (store.keys[provider] === undefined) return false
  delete store.keys[provider]
  writeStore(path, store)
  return true
}

/** Env var name -> value applyStoredCredentials injected from the store in this process. */
const injectedCredentials = new Map<string, string>()

/**
 * Fills each provider's environment variable from the store when it is absent, so provider
 * adapters keep reading env only. A variable that is set — even to a blank value — is left
 * alone: `OPENAI_API_KEY="" codesplash run ...` explicitly suppresses the stored credential.
 * Call before probe/openSession/run.
 */
export function applyStoredCredentials(env: NodeJS.ProcessEnv = process.env): void {
  const store = readStore(credentialsFilePath(env))
  for (const provider of PROVIDER_IDS) {
    const name = PROVIDER_ENV_VARS[provider]
    if (env[name] !== undefined) continue
    const stored = store.keys[provider]
    if (stored !== undefined) {
      env[name] = stored
      injectedCredentials.set(name, stored)
    }
  }
}

/**
 * A copy of `env` without the API keys applyStoredCredentials injected from the credential
 * store. Spawned commands (bash tool children) must not inherit a credential the user never
 * exported in their shell; a key that was already present in the environment flows through
 * untouched (values are compared, so an unrelated same-named variable is never stripped).
 */
export function spawnEnvWithoutStoredCredentials(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = { ...env }
  for (const [name, value] of injectedCredentials) {
    if (sanitized[name] === value) delete sanitized[name]
  }
  return sanitized
}

function envVarFor(provider: ProviderId): string {
  // The lookup can miss at runtime when a caller passes junk despite the types.
  const envVar: string | undefined = PROVIDER_ENV_VARS[provider]
  // Never interpolate the argument: a caller mixing up arguments must not leak a key here.
  if (envVar === undefined) throw new Error('Unknown provider; expected "anthropic" or "openai"')
  return envVar
}

function isPresent(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== ""
}

/**
 * Reads the store, tolerating a missing, malformed, or wrong-shaped file as empty. Parse errors
 * are never rethrown — their messages can quote file content, which may include key text.
 */
function readStore(path: string): CredentialStore {
  const empty: CredentialStore = { schemaVersion: 1, keys: {} }

  let source: string
  try {
    source = readFileSync(path, "utf8")
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return empty
    throw new Error(`Could not read credentials at ${path}`, { cause: error })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return empty
  }

  if (!isRecord(parsed) || !isRecord(parsed.keys)) return empty
  for (const provider of PROVIDER_IDS) {
    const key = parsed.keys[provider]
    if (typeof key !== "string") continue
    const trimmed = key.trim()
    if (trimmed !== "") empty.keys[provider] = trimmed
  }
  return empty
}

/** Atomic replace with owner-only permissions, mirroring saveConfig in src/core/config.ts. */
function writeStore(path: string, store: CredentialStore): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temporaryPath, 0o600)
  renameSync(temporaryPath, path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value
}

/** Explicit OS-store selection. The index contains names only; secrets never use process argv. */
export async function setKeyringApiKey(
  provider: ProviderId,
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  envVarFor(provider)
  assertIdentityAllowed("api-key", undefined, provider, env)
  const root = configDirectory(env)
  await keyringSet(`api:${provider}`, key.trim(), root)
  indexKeyring(provider, true, root)
  deleteApiKey(provider, env)
}
export async function hydrateKeyringCredentials(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const root = configDirectory(env)
  for (const value of keyringProviders(root)) {
    const provider = value as ProviderId,
      name = envVarFor(provider)
    if (env[name] !== undefined) continue
    assertIdentityAllowed("api-key", undefined, provider, env)
    const secret = await keyringGet(`api:${provider}`, root)
    if (!secret) throw new Error("Indexed OS credential is missing; log in again")
    env[name] = secret
    injectedCredentials.set(name, secret)
  }
}
export async function deleteAllApiKeys(
  provider: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const root = configDirectory(env)
  let removed = false
  if (keyringProviders(root).includes(provider)) {
    removed = await keyringDelete(`api:${provider}`, root)
    indexKeyring(provider, false, root)
  }
  const fileRemoved = deleteApiKey(provider, env)
  const name = envVarFor(provider)
  if (env[name] !== undefined && env[name] === injectedCredentials.get(name)) {
    delete env[name]
    injectedCredentials.delete(name)
  }
  return fileRemoved || removed
}
