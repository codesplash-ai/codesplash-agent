import { existsSync, lstatSync, rmSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { atomic, canonicalRoot, directory, hostPath, json, lease } from "../session/files.ts"

type Claim = { id: string; paths: string[]; running: boolean }
const busy = (error: unknown) =>
  error instanceof Error && error.message === "Session is active or owned by another host"
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const contains = (parent: string, child: string) => {
  const rel = relative(parent, child)
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"))
}
const overlap = (a: Claim, b: Claim) =>
  a.paths.some((p) => b.paths.some((q) => contains(p, q) || contains(q, p)))

/** Cross-process claims; only actual operation settlement authorizes release. */
export class MutationCoordinator {
  readonly root: string
  constructor(root = join("/tmp", `codesplash-mutations-${process.getuid?.() ?? "user"}`)) {
    // Stable across callers with different TMPDIR values; do not follow a pre-created symlink.
    this.root = hostPath(root)
  }
  #prepare() {
    directory(this.root, true)
    const info = lstatSync(this.root)
    if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))
      throw new Error("Mutation coordination requires a private owned directory")
  }
  #read(): Claim[] {
    const path = join(this.root, "claims.json")
    if (!existsSync(path)) return []
    const entries = json<Claim[]>(path)
    if (
      !Array.isArray(entries) ||
      entries.length > 128 ||
      entries.some(
        (c) =>
          !c ||
          !uuid.test(c.id) ||
          typeof c.running !== "boolean" ||
          !Array.isArray(c.paths) ||
          c.paths.length < 1 ||
          c.paths.length > 64 ||
          c.paths.some((p) => typeof p !== "string" || !isAbsolute(p) || p.length > 4096),
      ) ||
      new Set(entries.map((c) => c.id)).size !== entries.length
    )
      throw new Error("Corrupt mutation claim registry")
    return entries
  }
  async #change<T>(change: (claims: Claim[]) => T, signal?: AbortSignal): Promise<T> {
    for (;;) {
      signal?.throwIfAborted()
      let release: () => void
      try {
        release = lease(this.root, "registry.lease")
      } catch (error) {
        if (!busy(error)) throw error
        await delay(20, undefined, { signal })
        continue
      }
      try {
        const claims = this.#read()
        const result = change(claims)
        atomic(join(this.root, "claims.json"), JSON.stringify(claims))
        return result
      } finally {
        release()
      }
    }
  }
  #reap(claims: Claim[], own: string) {
    for (let i = claims.length - 1; i >= 0; i--) {
      const claim = claims[i]!
      if (claim.id === own) continue
      const path = join(this.root, claim.id)
      let release: () => void
      try {
        release = lease(path)
      } catch (error) {
        if (busy(error)) continue
        throw error
      }
      release()
      claims.splice(i, 1)
      rmSync(path, { recursive: true })
    }
  }
  async acquire(paths: readonly string[], signal: AbortSignal): Promise<() => Promise<void>> {
    signal.throwIfAborted()
    // Maintain one upstream subscription through every polling delay. Bun timeout signals can
    // otherwise lose their timer when the last temporary timer listener is removed between polls.
    const owned = new AbortController()
    const cancel = () => owned.abort(signal.reason)
    signal.addEventListener("abort", cancel, { once: true })
    try {
      return await this.#acquire(paths, owned.signal)
    } finally {
      signal.removeEventListener("abort", cancel)
    }
  }
  async #acquire(paths: readonly string[], signal: AbortSignal): Promise<() => Promise<void>> {
    signal.throwIfAborted()
    if (!paths.length || paths.length > 64 || paths.some((p) => !isAbsolute(p) || p.length > 4096))
      throw new Error("Mutation claims require 1–64 absolute paths")
    this.#prepare()
    const claim: Claim = {
      id: crypto.randomUUID(),
      paths: [...new Set(paths.map(canonicalRoot))].sort(),
      running: false,
    }
    const ownPath = join(this.root, claim.id)
    const releaseOwner = lease(ownPath)
    let registered = false
    const cleanup = async () => {
      if (registered)
        await this.#change((claims) => {
          const index = claims.findIndex((c) => c.id === claim.id)
          if (index < 0) throw new Error("Mutation claim ownership lost")
          claims.splice(index, 1)
        })
      releaseOwner()
      rmSync(ownPath, { recursive: true })
    }
    try {
      await this.#change((claims) => {
        this.#reap(claims, claim.id)
        if (claims.length >= 128) throw new Error("Mutation admission queue is full")
        claims.push(claim)
      }, signal)
      registered = true
      for (;;) {
        const admitted = await this.#change((claims) => {
          this.#reap(claims, claim.id)
          const index = claims.findIndex((c) => c.id === claim.id)
          if (index < 0) throw new Error("Mutation claim ownership lost")
          if (claims.some((c, i) => i !== index && (c.running || i < index) && overlap(c, claim)))
            return false
          claims[index]!.running = true
          return true
        }, signal)
        if (admitted) {
          let released: Promise<void> | undefined
          return () => {
            released ??= cleanup()
            return released
          }
        }
        await delay(20, undefined, { signal })
      }
    } catch (error) {
      await cleanup()
      throw error
    }
  }
  async run<T>(paths: readonly string[], signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(paths, signal)
    try {
      signal.throwIfAborted()
      return await operation()
    } finally {
      await release()
    }
  }
}
export const workspaceMutations = new MutationCoordinator()
