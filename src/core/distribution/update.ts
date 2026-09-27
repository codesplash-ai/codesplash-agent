import {
  chmodSync,
  existsSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { checkConfigBounds, isTable, readConfigSource } from "../config/source.ts"
import { configDirectory } from "../config.ts"
import { networkFetch, responseBytes } from "../network.ts"
import { atomic, bytes, digest, directory, json, lease } from "../session/files.ts"
import { stringifyToml, type TomlTable } from "../toml.ts"
import { readFleetSources } from "./fleet.ts"
import {
  type PackageArtifact,
  type PackageManager,
  validatePackageArtifacts,
  validatePackageManager,
} from "./package-update.ts"
import { assertRevision, type SignedEnvelope, type SignedPayload, verifyDocument } from "./signed.ts"
import { assertVersion, compareVersions, type VersionPolicy, versionParts } from "./versions.ts"

export type ReleaseFile = { path: string; sha256: string; size: number; executable?: boolean }
export type ReleaseManifest = SignedPayload & {
  npmArtifacts?: PackageArtifact[]
  kind: "release"
  release: string
  target: string
  baseUrl: string
  files: ReleaseFile[]
  migrations?: Array<{ from: string; rename: Record<string, string> }>
}
export type UpdateSettings = {
  manager?: PackageManager
  version: 1
  root: string
  manifestUrl: string
  keys: Record<string, string>
  policy: VersionPolicy
  configPath: string
}
type Installed = { version: 1; current?: string; previous?: string; revision?: number; fingerprint?: string }
type UpdateJournal = {
  version: 1
  from?: string
  to: string
  revision: number
  fingerprint: string
  config?: { before?: string; after: string }
  phase: "staged" | "config" | "active"
}
const idPattern = /^[0-9a-z.-]+-[a-f0-9]{16}$/
function https(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("Update URLs must be HTTPS without credentials/query/fragment")
  return url
}
export function readUpdateSettings(path = join(configDirectory(), "updates.json")): UpdateSettings {
  const settings = json<UpdateSettings>(path, 65536)
  checkConfigBounds(settings)
  if (
    !isTable(settings) ||
    settings.version !== 1 ||
    typeof settings.root !== "string" ||
    !isAbsolute(settings.root) ||
    typeof settings.configPath !== "string" ||
    !isAbsolute(settings.configPath) ||
    !isTable(settings.keys) ||
    !Object.keys(settings.keys).length ||
    Object.keys(settings.keys).length > 16 ||
    Object.values(settings.keys).some((key) => typeof key !== "string" || key.length > 8192) ||
    !isTable(settings.policy)
  )
    throw new Error("Invalid update settings")
  if (settings.manager) validatePackageManager(settings.manager)
  https(settings.manifestUrl)
  return settings
}
export function validateRelease(
  value: ReleaseManifest,
  target = `${process.platform}-${process.arch}`,
): ReleaseManifest {
  versionParts(value.release)
  validatePackageArtifacts(value.npmArtifacts)
  if (
    value.target !== target ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > 4096
  )
    throw new Error("Release target/files are invalid")
  const base = https(value.baseUrl)
  if (!base.pathname.endsWith("/")) throw new Error("Release base URL must end with a slash")
  const paths = new Set<string>()
  let total = 0
  for (const file of value.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      file.path.length > 240 ||
      !/^[a-zA-Z0-9@+._/-]+$/.test(file.path) ||
      file.path
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        ) ||
      paths.has(file.path.toLowerCase()) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > 256 * 1024 * 1024 ||
      (file.executable !== undefined && typeof file.executable !== "boolean")
    )
      throw new Error("Invalid release file descriptor")
    if (file.path.startsWith(".") || file.path.split("/").some((part) => part.endsWith(".")))
      throw new Error("Unsafe release filename")
    paths.add(file.path.toLowerCase())
    total += file.size
  }
  if (
    total > 512 * 1024 * 1024 ||
    !value.files.some(
      (file) =>
        file.path === (target.startsWith("win32") ? "codesplash.exe" : "codesplash") && file.executable,
    )
  )
    throw new Error("Release is oversized or lacks its executable")
  if (value.migrations !== undefined && (!Array.isArray(value.migrations) || value.migrations.length > 16))
    throw new Error("Invalid config migrations")
  for (const migration of value.migrations ?? []) {
    versionParts(migration.from)
    if (
      !isTable(migration.rename) ||
      Object.keys(migration.rename).length > 32 ||
      Object.entries(migration.rename).some(
        ([from, to]) =>
          !/^[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*){0,5}$/.test(from) ||
          typeof to !== "string" ||
          !/^[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*){0,5}$/.test(to) ||
          [from, to].some((key) =>
            key.split(".").some((part) => ["__proto__", "constructor", "prototype"].includes(part)),
          ),
      )
    )
      throw new Error("Invalid data-only config migration")
  }
  return value
}
function installation(root: string): Installed {
  directory(root, true)
  const path = join(root, "installation.json")
  const state = existsSync(path) ? json<Installed>(path, 8192) : { version: 1 as const }
  if (
    !state ||
    state.version !== 1 ||
    [state.current, state.previous].some((id) => id !== undefined && !idPattern.test(id))
  )
    throw new Error("Invalid installation receipt")
  return state
}
function active(root: string): string | undefined {
  const path = join(root, "current")
  try {
    if (!lstatSync(path).isSymbolicLink()) throw new Error("Active installation pointer is not a link")
    const target = readlinkSync(path).replaceAll("\\", "/")
    if (!/^versions\/[0-9a-z.-]+-[a-f0-9]{16}$/.test(target))
      throw new Error("Unsafe active installation pointer")
    return target.slice("versions/".length)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
}
function point(root: string, id: string | undefined): void {
  if (!id) {
    if (active(root)) unlinkSync(join(root, "current"))
    return
  }
  if (!idPattern.test(id)) throw new Error("Invalid release id")
  const temp = join(root, `pointer-${crypto.randomUUID()}`)
  symlinkSync(`versions/${id}`, temp, process.platform === "win32" ? "junction" : "dir")
  try {
    renameSync(temp, join(root, "current"))
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
}
export function migrate(source: string, migration: ReleaseManifest["migrations"]): string {
  if (!migration?.length) return source
  const raw = source ? Bun.TOML.parse(source) : {}
  checkConfigBounds(raw)
  for (const step of migration)
    for (const [from, to] of Object.entries(step.rename)) {
      const parts = from.split("."),
        destination = to.split(".")
      let parent: Record<string, unknown> | undefined = raw as Record<string, unknown>
      for (const part of parts.slice(0, -1))
        parent = parent && isTable(parent[part]) ? (parent[part] as Record<string, unknown>) : undefined
      if (!parent || !Object.hasOwn(parent, parts.at(-1)!)) continue
      let next = raw as Record<string, unknown>
      for (const part of destination.slice(0, -1)) {
        if (next[part] === undefined) next[part] = {}
        if (!isTable(next[part])) throw new Error("Migration conflicts with existing config")
        next = next[part] as Record<string, unknown>
      }
      if (Object.hasOwn(next, destination.at(-1)!)) throw new Error("Migration destination already exists")
      next[destination.at(-1)!] = parent[parts.at(-1)!]
      delete parent[parts.at(-1)!]
    }
  checkConfigBounds(raw)
  return stringifyToml(raw as TomlTable)
}
export function detectInstallMethod(
  main = process.argv[1] ?? "",
  executable = process.execPath,
): "homebrew" | "npm" | "scoop" | "standalone" | "source" {
  try {
    if (existsSync(main)) main = realpathSync(main)
  } catch {
    /* detection remains advisory */
  }
  // A Homebrew-installed Bun runtime does not make its source/npm application a Homebrew install.
  const runtime = /(?:^|[\\/])bun(?:\.exe)?$/.test(executable)
  const path = `${main} ${runtime ? "" : executable}`.replaceAll("\\", "/")
  if (/\/(Cellar|Homebrew)\//.test(path)) return "homebrew"
  if (/\/scoop\/apps\//i.test(path)) return "scoop"
  if (/\/node_modules\/codesplash-agent\//.test(path)) return "npm"
  return main.includes("$bunfs") || !/\bbun(?:\.exe)?$/.test(executable) ? "standalone" : "source"
}
export class UpdateManager {
  constructor(
    readonly settings: UpdateSettings,
    readonly fetcher?: typeof fetch,
  ) {}
  status() {
    return {
      ...installation(this.settings.root),
      active: active(this.settings.root),
      recoveryRequired: existsSync(join(this.settings.root, "update-journal.json")),
      launcher: join(
        this.settings.root,
        "current",
        process.platform === "win32" ? "codesplash.exe" : "codesplash",
      ),
    }
  }
  async inspect() {
    const response = await networkFetch(
      this.settings.manifestUrl,
      {},
      { fetcher: this.fetcher, timeoutMs: 15000 },
    )
    const data = await responseBytes(response, 2 * 1024 * 1024)
    let envelope: SignedEnvelope
    try {
      envelope = JSON.parse(data.toString())
    } catch {
      throw new Error("Invalid release manifest JSON")
    }
    const verified = verifyDocument<ReleaseManifest>(envelope, "release", this.settings.keys)
    const manifest = validateRelease(verified.payload)
    assertVersion(manifest.release, this.settings.policy)
    for (const source of readFleetSources(dirname(this.settings.configPath), undefined, false))
      if (source.payload.versions) assertVersion(manifest.release, source.payload.versions)
    const state = installation(this.settings.root)
    if (state.revision !== undefined)
      assertRevision(
        { revision: manifest.revision, fingerprint: verified.fingerprint },
        { revision: state.revision, fingerprint: state.fingerprint! },
      )
    return {
      envelope,
      manifest,
      fingerprint: verified.fingerprint,
      id: `${manifest.release}-${verified.fingerprint.slice(0, 16)}`,
    }
  }
  async apply(): Promise<ReturnType<UpdateManager["status"]>> {
    const release = lease(this.settings.root, "update.lease")
    try {
      if (this.status().recoveryRequired) throw new Error("Interrupted update requires explicit recovery")
      const candidate = await this.inspect(),
        state = installation(this.settings.root),
        old = active(this.settings.root)
      if (state.current !== old) throw new Error("Installation receipt/pointer disagree; inspect recovery")
      if (old === candidate.id) {
        this.verifyInstalled(old)
        return this.status()
      }
      let oldVersion: string | undefined
      if (old) {
        oldVersion = this.verifyInstalled(old).release
        if (compareVersions(candidate.manifest.release, oldVersion) <= 0)
          throw new Error("Updates must advance the version; use reviewed rollback")
      }
      const location = join(this.settings.root, "versions", candidate.id)
      directory(location, true)
      const deadline = AbortSignal.timeout(300000)
      for (const file of candidate.manifest.files) {
        const destination = join(location, file.path)
        if (existsSync(destination) && digest(bytes(destination, file.size)) === file.sha256) {
          chmodSync(destination, file.executable ? 0o500 : 0o400)
          continue
        }
        const url = new URL(
          file.path.split("/").map(encodeURIComponent).join("/"),
          candidate.manifest.baseUrl,
        )
        const response = await networkFetch(
          url,
          { signal: deadline },
          { fetcher: this.fetcher, timeoutMs: 30000 },
        )
        const content = await responseBytes(response, file.size)
        if (content.length !== file.size || digest(content) !== file.sha256)
          throw new Error("Release file checksum/size mismatch")
        atomic(destination, content)
        chmodSync(destination, file.executable ? 0o500 : 0o400)
      }
      atomic(join(location, ".release.json"), JSON.stringify(candidate.envelope))
      this.verifyInstalled(candidate.id)
      const previous = readConfigSource(this.settings.configPath).source
      const next = migrate(
        previous,
        candidate.manifest.migrations?.filter((step) => step.from === oldVersion),
      )
      const journal: UpdateJournal = {
        version: 1,
        from: old,
        to: candidate.id,
        revision: candidate.manifest.revision,
        fingerprint: candidate.fingerprint,
        phase: "staged",
        ...(previous !== next
          ? {
              config: {
                before: existsSync(this.settings.configPath)
                  ? Buffer.from(previous).toString("base64")
                  : undefined,
                after: Buffer.from(next).toString("base64"),
              },
            }
          : {}),
      }
      atomic(join(this.settings.root, "update-journal.json"), JSON.stringify(journal))
      this.finish(journal)
      return this.status()
    } finally {
      release()
    }
  }
  verifyInstalled(id: string): ReleaseManifest {
    if (!idPattern.test(id)) throw new Error("Invalid installed release id")
    const location = join(this.settings.root, "versions", id),
      envelope = json<SignedEnvelope>(join(location, ".release.json"), 2 * 1024 * 1024)
    // Expired release metadata does not revoke an already installed executable; current fleet bounds do.
    const stamp = JSON.parse(Buffer.from(envelope.payload, "base64").toString()) as SignedPayload
    const { payload, fingerprint } = verifyDocument<ReleaseManifest>(
      envelope,
      "release",
      this.settings.keys,
      stamp.issuedAt,
    )
    const manifest = validateRelease(payload)
    if (`${manifest.release}-${fingerprint.slice(0, 16)}` !== id)
      throw new Error("Installed manifest identity mismatch")
    for (const file of manifest.files) {
      const content = bytes(join(location, file.path), file.size)
      if (content.length !== file.size || digest(content) !== file.sha256)
        throw new Error("Installed release was modified")
    }
    return manifest
  }
  private finish(journal: UpdateJournal) {
    const manifest = this.verifyInstalled(journal.to)
    assertVersion(manifest.release, this.settings.policy)
    for (const source of readFleetSources(dirname(this.settings.configPath), undefined, false))
      if (source.payload.versions) assertVersion(manifest.release, source.payload.versions)
    if (journal.revision !== manifest.revision || !journal.to.endsWith(journal.fingerprint.slice(0, 16)))
      throw new Error("Journal does not match the verified release")
    const path = join(this.settings.root, "update-journal.json")
    if (journal.config) {
      const current = existsSync(this.settings.configPath)
        ? bytes(this.settings.configPath).toString("base64")
        : undefined
      if (current !== journal.config.before && current !== journal.config.after)
        throw new Error("Config changed during update; recovery refuses overwriting it")
      atomic(this.settings.configPath, Buffer.from(journal.config.after, "base64"))
    }
    journal.phase = "config"
    atomic(path, JSON.stringify(journal))
    point(this.settings.root, journal.to)
    journal.phase = "active"
    atomic(path, JSON.stringify(journal))
    const state: Installed = {
      version: 1,
      current: journal.to,
      previous: journal.from,
      revision: journal.revision,
      fingerprint: journal.fingerprint,
    }
    atomic(join(this.settings.root, "installation.json"), JSON.stringify(state))
    atomic(join(this.settings.root, "last-update.json"), JSON.stringify(journal))
    unlinkSync(path)
  }
  recover(rollback: boolean): ReturnType<UpdateManager["status"]> {
    const release = lease(this.settings.root, "update.lease")
    try {
      const path = join(this.settings.root, "update-journal.json"),
        journal = json<UpdateJournal>(path, 4 * 1024 * 1024)
      this.validateJournal(journal)
      if (!rollback) this.finish(journal)
      else {
        this.restore(journal)
        unlinkSync(path)
      }
      return this.status()
    } finally {
      release()
    }
  }
  rollback(): ReturnType<UpdateManager["status"]> {
    const release = lease(this.settings.root, "update.lease")
    try {
      if (this.status().recoveryRequired) throw new Error("Recover the interrupted update first")
      const journal = json<UpdateJournal>(join(this.settings.root, "last-update.json"), 4 * 1024 * 1024)
      this.validateJournal(journal)
      if (!journal.from || active(this.settings.root) !== journal.to)
        throw new Error("No matching previous release to roll back")
      atomic(join(this.settings.root, "update-journal.json"), JSON.stringify(journal))
      this.restore(journal)
      unlinkSync(join(this.settings.root, "update-journal.json"))
      return this.status()
    } finally {
      release()
    }
  }
  private validateJournal(journal: UpdateJournal) {
    if (
      !journal ||
      journal.version !== 1 ||
      !idPattern.test(journal.to) ||
      (journal.from !== undefined && !idPattern.test(journal.from)) ||
      !Number.isSafeInteger(journal.revision) ||
      !/^[a-f0-9]{64}$/.test(journal.fingerprint)
    )
      throw new Error("Invalid update journal")
    const current = active(this.settings.root)
    if (current !== journal.from && current !== journal.to)
      throw new Error("Update journal does not own the active pointer")
  }
  private restore(journal: UpdateJournal) {
    if (journal.from) {
      const manifest = this.verifyInstalled(journal.from)
      assertVersion(manifest.release, this.settings.policy)
      for (const source of readFleetSources(dirname(this.settings.configPath), undefined, false))
        if (source.payload.versions) assertVersion(manifest.release, source.payload.versions)
    }
    if (journal.config) {
      const current = existsSync(this.settings.configPath)
        ? bytes(this.settings.configPath).toString("base64")
        : undefined
      if (current !== journal.config.before && current !== journal.config.after)
        throw new Error("Config changed after update; rollback refuses overwriting it")
      if (journal.config.before === undefined) {
        if (existsSync(this.settings.configPath)) unlinkSync(this.settings.configPath)
      } else atomic(this.settings.configPath, Buffer.from(journal.config.before, "base64"))
    }
    point(this.settings.root, journal.from)
    // Keep the highest accepted manifest revision even when the executable rolls back.
    atomic(
      join(this.settings.root, "installation.json"),
      JSON.stringify({
        version: 1,
        current: journal.from,
        revision: journal.revision,
        fingerprint: journal.fingerprint,
      }),
    )
  }
}
export function assertInstallationReady(executable = process.execPath): void {
  const root = resolve(dirname(executable), "../..")
  if (existsSync(join(root, "installation.json")) && existsSync(join(root, "update-journal.json")))
    throw new Error(
      "Installation has an interrupted update; use codesplash update recover --finish|--rollback --apply",
    )
}
