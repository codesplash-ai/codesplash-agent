import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { stableValue } from "../../../core/config/source.ts"
import type { AgentConfig } from "../../../core/config.ts"
import { atomic, digest, json, lease } from "../../../core/session/files.ts"
import { type ExecutableReview, executableTrustKey, reviewExecutable } from "../executable-review.ts"
import type { HookHandlerConfig } from "./config.ts"

export type HookReview = {
  id: string
  cwd: string
  fingerprint: string
  config: HookHandlerConfig
  source: string
  sources: Array<{ id: string; path?: string; fingerprint: string }>
  policy: Record<string, unknown>
  argv?: string[]
  files: ExecutableReview["files"]
  managed: boolean
}
export async function reviewHook(
  config: AgentConfig,
  id: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<HookReview> {
  const handler = config.hooks?.handlers[id]
  if (!handler) throw new Error("Unknown hook handler")
  cwd = await realpath(cwd)
  const executable =
    handler.kind === "command"
      ? await reviewExecutable(
          handler.command ?? "",
          handler.args ?? [],
          handler.trustFiles ?? [],
          cwd,
          signal,
          "Hook",
        )
      : undefined
  const prefix = `hooks.handlers.${id}`
  const fields = Object.entries(config.resolution?.provenance ?? {}).filter(
    ([key]) => key === prefix || key.startsWith(`${prefix}.`),
  )
  const contributing = new Set(fields.flatMap(([, sources]) => sources))
  const sources =
    config.resolution?.sources
      .filter((source) => contributing.has(source.id))
      .map(({ id, path, fingerprint }) => ({ id, ...(path ? { path } : {}), fingerprint })) ?? []
  const isManaged = fields.length > 0 && fields.every(([, sources]) => sources.at(-1) === "managed")
  const identity = {
    id,
    cwd,
    config: structuredClone(handler),
    sources,
    policy: {
      sandbox: config.codex.sandbox,
      sandboxConfig: config.sandbox ?? {},
      permissions: config.permissions,
      constraints: config.resolution?.constraints ?? {},
      continuation: config.hooks?.continuation,
    },
    files: executable?.files ?? [],
    managed: isManaged,
  }
  return {
    ...identity,
    source: `hook:${id}`,
    fingerprint: digest(stableValue(identity)),
    ...(executable ? { argv: executable.argv } : {}),
  }
}
const pathFor = (dataDir: string, review: HookReview) =>
  join(dataDir, "hook-trust", `${executableTrustKey(review.cwd, review.id, review.sources)}.json`)
export function hookTrusted(dataDir: string, review: HookReview): boolean {
  try {
    const receipt = json<{ version: number; fingerprint: string }>(pathFor(dataDir, review), 4096)
    if (receipt.version !== 1 || !/^[a-f0-9]{64}$/.test(receipt.fingerprint))
      throw new Error("Invalid hook trust receipt")
    return receipt.fingerprint === review.fingerprint
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}
export function trustHook(dataDir: string, review: HookReview, fingerprint: string): void {
  if (review.fingerprint !== fingerprint)
    throw new Error("Hook source changed; inspect the current fingerprint before trusting")
  const release = lease(join(dataDir, "hook-trust"), "edit.lease")
  try {
    atomic(
      pathFor(dataDir, review),
      JSON.stringify({ version: 1, fingerprint, reviewedAt: new Date().toISOString() }),
    )
  } finally {
    release()
  }
}
