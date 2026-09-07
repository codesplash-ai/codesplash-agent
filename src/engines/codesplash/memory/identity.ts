import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { safeGitArguments, safeGitEnvironment } from "../../../core/git-process.ts"
import { runProcess } from "../sandbox/process.ts"
import { physicalPath } from "../sandbox/profile.ts"
import { MEMORY_ID, type MemoryIdentity } from "./contracts.ts"
import { atomicWrite, locked, readBounded } from "./files.ts"
export const memoryHash = (text: string) => createHash("sha256").update(text).digest("hex")
type Registry = Record<string, { id: string; location: string }>
function registry(root: string): Registry {
  if (!existsSync(join(root, "repositories.json"))) return {}
  const data: unknown = JSON.parse(readBounded(join(root, "repositories.json")))
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.entries(data).some(
      ([key, value]) =>
        !/^[0-9a-f]{64}$/.test(key) ||
        !value ||
        typeof value !== "object" ||
        !("id" in value) ||
        !MEMORY_ID.test(String(value.id)) ||
        !("location" in value) ||
        typeof value.location !== "string",
    )
  )
    throw new Error("Invalid memory repository registry")
  return data as Registry
}
export async function memoryIdentity(
  root: string,
  cwd: string,
  signal: AbortSignal,
): Promise<MemoryIdentity> {
  const directory = physicalPath(cwd)
  const result = await runProcess(
    ["git", ...safeGitArguments(["rev-parse", "--show-toplevel", "--git-common-dir"])],
    {
      cwd: directory,
      env: safeGitEnvironment(),
      signal,
      timeoutMs: 3000,
      maxBytes: 8192,
    },
  )
  signal.throwIfAborted()
  const [toplevel, common] = result.stdout.trim().split("\n")
  const isGit = result.exitCode === 0 && !!toplevel && !!common
  const worktree = isGit ? physicalPath(toplevel) : directory
  const location = isGit ? physicalPath(resolve(directory, common)) : directory
  const key = memoryHash(`${isGit ? "git" : "directory"}:${location}`)
  return { key, worktree: memoryHash(worktree), location, repository: registry(root)[key]?.id }
}
export function ensureIdentity(root: string, identity: MemoryIdentity): string {
  return locked(root, () => {
    const data = registry(root)
    const id = data[identity.key]?.id ?? crypto.randomUUID()
    if (!data[identity.key]) {
      data[identity.key] = { id, location: identity.location }
      atomicWrite(join(root, "repositories.json"), JSON.stringify(data))
    }
    identity.repository = id
    return id
  })
}
export function linkIdentity(root: string, identity: MemoryIdentity, target: string, apply = false): string {
  if (!MEMORY_ID.test(target)) throw new Error("Link requires a repository UUID from memory status")
  const action = () => {
    const data = registry(root)
    if (!Object.values(data).some((entry) => entry.id === target))
      throw new Error("Unknown memory repository UUID")
    const previous = data[identity.key]?.id
    if (previous && previous !== target && existsSync(join(root, previous, "manifest.json"))) {
      const manifest = JSON.parse(readBounded(join(root, previous, "manifest.json"))) as { records?: object }
      if (
        !manifest.records ||
        typeof manifest.records !== "object" ||
        Array.isArray(manifest.records) ||
        Object.keys(manifest.records).length
      )
        throw new Error("Current location already has memory; refusing to abandon its records")
    }
    if (apply) {
      data[identity.key] = { id: target, location: identity.location }
      atomicWrite(join(root, "repositories.json"), JSON.stringify(data))
      identity.repository = target
    }
    return `${apply ? "Linked" : "Preview"}: ${identity.location} → ${target}${apply ? "" : "\nUse --apply to link this location."}`
  }
  return apply ? locked(root, action) : action()
}
