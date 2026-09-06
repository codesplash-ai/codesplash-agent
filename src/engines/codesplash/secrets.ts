import { mkdir, open, readFile, rename } from "node:fs/promises"
import { join } from "node:path"
import { dataDirectory } from "../../core/config.ts"

const SERVICE = "ai.codesplash.agent.named-secrets"
export interface SecretsAdapter {
  get(options: { service: string; name: string }): Promise<string | null>
  set(options: { service: string; name: string; value: string }): Promise<void>
  delete(options: { service: string; name: string }): Promise<boolean>
}
export function validateSecretName(name: string): void {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name))
    throw new Error("Secret names use A–Z, 0–9 and _, starting with a letter (maximum 64 characters)")
}

/** Values stay in the OS keyring. The local index contains names only. */
export class NamedSecrets {
  constructor(
    readonly directory = dataDirectory(),
    readonly adapter: SecretsAdapter = Bun.secrets,
  ) {}
  async list(): Promise<string[]> {
    try {
      const names: unknown = JSON.parse(await readFile(join(this.directory, "secret-names.json"), "utf8"))
      if (
        !Array.isArray(names) ||
        names.some((n) => typeof n !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(n))
      )
        throw new Error("Invalid secret-name index")
      return names.sort()
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return []
      throw error
    }
  }
  async get(name: string): Promise<string> {
    validateSecretName(name)
    try {
      const value = await this.adapter.get({ service: SERVICE, name })
      if (!value) throw new Error("Missing")
      return value
    } catch {
      throw new Error(
        `Named secret ${name} is unavailable; use codesplash secrets set ${name} and unlock the OS keyring`,
      )
    }
  }
  async set(name: string, value: string): Promise<void> {
    validateSecretName(name)
    if (!value || Buffer.byteLength(value) > 64 * 1024 || value.includes("\0"))
      throw new Error("Secret must contain 1–65536 bytes and no NUL")
    try {
      await this.adapter.set({ service: SERVICE, name, value })
    } catch {
      throw new Error("OS keyring unavailable; no plaintext fallback was written")
    }
    await this.#index([...new Set([...(await this.list()), name])])
  }
  async delete(name: string): Promise<void> {
    validateSecretName(name)
    try {
      await this.adapter.delete({ service: SERVICE, name })
    } catch {
      throw new Error("OS keyring unavailable; secret was not deleted")
    }
    await this.#index((await this.list()).filter((n) => n !== name))
  }
  async #index(names: string[]): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const path = join(this.directory, "secret-names.json"),
      tmp = `${path}.${crypto.randomUUID()}.tmp`
    const file = await open(tmp, "wx", 0o600)
    try {
      await file.writeFile(`${JSON.stringify(names.sort())}\n`)
    } finally {
      await file.close()
    }
    await rename(tmp, path)
  }
}
