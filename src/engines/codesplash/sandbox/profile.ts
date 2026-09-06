import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { mkdir, open, readFile, rename } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { configDirectory, dataDirectory, type SandboxMode } from "../../../core/config.ts"
import type { AccessGrant, NativeSandboxConfig, SandboxProfile } from "./contracts.ts"
import { validateEnvironmentName } from "./env-policy.ts"

export function physicalPath(path: string): string {
  let cursor = resolve(path)
  const tail: string[] = []
  while (true) {
    try {
      return join(realpathSync(cursor), ...tail.reverse())
    } catch {
      const parent = dirname(cursor)
      if (parent === cursor) throw new Error("Cannot resolve sandbox path")
      tail.push(cursor.slice(parent.length).replace(/^\//, ""))
      cursor = parent
    }
  }
}
export function contains(root: string, path: string): boolean {
  return root === path || path.startsWith(root.endsWith(sep) ? root : root + sep)
}
function unique(items: string[]): string[] {
  return [...new Set(items)].sort()
}
export function canonicalHost(value: string): string {
  if (!/^[a-zA-Z0-9.-]+:[0-9]{1,5}$/.test(value))
    throw new Error("Network access requires an exact hostname:port (no wildcards, IP literals, or URLs)")
  const url = new URL(`https://${value}`)
  const host = url.hostname.toLowerCase().replace(/\.+$/, "")
  const port = Number(value.slice(value.lastIndexOf(":") + 1))
  if (
    port < 1 ||
    port > 65535 ||
    /^[\d.]+$/.test(host) ||
    !host.includes(".") ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    !host.split(".").every((p) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(p))
  )
    throw new Error("Network grants require a public DNS hostname and a valid port")
  return `${host}:${port}`
}
function absoluteRoot(path: string): string {
  if (!isAbsolute(path) || [...path].some((char) => char.charCodeAt(0) < 32 || "*?[]{}".includes(char)))
    throw new Error("Sandbox roots must be absolute literal paths")
  return physicalPath(path)
}
function hashProfile(data: Omit<SandboxProfile, "hash">): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex")
}
export function createProfile(
  cwd: string,
  mode: SandboxMode,
  config: NativeSandboxConfig = {},
): SandboxProfile {
  cwd = physicalPath(cwd)
  const home = physicalPath(homedir())
  const protectedPaths = [
    configDirectory(),
    dataDirectory(),
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".codex"),
    join(home, ".claude"),
    join(cwd, ".git"),
    join(cwd, ".codesplash"),
  ].map(physicalPath)
  // Resolve worktree metadata without executing repository-controlled Git helpers.
  const dotGit = join(cwd, ".git")
  if (existsSync(dotGit) && statSync(dotGit).isFile()) {
    const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, "utf8"))
    if (!match?.[1]) throw new Error("Invalid worktree .git pointer")
    const gitdir = physicalPath(resolve(cwd, match[1].trim()))
    protectedPaths.push(gitdir)
    const common = join(gitdir, "commondir")
    if (existsSync(common))
      protectedPaths.push(physicalPath(resolve(gitdir, readFileSync(common, "utf8").trim())))
  }
  const readRoots = unique([cwd, ...(config.readRoots ?? []).map(absoluteRoot)])
  const writeRoots = unique([
    ...(mode === "workspace-write" ? [cwd] : []),
    ...(mode === "workspace-write" ? (config.writeRoots ?? []) : []).map(absoluteRoot),
  ])
  for (const name of config.environment ?? []) validateEnvironmentName(name)
  const data: Omit<SandboxProfile, "hash"> = {
    version: 1,
    cwd,
    mode,
    readRoots,
    writeRoots,
    protectedPaths: unique(protectedPaths),
    deniedReadPaths: unique(
      [
        configDirectory(),
        dataDirectory(),
        join(home, ".ssh"),
        join(home, ".aws"),
        join(home, ".codex"),
        join(home, ".claude"),
      ].map(physicalPath),
    ),
    allowedHosts: unique((config.allowedHosts ?? []).map(canonicalHost)),
    environment: unique(config.environment ?? []),
  }
  return { ...data, hash: hashProfile(data) }
}

export function validateProfile(value: unknown): SandboxProfile {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid pinned sandbox profile")
  const p = value as SandboxProfile
  if (
    p.version !== 1 ||
    !["read-only", "workspace-write", "danger-full-access"].includes(p.mode) ||
    typeof p.cwd !== "string" ||
    typeof p.hash !== "string"
  )
    throw new Error("Unsupported pinned sandbox profile; start a new session")
  for (const key of [
    "readRoots",
    "writeRoots",
    "protectedPaths",
    "deniedReadPaths",
    "allowedHosts",
    "environment",
  ] as const) {
    if (!Array.isArray(p[key]) || p[key].some((v) => typeof v !== "string"))
      throw new Error("Invalid pinned sandbox profile")
  }
  const { hash, ...data } = p
  if (hash !== hashProfile(data))
    throw new Error("Pinned sandbox profile integrity check failed; start a new session")
  return p
}

/** Called before model/tool work. Unknown/corrupt profiles never become a fresh unrestricted session. */
export async function pinProfile(profile: SandboxProfile, path?: string): Promise<SandboxProfile> {
  if (!path) return profile
  try {
    const recorded = validateProfile(JSON.parse(await readFile(path, "utf8")))
    if (recorded.hash !== profile.hash)
      throw new Error(
        "Sandbox profile conflicts with this session's pinned policy; restore its configuration or start a new session",
      )
    return recorded
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  const file = await open(temporary, "wx", 0o600)
  try {
    await file.writeFile(`${JSON.stringify(profile)}\n`)
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(temporary, path)
  return profile
}

export function validateAccessGrant(profile: SandboxProfile, grant: AccessGrant, plan: boolean): AccessGrant {
  if (
    !["read", "write", "network"].includes(grant.resource) ||
    !["turn", "session"].includes(grant.scope) ||
    typeof grant.target !== "string"
  )
    throw new Error("Invalid permission request")
  if (grant.resource === "network") return { ...grant, target: canonicalHost(grant.target) }
  const target = absoluteRoot(grant.target)
  if (
    target === sep ||
    target === physicalPath(homedir()) ||
    contains(target, profile.cwd) ||
    target.split(sep).filter(Boolean).length < 2
  )
    throw new Error("Permission request is too broad; request a specific external path")
  const denied = grant.resource === "write" ? profile.protectedPaths : profile.deniedReadPaths
  if (
    denied.some((p) => contains(p, target) || contains(target, p)) ||
    target.split(sep).some((p) => [".git", ".codesplash", ".ssh"].includes(p))
  )
    throw new Error("Permission request touches protected paths")
  if (grant.resource === "write" && (plan || profile.mode === "read-only"))
    throw new Error("Write escalation is unavailable in read-only/plan mode")
  return { ...grant, target }
}
