import { mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { ManagedConstraints } from "../../../core/config/contracts.ts"
import { checkConfigBounds, isTable, stableValue } from "../../../core/config/source.ts"
import type { AgentConfig } from "../../../core/config.ts"
import { atomic, bytes, canonicalRoot, digest, json, lease } from "../../../core/session/files.ts"
import { type AcquisitionOptions, acquire, installDependencies, installerCommand } from "./acquire.ts"
import { type MarketplaceSelection, PLUGIN_ID, type PluginSelection } from "./config.ts"
import {
  copyPackage,
  type PackageFile,
  packageFiles,
  packagePath,
  syncDirectory,
  syncPackage,
} from "./files.ts"
import { readPluginManifest } from "./manifest.ts"
export type PluginLock = {
  schemaVersion: 1
  kind: "plugin" | "marketplace"
  id: string
  source: string
  files: PackageFile[]
  registry?: string
  npm?: { tarball: string; integrity: string }
  dependencies: unknown[]
  build?: { from: string; command: string[] }
}
export type Marketplace = {
  schemaVersion: 1
  id: string
  plugins: Record<string, { source: string; description?: string }>
}
export function readMarketplace(root: string): Marketplace {
  const raw = json<unknown>(join(root, "codesplash-marketplace.json"), 128 * 1024)
  checkConfigBounds(raw)
  if (
    !isTable(raw) ||
    raw.schemaVersion !== 1 ||
    typeof raw.id !== "string" ||
    !PLUGIN_ID.test(raw.id) ||
    !isTable(raw.plugins) ||
    Object.keys(raw.plugins).length > 128 ||
    Object.keys(raw).some((key) => !["schemaVersion", "id", "plugins"].includes(key))
  )
    throw new Error("Invalid marketplace manifest")
  for (const [id, entry] of Object.entries(raw.plugins)) {
    if (
      !PLUGIN_ID.test(id) ||
      !isTable(entry) ||
      typeof entry.source !== "string" ||
      entry.source.length > 4096 ||
      Object.keys(entry).some((key) => !["source", "description"].includes(key)) ||
      (entry.description !== undefined &&
        (typeof entry.description !== "string" || entry.description.length > 4096))
    )
      throw new Error("Invalid marketplace plugin entry")
    if (entry.source.startsWith("./")) packagePath(entry.source.slice(2))
    else if (
      !/^git:.+#[a-f0-9]{40}$/.test(entry.source) &&
      !/^npm:(?:@[^/]+\/)?[^@]+@\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(entry.source)
    )
      throw new Error("Marketplace sources require relative local paths or immutable Git/npm pins")
  }
  return raw as Marketplace
}
export function pluginPermitted(
  config: AgentConfig,
  id: string,
  integrity?: string,
  marketplace = false,
): void {
  const constraints = config.resolution?.constraints
  const allowed = marketplace ? constraints?.marketplaceIds : constraints?.pluginIds
  if (allowed && !allowed.includes(id))
    throw new Error(`${marketplace ? "Marketplace" : "Plugin"} is prohibited by managed configuration`)
  const pins = constraints?.pluginPins
  if (!marketplace && pins && (!integrity || !pins.includes(`${id}/${integrity}`)))
    throw new Error("Plugin integrity is prohibited by managed pin requirements")
}
export function readVersionLock(
  selection: MarketplaceSelection,
  kind: PluginLock["kind"] = "plugin",
): PluginLock {
  const lock = json<PluginLock>(join(dirname(selection.root), "lock.json"), 2 * 1024 * 1024)
  if (
    digest(stableValue(lock)) !== selection.integrity ||
    lock.schemaVersion !== 1 ||
    lock.kind !== kind ||
    lock.source !== selection.source ||
    !PLUGIN_ID.test(lock.id) ||
    !Array.isArray(lock.files)
  )
    throw new Error("Invalid plugin lock or source integrity")
  return lock
}
export async function verifySelection(
  selection: MarketplaceSelection,
  kind: PluginLock["kind"] = "plugin",
  signal?: AbortSignal,
): Promise<PluginLock> {
  const lock = readVersionLock(selection, kind)
  const files = await packageFiles(selection.root, signal)
  if (stableValue(files) !== stableValue(lock.files))
    throw new Error("Plugin source changed; reinstall and review before activation")
  return lock
}
export async function stagePackage(
  dataDir: string,
  source: string,
  kind: PluginLock["kind"],
  options: AcquisitionOptions & {
    constraints?: ManagedConstraints
    build?: { selection: PluginSelection; fingerprint: string; command: string[] }
  } = {},
): Promise<{ id: string; selection: PluginSelection; lock: PluginLock }> {
  const store = canonicalRoot(join(dataDir, "plugins")),
    release = lease(store, "install.lease")
  const signal = AbortSignal.any([
    options.signal ?? new AbortController().signal,
    AbortSignal.timeout(120000),
  ])
  let scratch: string | undefined
  try {
    scratch = await mkdtemp(join(store, ".stage-"))
    const root = join(scratch, "package")
    await mkdir(root, { mode: 0o700 })
    let pinned: string,
      dependencies: unknown[] = [],
      origin: Pick<PluginLock, "registry" | "npm"> = {}
    const build = options.build
    if (build) {
      const original = await verifySelection(build.selection, "plugin", signal)
      dependencies = original.dependencies
      origin = {
        ...(original.registry ? { registry: original.registry } : {}),
        ...(original.npm ? { npm: original.npm } : {}),
      }
      if (
        build.fingerprint !== build.selection.integrity ||
        !build.command.length ||
        build.command.length > 32 ||
        build.command.some((arg) => !arg || arg.length > 8192 || arg.includes("\0"))
      )
        throw new Error("Build requires the exact reviewed fingerprint and bounded literal argv")
      await copyPackage(build.selection.root, root, signal)
      await installerCommand(build.command, root, scratch, signal)
      pinned = build.selection.source
    } else {
      const acquired = await acquire(source, root, { ...options, signal })
      pinned = acquired.source
      origin = {
        ...(acquired.registry ? { registry: acquired.registry } : {}),
        ...(acquired.npm ? { npm: acquired.npm } : {}),
      }
      if (kind === "plugin") {
        // Validate before resolving dependencies; installation never imports package code.
        readPluginManifest(root)
        dependencies = await installDependencies(root, scratch, { ...options, signal })
        if (dependencies.length)
          origin.registry = new URL(options.registry ?? "https://registry.npmjs.org").origin
      }
    }
    const manifest = kind === "plugin" ? readPluginManifest(root) : readMarketplace(root)
    const files = await packageFiles(root, signal)
    if (kind === "plugin") {
      const plugin = readPluginManifest(root),
        names = new Set(files.map((file) => file.path))
      for (const path of [
        ...plugin.skills,
        ...plugin.commands,
        ...plugin.agents,
        ...Object.values(plugin.extensions).map((entry) => entry.entry),
      ])
        if (!names.has(path)) throw new Error(`Missing plugin component: ${path}`)
      if (names.has(".codesplash-plugin/plugin.json"))
        throw new Error("Ambiguous native and foreign plugin manifests")
    }
    const lock: PluginLock = {
      schemaVersion: 1,
      kind,
      id: manifest.id,
      source: pinned,
      ...origin,
      files,
      dependencies,
      ...(build ? { build: { from: build.fingerprint, command: build.command } } : {}),
    }
    const integrity = digest(stableValue(lock))
    pluginPermitted(
      { resolution: { constraints: options.constraints } } as AgentConfig,
      manifest.id,
      integrity,
      kind === "marketplace",
    )
    syncPackage(root, files)
    const destination = join(store, "versions", integrity)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    atomic(join(scratch, "lock.json"), JSON.stringify(lock))
    // Only package and lock belong to the published tree; scratch installer files stay private.
    const publish = join(scratch, "publish")
    await mkdir(publish, { mode: 0o700 })
    await rename(root, join(publish, "package"))
    await rename(join(scratch, "lock.json"), join(publish, "lock.json"))
    syncDirectory(publish)
    signal.throwIfAborted()
    try {
      await rename(publish, destination)
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
      await verifySelection({ root: join(destination, "package"), source: pinned, integrity }, kind, signal)
    }
    syncDirectory(dirname(destination))
    syncDirectory(store)
    return {
      id: manifest.id,
      selection: { root: join(destination, "package"), source: pinned, integrity, enabled: false },
      lock,
    }
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true })
    release()
  }
}
export async function marketplaceSource(selection: MarketplaceSelection, id: string): Promise<string> {
  await verifySelection(selection, "marketplace")
  const entry = readMarketplace(selection.root).plugins[id]
  if (!entry) throw new Error("Plugin is absent from the pinned marketplace")
  return entry.source.startsWith("./") ? resolve(selection.root, entry.source.slice(2)) : entry.source
}
export function describeScripts(root: string): unknown {
  try {
    const pkg = JSON.parse(bytes(join(root, "package.json"), 128 * 1024).toString())
    return isTable(pkg.scripts) ? pkg.scripts : {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
}
