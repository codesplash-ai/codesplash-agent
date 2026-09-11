import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { isTable } from "../../../core/config/source.ts"
import { runProcess } from "../sandbox/process.ts"
import {
  ARCHIVE_BYTES,
  boundedBody,
  copyPackage,
  packageFiles,
  unpackArchive,
  verifyIntegrity,
} from "./files.ts"

export type AcquisitionOptions = {
  signal?: AbortSignal
  registry?: string
  allowLoopback?: boolean
  bun?: string
}
export const packageName = (name: string) => /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)
const versionRange = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 256 && /^[0-9xX*^~<>=| .+-]+$/.test(value) && !!value
export function dependencyMap(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (
    !isTable(value) ||
    Object.keys(value).length > 64 ||
    Object.entries(value).some(([key, spec]) => !packageName(key) || !versionRange(spec))
  )
    throw new Error("Plugin dependencies require bounded npm names and semantic version ranges")
  return value as Record<string, string>
}
export function installerEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "https:file",
    NO_COLOR: "1",
  }
}
export async function installerCommand(
  argv: string[],
  cwd: string,
  home: string,
  signal: AbortSignal,
  onStdout?: (data: Uint8Array) => void,
): Promise<string> {
  const controller = new AbortController()
  const bounded = AbortSignal.any([signal, controller.signal])
  let checking: Promise<void> | undefined
  const inspect = async () => {
    let count = 0,
      size = 0
    const visit = async (path: string, depth: number): Promise<void> => {
      if (depth > 40) throw new Error("Plugin staging directory depth exceeded")
      for (const name of await readdir(path)) {
        if (++count > 8192) throw new Error("Plugin staging entry limit exceeded")
        const next = join(path, name),
          info = await lstat(next).catch((error) => {
            if (error.code === "ENOENT") return undefined
            throw error
          })
        if (!info || info.isSymbolicLink()) continue
        if (info.isDirectory()) await visit(next, depth + 1)
        else {
          size += info.size
          if (size > 256 * 1024 * 1024) throw new Error("Plugin staging disk limit exceeded")
        }
      }
    }
    await visit(cwd, 0)
  }
  const timer = setInterval(() => {
    checking ??= inspect()
      .catch((error) => controller.abort(error))
      .finally(() => {
        checking = undefined
      })
  }, 100)
  try {
    // A hard per-file limit supplements the owned aggregate staging watchdog.
    const result = await runProcess(
      ["/bin/sh", "-c", 'ulimit -f 262144; exec "$@"', "plugin-install", ...argv],
      {
        cwd,
        env: installerEnv(home),
        signal: bounded,
        timeoutMs: 120000,
        maxBytes: 32768,
        onStdout: onStdout
          ? (data) => {
              try {
                onStdout(data)
              } catch (error) {
                controller.abort(error)
                throw error
              }
            }
          : undefined,
      },
    )
    bounded.throwIfAborted()
    await inspect()
    if (result.kind !== "success")
      throw new Error(`Plugin subprocess failed (${result.kind}): ${result.stderr.slice(0, 4096)}`)
    return result.stdout
  } finally {
    clearInterval(timer)
    await checking
  }
}
export class RegistrySource {
  readonly url: URL
  readonly signal: AbortSignal
  #bytes = 0
  #requests = 0
  #expanded = 0
  #entries = 0
  constructor(readonly options: AcquisitionOptions) {
    this.signal = AbortSignal.any([
      options.signal ?? new AbortController().signal,
      AbortSignal.timeout(120000),
    ])
    this.url = new URL(options.registry ?? "https://registry.npmjs.org/")
    if (
      this.url.username ||
      this.url.password ||
      this.url.search ||
      this.url.hash ||
      this.url.pathname !== "/" ||
      !(
        this.url.protocol === "https:" ||
        (this.url.protocol === "http:" && options.allowLoopback && this.url.hostname === "127.0.0.1")
      )
    )
      throw new Error("Registry requires HTTPS or explicit loopback fixture access")
  }
  async fetch(url: URL, max: number): Promise<Buffer> {
    if (++this.#requests > 256 || url.origin !== this.url.origin)
      throw new Error("Plugin registry request/origin limit exceeded")
    const result = await fetch(url, {
      signal: this.signal,
      redirect: "error",
      headers: { accept: "application/vnd.npm.install-v1+json" },
    })
    if (!result.ok || !result.body) throw new Error(`Plugin registry request failed (${result.status})`)
    const data = await boundedBody(result.body, max, this.signal, (count) => {
      this.#bytes += count
      if (this.#bytes > 128 * 1024 * 1024) throw new Error("Aggregate plugin registry byte limit exceeded")
    })
    return data
  }
  async metadata(name: string): Promise<Record<string, unknown>> {
    if (!packageName(name)) throw new Error("Invalid npm package name")
    const value: unknown = JSON.parse(
      (await this.fetch(new URL(encodeURIComponent(name), this.url), 8 * 1024 * 1024)).toString(),
    )
    if (!isTable(value) || !isTable(value.versions)) throw new Error("Invalid npm metadata")
    return value
  }
  async archive(dist: unknown): Promise<Buffer> {
    if (!isTable(dist) || typeof dist.tarball !== "string" || typeof dist.integrity !== "string")
      throw new Error("npm package requires tarball and SHA-512 integrity")
    const data = await this.fetch(new URL(dist.tarball), ARCHIVE_BYTES)
    verifyIntegrity(data, dist.integrity)
    const expanded = await unpackArchive(data, undefined, true, this.signal)
    this.#expanded += expanded.bytes
    this.#entries += expanded.entries
    if (this.#expanded > 128 * 1024 * 1024 || this.#entries > 4096)
      throw new Error("Aggregate dependency expansion limit exceeded")
    return data
  }
}
export async function acquire(
  source: string,
  target: string,
  options: AcquisitionOptions = {},
): Promise<{ source: string; registry?: string; npm?: { tarball: string; integrity: string } }> {
  const signal = AbortSignal.any([
    options.signal ?? new AbortController().signal,
    AbortSignal.timeout(120000),
  ])
  if (source.startsWith("npm:")) {
    const match = /^npm:((?:@[^/]+\/)?[^@]+)@(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)$/.exec(source)
    if (!match || !packageName(match[1]!))
      throw new Error("npm source requires an exact version: npm:NAME@1.2.3")
    const registry = new RegistrySource({ ...options, signal }),
      metadata = await registry.metadata(match[1]!),
      version = (metadata.versions as Record<string, unknown>)[match[2]!]
    if (!isTable(version) || version.name !== match[1] || version.version !== match[2])
      throw new Error("npm version is unavailable or inconsistent")
    await unpackArchive(await registry.archive(version.dist), target, true, signal)
    const dist = version.dist as { tarball: string; integrity: string }
    return {
      source,
      registry: registry.url.origin,
      npm: { tarball: dist.tarball, integrity: dist.integrity },
    }
  }
  if (source.startsWith("git:")) {
    const match = /^git:(.+)#([a-f0-9]{40})$/.exec(source)
    if (!match) throw new Error("Git plugins require a full 40-character commit pin")
    const url = match[1]!
    if (
      !(url.startsWith("https://") || url.startsWith("file://") || url.startsWith("/")) ||
      Array.from(url).some((char) => char.charCodeAt(0) <= 32)
    )
      throw new Error("Git source requires HTTPS or an explicit local repository")
    if (url.startsWith("https://") && (new URL(url).username || new URL(url).password))
      throw new Error("Git credentials must not be embedded in source URLs")
    const temp = await mkdtemp(join(target, ".git-stage-"))
    try {
      await installerCommand(["git", "init", "--bare", temp], target, temp, signal)
      await installerCommand(
        [
          "git",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "protocol.ext.allow=never",
          "fetch",
          "--depth=1",
          "--no-tags",
          url,
          match[2]!,
        ],
        temp,
        temp,
        signal,
      )
      const actual = (
        await installerCommand(["git", "rev-parse", "FETCH_HEAD^{commit}"], temp, temp, signal)
      ).trim()
      if (actual !== match[2]) throw new Error("Git source did not resolve to its commit pin")
      const parts: Uint8Array[] = []
      let size = 0
      await installerCommand(["git", "archive", "--format=tar", actual], temp, temp, signal, (data) => {
        size += data.length
        if (size > ARCHIVE_BYTES) throw new Error("Git archive exceeds 32 MiB")
        parts.push(data)
      })
      await unpackArchive(Buffer.concat(parts), target, false, signal)
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
    return { source }
  }
  const root = resolve(source.startsWith("local:") ? source.slice(6) : source)
  await copyPackage(root, target, signal)
  return { source: `local:${await realpath(root)}` }
}

/** Bun only sees sanitized registry manifests and verified archives served by this bounded owner. */
export async function installDependencies(
  root: string,
  scratch: string,
  options: AcquisitionOptions = {},
): Promise<unknown[]> {
  let original: Buffer
  try {
    original = await readFile(join(root, "package.json"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  if (original.length > 128 * 1024) throw new Error("package.json exceeds 128 KiB")
  const pkg: unknown = JSON.parse(original.toString())
  if (!isTable(pkg)) throw new Error("Invalid package.json")
  const deps = dependencyMap(pkg.dependencies),
    optional = dependencyMap(pkg.optionalDependencies)
  if (!Object.keys({ ...deps, ...optional }).length) return []
  const registry = new RegistrySource(options),
    seen = new Map<string, unknown>(),
    tarballs = new Map<string, Record<string, unknown>>(),
    resolved = new Map<string, { name: string; version: string; integrity: string; tarball: string }>()
  let requests = 0,
    failure: unknown
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      try {
        if (++requests > 256) throw new Error("Dependency request limit exceeded")
        const path = new URL(request.url).pathname
        if (path.startsWith("/archive/")) {
          const dist = tarballs.get(path)
          if (!dist) throw new Error("Unknown dependency archive")
          if (!resolved.has(path) && resolved.size >= 64)
            throw new Error("Resolved dependency limit exceeded")
          const data = await registry.archive(dist)
          resolved.set(path, {
            name: String(dist.name),
            version: String(dist.version),
            integrity: String(dist.integrity),
            tarball: String(dist.tarball),
          })
          return new Response(new Uint8Array(data))
        }
        const name = decodeURIComponent(path.slice(1)),
          metadata = await registry.metadata(name)
        const versions: Record<string, unknown> = Object.create(null)
        for (const [version, raw] of Object.entries(metadata.versions as Record<string, unknown>)) {
          if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version) || !isTable(raw) || !isTable(raw.dist))
            continue
          // Skip unsupported versions before Bun's resolver can follow arbitrary Git/file sources.
          try {
            const dependencies = dependencyMap(raw.dependencies),
              optionalDependencies = dependencyMap(raw.optionalDependencies),
              peerDependencies = dependencyMap(raw.peerDependencies)
            const key = `/archive/${encodeURIComponent(name)}-${encodeURIComponent(version)}`
            if (tarballs.size >= 10000) throw new Error("Dependency metadata version limit exceeded")
            tarballs.set(key, { ...raw.dist, name, version })
            versions[version] = {
              name,
              version,
              dependencies,
              optionalDependencies,
              peerDependencies,
              ...(isTable(raw.peerDependenciesMeta)
                ? { peerDependenciesMeta: raw.peerDependenciesMeta }
                : {}),
              ...(Array.isArray(raw.os) ? { os: raw.os } : {}),
              ...(Array.isArray(raw.cpu) ? { cpu: raw.cpu } : {}),
              dist: { ...raw.dist, tarball: `${server.url.origin}${key}` },
            }
          } catch {}
        }
        if (!seen.has(name) && seen.size >= 64) throw new Error("Plugin dependency package limit exceeded")
        seen.set(name, { name })
        return Response.json({ name, versions, "dist-tags": metadata["dist-tags"] ?? {} })
      } catch (error) {
        failure = error
        return new Response("Dependency refused", { status: 400 })
      }
    },
  })
  const work = join(scratch, "dependencies"),
    home = join(scratch, "installer-home")
  await mkdir(work, { recursive: true })
  await mkdir(home, { recursive: true })
  try {
    await writeFile(
      join(work, "package.json"),
      JSON.stringify({
        name: "codesplash-plugin-stage",
        version: "1.0.0",
        dependencies: deps,
        optionalDependencies: optional,
      }),
    )
    await writeFile(
      join(work, "bunfig.toml"),
      `[install]\nregistry = ${JSON.stringify(server.url.origin)}\ncache = false\n`,
    )
    const bun = options.bun ?? Bun.which("bun")
    if (!bun) throw new Error("Plugin dependency installation requires Bun 1.3.14 or newer on PATH")
    await installerCommand(
      [bun, "install", "--ignore-scripts", "--backend=copyfile", "--linker=hoisted", "--no-progress"],
      work,
      home,
      registry.signal,
    )
    if (failure) throw failure
    // Generated executable links are unnecessary for module loading; installed source links remain forbidden.
    await rm(join(work, "node_modules", ".bin"), { recursive: true, force: true })
    await rm(join(work, "node_modules", ".cache"), { recursive: true, force: true })
    await packageFiles(join(work, "node_modules"), registry.signal)
    await copyPackage(join(work, "node_modules"), join(root, "node_modules"), registry.signal)
    let lock = await readFile(join(work, "bun.lock"), "utf8")
    for (const [path, entry] of resolved) lock = lock.replaceAll(`${server.url.origin}${path}`, entry.tarball)
    lock = lock.replaceAll(server.url.origin, registry.url.origin)
    await writeFile(join(root, "codesplash-dependencies.lock"), lock, {
      flag: "wx",
      mode: 0o600,
    })
    return [...resolved.values()].sort((a, b) =>
      `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
    )
  } finally {
    await server.stop(true)
  }
}
