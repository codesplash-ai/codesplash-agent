/**
 * Persisted per-folder workspace trust decisions. Trust gates project rule-file injection and
 * the project permission tier; the store lives in the harness data directory, keyed by the
 * canonical (realpath) workspace path so symlinked spellings of the same folder share one
 * decision. A corrupt or unreadable store reads as empty and is rewritten on the next write —
 * never a crash.
 */
import { chmod, mkdir, readFile, realpath, rename } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { dataDirectory } from "./config.ts"

export type TrustDecision = {
  trusted: boolean
  /** ISO-8601 timestamp of when the decision was made. */
  decidedAt: string
}

type TrustStore = {
  version: 1
  folders: Record<string, TrustDecision>
}

export function trustStorePath(dataDir = dataDirectory()): string {
  return join(dataDir, "trusted-folders.json")
}

/** Canonical store key for a workspace: its realpath, falling back to resolve() when it fails. */
async function canonicalWorkspaceKey(workspacePath: string): Promise<string> {
  try {
    return await realpath(workspacePath)
  } catch {
    return resolve(workspacePath)
  }
}

export async function readTrustDecision(
  workspacePath: string,
  dataDir?: string,
): Promise<TrustDecision | undefined> {
  const store = await readTrustStore(trustStorePath(dataDir))
  return store.folders[await canonicalWorkspaceKey(workspacePath)]
}

export async function writeTrustDecision(
  workspacePath: string,
  trusted: boolean,
  dataDir?: string,
): Promise<void> {
  const path = trustStorePath(dataDir)
  const store = await readTrustStore(path)
  store.folders[await canonicalWorkspaceKey(workspacePath)] = {
    trusted,
    decidedAt: new Date().toISOString(),
  }

  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${process.pid}.tmp`
  await Bun.write(temporaryPath, `${JSON.stringify(store, null, 2)}\n`)
  await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, path)
}

/** Missing, unreadable, or corrupt stores read as empty; malformed entries are dropped. */
async function readTrustStore(path: string): Promise<TrustStore> {
  const empty: TrustStore = { version: 1, folders: {} }

  let source: string
  try {
    source = await readFile(path, "utf8")
  } catch {
    return empty
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return empty
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.folders)) return empty

  const folders: Record<string, TrustDecision> = {}
  for (const [key, entry] of Object.entries(parsed.folders)) {
    if (isRecord(entry) && typeof entry.trusted === "boolean" && typeof entry.decidedAt === "string") {
      folders[key] = { trusted: entry.trusted, decidedAt: entry.decidedAt }
    }
  }
  return { version: 1, folders }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
