import { existsSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { runProcess } from "../../engines/codesplash/sandbox/process.ts"
import { readConfigSource } from "../config/source.ts"
import { networkEnvironment, networkFetch, responseBytes } from "../network.ts"
import { atomic, bytes, digest, directory, json, lease } from "../session/files.ts"
import { readFleetSources } from "./fleet.ts"
import { assertRevision, type SignedEnvelope, verifyDocument } from "./signed.ts"
import {
  migrate,
  type ReleaseManifest,
  UpdateManager,
  type UpdateSettings,
  validateRelease,
} from "./update.ts"
import { assertVersion, compareVersions, versionParts } from "./versions.ts"

export type PackageManager = { kind: "npm" | "homebrew" | "scoop"; executable: string; installRoot: string }
export type PackageArtifact = { version: string; url: string; sha256: string; size: number }
type Runner = (argv: string[], env: NodeJS.ProcessEnv) => Promise<string>
type Journal = {
  version: 1
  manager: PackageManager
  from: string
  to: string
  envelope: SignedEnvelope
  before?: string
  after: string
  phase: "prepared" | "installing" | "installed" | "config"
}
type Receipt = { version: 1; revision?: number; fingerprint?: string; current?: string; previous?: string }
export function validatePackageManager(raw: unknown): PackageManager {
  const m = raw as PackageManager
  if (
    !m ||
    !["npm", "homebrew", "scoop"].includes(m.kind) ||
    typeof m.executable !== "string" ||
    !isAbsolute(m.executable) ||
    typeof m.installRoot !== "string" ||
    !isAbsolute(m.installRoot) ||
    /[\p{Cc}\p{Cf}]/u.test(m.executable + m.installRoot) ||
    Object.keys(m).some((k) => !["kind", "executable", "installRoot"].includes(k))
  )
    throw new Error("Package manager requires a fixed kind, absolute executable and installation root")
  return structuredClone(m)
}
export function validatePackageArtifacts(raw: unknown): PackageArtifact[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > 16) throw new Error("Invalid signed npm artifacts")
  const versions = new Set<string>()
  for (const a of raw) {
    if (!a || typeof a.version !== "string") throw new Error("Invalid signed npm artifact")
    versionParts(a.version)
    const url = new URL(a.url)
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !/^[a-f0-9]{64}$/.test(a.sha256) ||
      !Number.isSafeInteger(a.size) ||
      a.size < 1 ||
      a.size > 64 * 1024 * 1024 ||
      versions.has(a.version)
    )
      throw new Error("Invalid signed npm artifact")
    versions.add(a.version)
  }
  return structuredClone(raw)
}
/** Manager-owned installs never switch to the standalone pointer. All effects have a durable journal. */
export class PackageUpdateManager {
  readonly manager: PackageManager
  constructor(
    readonly settings: UpdateSettings,
    readonly fetcher?: typeof fetch,
    readonly runner?: Runner,
  ) {
    this.manager = validatePackageManager(settings.manager)
  }
  #path(name: string) {
    return join(this.settings.root, `package-${name}.json`)
  }
  #receipt(): Receipt {
    const receipt = existsSync(this.#path("installation"))
      ? json<Receipt>(this.#path("installation"), 8192)
      : { version: 1 as const }
    if (
      !receipt ||
      receipt.version !== 1 ||
      (receipt.revision !== undefined &&
        (!Number.isSafeInteger(receipt.revision) ||
          receipt.revision < 0 ||
          typeof receipt.fingerprint !== "string" ||
          !/^[a-f0-9]{64}$/.test(receipt.fingerprint)))
    )
      throw new Error("Invalid package installation receipt")
    for (const version of [receipt.current, receipt.previous])
      if (version !== undefined) versionParts(version)
    return receipt
  }
  status() {
    return {
      ...this.#receipt(),
      manager: this.manager.kind,
      recoveryRequired: existsSync(this.#path("journal")),
    }
  }
  async #run(args: string[]): Promise<string> {
    directory(this.settings.root, true)
    const env: NodeJS.ProcessEnv = {
      ...networkEnvironment(undefined),
      HOMEBREW_NO_INSTALL_FROM_API: "1",
      HOMEBREW_NO_AUTO_UPDATE: "1",
      HOMEBREW_DEVELOPER: "1",
      HOMEBREW_NO_INSTALL_CLEANUP: "1",
      HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: "1",
      HOMEBREW_NO_ANALYTICS: "1",
    }
    if (env.CODESPLASH_OFFLINE === "1" && this.manager.kind !== "npm")
      throw new Error("Package manager invocation refused in offline mode")
    const argv =
      this.manager.kind === "scoop"
        ? [
            join(
              process.env.SystemRoot ?? "C:\\Windows",
              "System32",
              "WindowsPowerShell",
              "v1.0",
              "powershell.exe",
            ),
            "-NoProfile",
            "-NonInteractive",
            "-File",
            this.manager.executable,
            ...args,
          ]
        : [this.manager.executable, ...args]
    if (this.runner) return this.runner(argv, env)
    const r = await runProcess(argv, {
      cwd: this.settings.root,
      env,
      signal: AbortSignal.timeout(300000),
      timeoutMs: 300000,
      maxBytes: 2 * 1024 * 1024,
    })
    if (r.exitCode !== 0)
      throw new Error(`Package manager failed (${r.kind}); inspect the journal and recover explicitly`)
    return r.stdout
  }
  async installedVersion(): Promise<string> {
    let version: unknown
    if (this.manager.kind === "npm") {
      const value = JSON.parse(
        await this.#run(["list", "--global", "--depth=0", "--json", "--prefix", this.manager.installRoot]),
      )
      version = value.dependencies?.["codesplash-agent"]?.version
    } else if (this.manager.kind === "homebrew") {
      const value = JSON.parse(
        await this.#run(["info", "--json=v2", "--formula", "codesplash-ai/tap/codesplash-agent"]),
      )
      version = value.formulae?.[0]?.linked_keg
    } else {
      const value = JSON.parse(await this.#run(["export"]))
      version =
        value.apps?.find(
          (app: { Name?: string; name?: string }) => (app.Name ?? app.name) === "codesplash-agent",
        )?.Version ?? value.apps?.find((app: { name?: string }) => app.name === "codesplash-agent")?.version
    }
    if (typeof version !== "string") throw new Error("Could not identify the manager-owned installed version")
    versionParts(version)
    return version
  }
  #admit(version: string) {
    assertVersion(version, this.settings.policy)
    for (const source of readFleetSources(dirname(this.settings.configPath), undefined, false))
      if (source.payload.versions) assertVersion(version, source.payload.versions)
  }
  #manifest(journal: Journal): ReleaseManifest {
    if (
      !journal ||
      journal.version !== 1 ||
      JSON.stringify(journal.manager) !== JSON.stringify(this.manager) ||
      !["prepared", "installing", "installed", "config"].includes(journal.phase) ||
      typeof journal.after !== "string" ||
      journal.after.length > 1500000 ||
      (journal.before !== undefined &&
        (typeof journal.before !== "string" || journal.before.length > 1500000)) ||
      [journal.before, journal.after].some(
        (v) => v !== undefined && Buffer.from(v, "base64").toString("base64") !== v,
      )
    )
      throw new Error("Invalid package update journal")
    versionParts(journal.from)
    versionParts(journal.to)
    const stamp = JSON.parse(Buffer.from(journal.envelope.payload, "base64").toString())
    const { payload } = verifyDocument<ReleaseManifest>(
      journal.envelope,
      "release",
      this.settings.keys,
      stamp.issuedAt,
    )
    const manifest = validateRelease(payload)
    if (manifest.release !== journal.to) throw new Error("Package journal release mismatch")
    const before = journal.before === undefined ? "" : Buffer.from(journal.before, "base64").toString()
    const expected = migrate(
      before,
      manifest.migrations?.filter((m) => m.from === journal.from),
    )
    if (Buffer.from(expected).toString("base64") !== journal.after)
      throw new Error("Package journal migration does not match its signed release")
    return manifest
  }
  #artifact(manifest: ReleaseManifest, version: string) {
    const artifact = validatePackageArtifacts(manifest.npmArtifacts).find((a) => a.version === version)
    if (!artifact)
      throw new Error("Signed npm artifacts must include both current and target versions for rollback")
    return { artifact, path: join(this.settings.root, "packages", `${artifact.sha256}.tgz`) }
  }
  async #cache(manifest: ReleaseManifest, version: string) {
    const { artifact, path } = this.#artifact(manifest, version)
    if (!existsSync(path)) {
      const response = await networkFetch(artifact.url, {}, { fetcher: this.fetcher, timeoutMs: 30000 })
      const data = await responseBytes(response, artifact.size)
      if (data.length !== artifact.size || digest(data) !== artifact.sha256)
        throw new Error("Npm package checksum mismatch")
      atomic(path, data)
    }
    this.#verifyArtifact(manifest, version)
  }
  #verifyArtifact(manifest: ReleaseManifest, version: string): string {
    const { artifact, path } = this.#artifact(manifest, version),
      data = bytes(path, artifact.size)
    if (data.length !== artifact.size || digest(data) !== artifact.sha256)
      throw new Error("Cached npm artifact changed")
    return path
  }
  async #install(journal: Journal, version: string) {
    const manifest = this.#manifest(journal)
    this.#admit(version)
    if (this.manager.kind === "npm") {
      await this.#run([
        "install",
        "--global",
        "--prefix",
        this.manager.installRoot,
        "--ignore-scripts",
        "--offline",
        "--no-audit",
        "--no-fund",
        this.#verifyArtifact(manifest, version),
      ])
    } else if (this.manager.kind === "scoop") {
      if (existsSync(join(this.manager.installRoot, version)))
        await this.#run(["reset", `codesplash-agent@${version}`])
      else {
        const manifest = JSON.parse(await this.#run(["cat", "codesplash-agent"]))
        if (manifest.version !== version)
          throw new Error("Scoop's reviewed manifest does not offer the signed target version")
        await this.#run(["update", "--independent", "codesplash-agent"])
      }
    } else {
      const keg = join(this.manager.installRoot, version)
      if (existsSync(keg)) {
        // Homebrew's own Keg API owns link bookkeeping. Never manually replace its prefix links.
        const source =
          'require "keg"; require "pathname"; dst=Keg.new(Pathname.new(ARGV.fetch(1))); src=Keg.new(Pathname.new(ARGV.fetch(0))); src.unlink if src.exist? && src.to_path != dst.to_path; dst.link unless dst.linked?'
        await this.#run([
          "ruby",
          "-e",
          source,
          "--",
          join(this.manager.installRoot, version === journal.from ? journal.to : journal.from),
          keg,
        ])
      } else {
        const info = JSON.parse(
          await this.#run(["info", "--json=v2", "--formula", "codesplash-ai/tap/codesplash-agent"]),
        )
        if (info.formulae?.[0]?.versions?.stable !== version)
          throw new Error("Homebrew's reviewed formula does not offer the signed target version")
        await this.#run(["upgrade", "--formula", "codesplash-ai/tap/codesplash-agent"])
      }
    }
    if ((await this.installedVersion()) !== version)
      throw new Error("Package manager did not activate the requested version; explicit recovery required")
  }
  #config(journal: Journal, rollback: boolean) {
    const current = existsSync(this.settings.configPath)
      ? bytes(this.settings.configPath).toString("base64")
      : undefined
    if (current !== journal.before && current !== journal.after)
      throw new Error("Config changed; package recovery refuses overwrite")
    const value = rollback ? journal.before : journal.after
    if (value !== undefined) atomic(this.settings.configPath, Buffer.from(value, "base64"))
    // A previously absent config is restored to an empty file, never removed behind another writer.
    else if (current !== undefined) atomic(this.settings.configPath, "")
  }
  async apply() {
    const release = lease(this.settings.root, "package-update.lease")
    try {
      if (this.status().recoveryRequired) throw new Error("Package update requires explicit recovery")
      if (this.manager.kind === "homebrew") {
        const cellar = (await this.#run(["--cellar", "codesplash-ai/tap/codesplash-agent"])).trim()
        if (resolve(cellar) !== resolve(this.manager.installRoot))
          throw new Error("Homebrew installation root does not match its formula")
      }
      if (this.manager.kind === "scoop") {
        const prefix = (await this.#run(["prefix", "codesplash-agent"])).trim()
        if (resolve(dirname(prefix)) !== resolve(this.manager.installRoot))
          throw new Error("Scoop installation root does not match its application")
      }
      const candidate = await new UpdateManager(this.settings, this.fetcher).inspect(),
        receipt = this.#receipt(),
        from = await this.installedVersion()
      if (receipt.revision !== undefined)
        assertRevision(
          { revision: candidate.manifest.revision, fingerprint: candidate.fingerprint },
          { revision: receipt.revision, fingerprint: receipt.fingerprint! },
        )
      if (compareVersions(candidate.manifest.release, from) <= 0)
        throw new Error("Package updates must advance the installed version")
      if (this.manager.kind === "npm") {
        await this.#cache(candidate.manifest, from)
        await this.#cache(candidate.manifest, candidate.manifest.release)
      }
      if (this.manager.kind !== "npm" && !existsSync(join(this.manager.installRoot, from)))
        throw new Error("Current manager version directory is unavailable for rollback")
      const source = readConfigSource(this.settings.configPath).source,
        after = migrate(
          source,
          candidate.manifest.migrations?.filter((m) => m.from === from),
        )
      const journal: Journal = {
        version: 1,
        manager: this.manager,
        from,
        to: candidate.manifest.release,
        envelope: candidate.envelope,
        before: existsSync(this.settings.configPath) ? Buffer.from(source).toString("base64") : undefined,
        after: Buffer.from(after).toString("base64"),
        phase: "prepared",
      }
      atomic(this.#path("journal"), JSON.stringify(journal))
      atomic(
        this.#path("installation"),
        JSON.stringify({
          ...receipt,
          version: 1,
          revision: candidate.manifest.revision,
          fingerprint: candidate.fingerprint,
        }),
      )
      await this.#finish(journal, false)
      return this.status()
    } finally {
      release()
    }
  }
  async #finish(journal: Journal, rollback: boolean) {
    this.#manifest(journal)
    const version = rollback ? journal.from : journal.to
    this.#admit(version)
    // Check config conflict before touching the installation as well as before config activation.
    const current = existsSync(this.settings.configPath)
      ? bytes(this.settings.configPath).toString("base64")
      : undefined
    if (current !== journal.before && current !== journal.after)
      throw new Error("Config changed; package recovery refuses overwrite")
    journal.phase = "installing"
    atomic(this.#path("journal"), JSON.stringify(journal))
    // An interrupted manager operation may leave no active version. Reinstall the signed
    // cached package / relink the reviewed keg without requiring a successful version probe.
    await this.#install(journal, version)
    journal.phase = "installed"
    atomic(this.#path("journal"), JSON.stringify(journal))
    this.#config(journal, rollback)
    const receipt = this.#receipt()
    atomic(
      this.#path("installation"),
      JSON.stringify({ ...receipt, current: version, previous: rollback ? undefined : journal.from }),
    )
    atomic(this.#path("last-update"), JSON.stringify(journal))
    const { unlinkSync } = await import("node:fs")
    unlinkSync(this.#path("journal"))
  }
  async recover(rollback: boolean) {
    const release = lease(this.settings.root, "package-update.lease")
    try {
      await this.#finish(json<Journal>(this.#path("journal"), 4 * 1024 * 1024), rollback)
      return this.status()
    } finally {
      release()
    }
  }
  async rollback() {
    const release = lease(this.settings.root, "package-update.lease")
    try {
      if (this.status().recoveryRequired) throw new Error("Recover the interrupted package update first")
      const journal = json<Journal>(this.#path("last-update"), 4 * 1024 * 1024)
      this.#manifest(journal)
      if ((await this.installedVersion()) !== journal.to)
        throw new Error("No matching package update to roll back")
      atomic(this.#path("journal"), JSON.stringify(journal))
      await this.#finish(journal, true)
      return this.status()
    } finally {
      release()
    }
  }
}
