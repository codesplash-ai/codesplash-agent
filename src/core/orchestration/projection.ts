/** Content-addressed Git objects with explicit sparse projection. Not a kernel virtual filesystem. */
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { dataDirectory } from "../config.ts"
import { atomic, canonicalRoot, digest, directory, json, lease, localFilesystem } from "../session/files.ts"
import { git } from "./git.ts"

type Projection = {
  version: 1
  source: string
  destination: string
  head: string
  paths: string[]
  state: "creating" | "ready" | "updating"
  pending?: string[]
}
export function projectionPaths(values: string[]): string[] {
  if (!values.length || values.length > 128) throw new Error("Projection requires 1–128 relative directories")
  return [
    ...new Set(
      values.map((path) => {
        if (
          !path ||
          path.length > 1024 ||
          isAbsolute(path) ||
          path.includes("\\") ||
          /[\p{Cc}\p{Cf}]/u.test(path) ||
          path.split("/").some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git") ||
          /[*?![\]]/.test(path)
        )
          throw new Error("Projection paths must be literal relative directories")
        return path
      }),
    ),
  ].sort()
}
export class GitProjection {
  readonly root: string
  readonly destination: string
  constructor(destination: string, data = dataDirectory()) {
    this.destination = canonicalRoot(destination)
    this.root = join(data, "projections", digest(this.destination))
  }
  status(): Projection {
    const p = json<Projection>(join(this.root, "projection.json"))
    if (
      p.version !== 1 ||
      p.destination !== this.destination ||
      typeof p.source !== "string" ||
      !/^[a-f0-9]{40,64}$/.test(p.head) ||
      !["creating", "ready", "updating"].includes(p.state)
    )
      throw new Error("Invalid projection journal")
    projectionPaths(p.paths)
    if (p.pending) projectionPaths(p.pending)
    return p
  }
  async create(source: string, paths: string[]): Promise<Projection> {
    paths = projectionPaths(paths)
    const from = realpathSync(resolve(source))
    if (!lstatSync(from).isDirectory() || !localFilesystem(from) || !localFilesystem(this.destination))
      throw new Error("Projection requires physical local source and destination directories")
    if (existsSync(this.destination)) throw new Error("Projection destination must not exist")
    directory(dirname(this.destination))
    const head = (await git(from, ["rev-parse", "--verify", "HEAD^{commit}"])).toString().trim()
    directory(this.root, true)
    const release = lease(this.root, "projection.lease")
    try {
      if (existsSync(join(this.root, "projection.json")))
        throw new Error("Projection intent already exists; inspect it before recovery")
      const state: Projection = {
        version: 1,
        source: from,
        destination: this.destination,
        head,
        paths,
        state: "creating",
      }
      atomic(join(this.root, "projection.json"), JSON.stringify(state))
      // --no-local avoids hardlinks and shared alternates. The private object store is independent.
      await git(dirname(this.destination), [
        "-c",
        "protocol.file.allow=always",
        "clone",
        "--no-local",
        "--no-checkout",
        "--no-hardlinks",
        "--",
        from,
        this.destination,
      ])
      await git(this.destination, ["sparse-checkout", "init", "--cone"])
      await git(this.destination, ["sparse-checkout", "set", "--cone", "--stdin"], `${paths.join("\n")}\n`)
      await git(this.destination, ["checkout", "--detach", head])
      state.state = "ready"
      atomic(join(this.root, "projection.json"), JSON.stringify(state))
      return state
    } finally {
      release()
    }
  }
  async expand(paths: string[]): Promise<Projection> {
    paths = projectionPaths(paths)
    const release = lease(this.root, "projection.lease")
    try {
      const state = this.status()
      if (state.state !== "ready")
        throw new Error("Interrupted projection: inspect journal and Git status before recovery")
      if (realpathSync(this.destination) !== this.destination) throw new Error("Projection destination moved")
      if (
        (await git(this.destination, ["rev-parse", "HEAD"])).toString().trim() !== state.head ||
        (await git(this.destination, ["status", "--porcelain=v1", "--untracked-files=all"])).length
      )
        throw new Error("Projection changed or contains user work; expansion refused")
      state.pending = projectionPaths([...state.paths, ...paths])
      state.state = "updating"
      atomic(join(this.root, "projection.json"), JSON.stringify(state))
      await git(
        this.destination,
        ["sparse-checkout", "set", "--cone", "--stdin"],
        `${state.pending.join("\n")}\n`,
      )
      state.paths = state.pending
      delete state.pending
      state.state = "ready"
      atomic(join(this.root, "projection.json"), JSON.stringify(state))
      return state
    } finally {
      release()
    }
  }
}
