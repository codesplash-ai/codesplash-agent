import { lstat, realpath } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { stableValue } from "../../../core/config/source.ts"
import type { AgentConfig } from "../../../core/config.ts"
import { atomic, digest, json, lease } from "../../../core/session/files.ts"
import { executableTrustKey, reviewExecutable } from "../executable-review.ts"

export async function reviewExtension(config: AgentConfig, id: string, cwd: string, signal?: AbortSignal) {
  const entry = config.extensions?.entries[id]
  if (!entry) throw new Error("Unknown extension")
  cwd = await realpath(cwd)
  const requested = resolve(cwd, entry.root)
  if (!(await lstat(requested)).isDirectory())
    throw new Error("Extension root must be a real directory, not a link")
  const root = await realpath(requested)
  const reviewed = await reviewExecutable(join(root, entry.entry), [], [root], cwd, signal, "Extension")
  // reviewExecutable accepts a linked top-level executable for command use; extension snapshots do not.
  for (const file of reviewed.files) {
    const path = relative(root, file.path)
    if (path.startsWith("../") || path === ".." || (await lstat(file.requested)).isSymbolicLink())
      throw new Error("Extension files must stay inside the root without symbolic links")
  }
  const prefix = `extensions.entries.${id}`
  const contributing = new Set(
    Object.entries(config.resolution?.provenance ?? {})
      .filter(([key]) => key === prefix || key.startsWith(`${prefix}.`))
      .flatMap(([, ids]) => ids),
  )
  const sources =
    config.resolution?.sources
      .filter((source) => contributing.has(source.id))
      .map(({ id, path, fingerprint }) => ({ id, ...(path ? { path } : {}), fingerprint })) ?? []
  const identity = {
    id,
    cwd,
    root,
    config: structuredClone(entry),
    sources,
    policy: {
      permissions: config.permissions,
      sandbox: config.codex.sandbox,
      sandboxConfig: config.sandbox ?? {},
      constraints: config.resolution?.constraints ?? {},
    },
    files: reviewed.files.map((file) => ({ path: relative(root, file.path), sha256: file.sha256 })),
  }
  return { ...identity, fingerprint: digest(stableValue(identity)), source: `extension:${id}` }
}
export type ExtensionReview = Awaited<ReturnType<typeof reviewExtension>>
const pathFor = (dataDir: string, review: ExtensionReview) =>
  join(dataDir, "extension-trust", `${executableTrustKey(review.cwd, review.id, review.sources)}.json`)
export function extensionTrusted(dataDir: string, review: ExtensionReview): boolean {
  try {
    const receipt = json<{ version: number; fingerprint: string }>(pathFor(dataDir, review), 4096)
    if (receipt.version !== 1 || !/^[a-f0-9]{64}$/.test(receipt.fingerprint))
      throw new Error("Invalid extension trust receipt")
    return receipt.fingerprint === review.fingerprint
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}
export function trustExtension(dataDir: string, review: ExtensionReview, fingerprint: string): void {
  if (review.fingerprint !== fingerprint)
    throw new Error("Extension changed; inspect its current fingerprint")
  const release = lease(join(dataDir, "extension-trust"), "edit.lease")
  try {
    atomic(
      pathFor(dataDir, review),
      JSON.stringify({ version: 1, fingerprint, reviewedAt: new Date().toISOString() }),
    )
  } finally {
    release()
  }
}
