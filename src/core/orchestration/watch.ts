import { type FSWatcher, lstatSync, opendirSync, watch } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import { canonicalRoot } from "../session/files.ts"

export type FileChanges = { root: string; paths: string[]; rescan: boolean; error?: string }
type Subscription = {
  callback: (event: FileChanges) => void
  close: () => void
  pending?: FileChanges
  busy?: boolean
}
type Root = {
  path: string
  handles: Map<string, FSWatcher>
  subscribers: Set<Subscription>
  paths: Set<string>
  rescan: boolean
  error?: string
  timer?: ReturnType<typeof setTimeout>
}
/** Low-level observation only: subscribing grants no read, write or prompt authority. */
export class FileWatchService {
  #roots = new Map<string, Root>()
  #handles = 0
  #closed = false
  constructor(
    readonly limits = { roots: 64, handles: 512, subscribers: 128, paths: 1024, debounceMs: 50 },
    readonly ignore?: (path: string) => boolean,
  ) {
    if (
      Object.values(limits).some((n) => !Number.isSafeInteger(n) || n < 1) ||
      limits.roots > 64 ||
      limits.handles > 512 ||
      limits.subscribers > 128 ||
      limits.paths > 1024 ||
      limits.debounceMs > 1000
    )
      throw new Error("Invalid watcher bounds")
    this.limits = Object.freeze({ ...limits })
  }
  subscribe(path: string, callback: Subscription["callback"], signal?: AbortSignal): () => void {
    if (this.#closed) throw new Error("Watcher service is closed")
    signal?.throwIfAborted()
    if (!isAbsolute(path) || path.length > 4096 || lstatSync(path).isSymbolicLink())
      throw new Error("Watch root must be a literal absolute directory")
    path = canonicalRoot(path)
    let root = this.#roots.get(path)
    if ([...this.#roots.values()].reduce((n, r) => n + r.subscribers.size, 0) >= this.limits.subscribers)
      throw new Error("Watcher subscriber limit exceeded")
    if (!root) {
      if (this.#roots.size >= this.limits.roots) throw new Error("Watcher root limit exceeded")
      root = { path, handles: new Map(), subscribers: new Set(), paths: new Set(), rescan: false }
      this.#roots.set(path, root)
      try {
        this.#scan(root)
      } catch (error) {
        this.#drop(root)
        throw error
      }
    }
    const owned = root
    const subscription: Subscription = {
      callback,
      close: () => {
        signal?.removeEventListener("abort", subscription.close)
        owned.subscribers.delete(subscription)
        if (!owned.subscribers.size) this.#drop(owned)
      },
    }
    owned.subscribers.add(subscription)
    signal?.addEventListener("abort", subscription.close, { once: true })
    return subscription.close
  }
  #scan(root: Root) {
    const found = new Set<string>()
    const visit = (path: string, depth: number) => {
      if (path !== root.path && this.ignore?.(path)) return
      if (depth > 32) throw new Error("Watcher depth limit exceeded")
      const info = lstatSync(path)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        if (path === root.path) throw new Error("Watch root is no longer a directory")
        return
      }
      found.add(path)
      if (!root.handles.has(path)) {
        if (this.#handles >= this.limits.handles) throw new Error("Watcher handle limit exceeded")
        const handle = watch(path, { persistent: false }, (type, filename) => {
          // Native filenames are observations, never trusted paths for execution.
          const name = filename?.toString(),
            candidate = name ? join(path, name) : path
          const rel = relative(root.path, candidate)
          if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
            return this.#queue(root, undefined, true)
          this.#queue(root, candidate, type === "rename")
        })
        handle.on("error", () =>
          this.#queue(root, undefined, true, "Filesystem watcher failed; rescan required"),
        )
        root.handles.set(path, handle)
        this.#handles++
      }
      // Bound directory entries as well as open handles; a huge flat directory must fail explicitly.
      const dir = opendirSync(path)
      try {
        let count = 0
        for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
          if (++count > 20000) throw new Error("Watcher directory entry limit exceeded")
          if (entry.isDirectory() && !entry.isSymbolicLink()) visit(join(path, entry.name), depth + 1)
        }
      } finally {
        dir.closeSync()
      }
    }
    try {
      visit(root.path, 0)
    } finally {
      for (const [path, handle] of root.handles)
        if (!found.has(path)) {
          handle.close()
          root.handles.delete(path)
          this.#handles--
        }
    }
  }
  #queue(root: Root, path?: string, rescan = false, error?: string) {
    if (this.#roots.get(root.path) !== root) return
    if (path && root.paths.size < this.limits.paths) root.paths.add(path)
    else if (path) root.rescan = true
    root.rescan ||= rescan
    root.error ??= error
    if (!root.timer) root.timer = setTimeout(() => this.#flush(root), this.limits.debounceMs)
  }
  #flush(root: Root) {
    root.timer = undefined
    if (root.rescan)
      try {
        this.#scan(root)
      } catch (error) {
        root.error = error instanceof Error ? error.message : "Watcher scan failed"
      }
    const event: FileChanges = {
      root: root.path,
      paths: [...root.paths].sort(),
      rescan: root.rescan,
      error: root.error,
    }
    root.paths.clear()
    root.rescan = false
    root.error = undefined
    for (const sub of [...root.subscribers]) {
      if (!root.subscribers.has(sub)) continue
      if (sub.busy) {
        const paths = [...new Set([...(sub.pending?.paths ?? []), ...event.paths])].sort()
        sub.pending = {
          ...event,
          paths: paths.slice(0, this.limits.paths),
          rescan: event.rescan || !!sub.pending?.rescan || paths.length > this.limits.paths,
        }
      } else this.#deliver(root, sub, event)
    }
  }
  #deliver(root: Root, sub: Subscription, event: FileChanges) {
    sub.busy = true
    void Promise.resolve()
      .then(() => {
        if (root.subscribers.has(sub)) return sub.callback(structuredClone(event))
      })
      .catch(() => {})
      .finally(() => {
        sub.busy = false
        const next = sub.pending
        sub.pending = undefined
        if (next && root.subscribers.has(sub)) this.#deliver(root, sub, next)
      })
  }
  #drop(root: Root) {
    if (this.#roots.get(root.path) !== root) return
    if (root.timer) clearTimeout(root.timer)
    for (const handle of root.handles.values()) {
      handle.close()
      this.#handles--
    }
    root.handles.clear()
    this.#roots.delete(root.path)
  }
  status() {
    return {
      roots: this.#roots.size,
      handles: this.#handles,
      subscribers: [...this.#roots.values()].reduce((n, r) => n + r.subscribers.size, 0),
    }
  }
  close() {
    this.#closed = true
    for (const root of [...this.#roots.values()]) for (const sub of [...root.subscribers]) sub.close()
  }
}
