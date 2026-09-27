import { existsSync } from "node:fs"
import { join } from "node:path"
import { configDirectory } from "../config.ts"
import { atomic, digest, directory, json, lease } from "../session/files.ts"

/** Runtime-neutral SDK boundary; Bun.secrets structurally implements this contract. */
export type SecretStore = {
  get(options: { service: string; name: string }): Promise<string | null>
  set(options: { service: string; name: string; value: string }): Promise<void>
  delete(options: { service: string; name: string }): Promise<boolean>
}
export function secretAccount(name: string, root = configDirectory()): { service: string; name: string } {
  return { service: "codesplash-agent", name: `${digest(root).slice(0, 24)}:${name}` }
}
export async function keyringGet(
  name: string,
  root = configDirectory(),
  store: SecretStore = Bun.secrets,
): Promise<string | null> {
  try {
    return await store.get(secretAccount(name, root))
  } catch {
    throw new Error("OS credential store is unavailable or locked")
  }
}
export async function keyringSet(
  name: string,
  value: string,
  root = configDirectory(),
  store: SecretStore = Bun.secrets,
): Promise<void> {
  if (!value || value.length > 128 * 1024) throw new Error("Invalid credential size")
  try {
    await store.set({ ...secretAccount(name, root), value })
  } catch {
    throw new Error("Could not save to OS credential store; no plaintext fallback was written")
  }
}
export async function keyringDelete(
  name: string,
  root = configDirectory(),
  store: SecretStore = Bun.secrets,
): Promise<boolean> {
  try {
    return await store.delete(secretAccount(name, root))
  } catch {
    throw new Error("Could not remove OS credential")
  }
}
export function keyringProviders(root: string): string[] {
  const path = join(root, "keyring.json")
  if (!existsSync(path)) return []
  const v = json<{ version: number; providers: string[] }>(path, 4096)
  if (
    v.version !== 1 ||
    !Array.isArray(v.providers) ||
    v.providers.length > 2 ||
    v.providers.some((p) => !["anthropic", "openai"].includes(p))
  )
    throw new Error("Invalid keyring index")
  return v.providers
}
export function indexKeyring(provider: string, present: boolean, root: string): void {
  directory(root, true)
  const release = lease(root, "keyring.lease")
  try {
    const providers = keyringProviders(root).filter((p) => p !== provider)
    if (present) providers.push(provider)
    atomic(join(root, "keyring.json"), JSON.stringify({ version: 1, providers }))
  } finally {
    release()
  }
}
