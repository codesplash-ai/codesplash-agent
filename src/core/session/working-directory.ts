import { realpathSync, statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { projectIdFor } from "../sessions.ts"
import {
  type ControlRecord,
  type ControlState,
  MemorySessionState,
  type SessionStateAccess,
} from "./control.ts"

export type DirectoryRequest = {
  path: string
  context?: "carry" | "clear"
  apply?: boolean
  revision?: string
}
export type DirectoryStatus = { cwd: string; trusted: boolean }
export type DirectoryPreview = DirectoryStatus & {
  from: string
  revision: string
  context?: "carry" | "clear"
  applied: boolean
  pending: number
}
export type WorkingDirectory = {
  version: 1
  original: string
  current: string
  projectId: string
  scope: string
  from: string
  context: "carry" | "clear"
  node: string
  pending: boolean
}
export function workingDirectory(state: ControlState): WorkingDirectory | undefined {
  const value = state.values.workingDirectory as WorkingDirectory | undefined
  if (value === undefined) return undefined
  if (
    !value ||
    value.version !== 1 ||
    ![value.original, value.current, value.from].every(
      (path) => typeof path === "string" && path.length <= 4096 && isAbsolute(path),
    ) ||
    value.projectId !== projectIdFor(value.current) ||
    !/^[a-f0-9]{64}$/.test(value.scope) ||
    !/^[a-f0-9-]{36}$/.test(value.node) ||
    !["carry", "clear"].includes(value.context) ||
    typeof value.pending !== "boolean"
  )
    throw new Error("Invalid working-directory transition record")
  return value
}
export function destinationDirectory(from: string, path: string): string {
  if (!path || path.length > 4096 || path.includes("\0")) throw new Error("A directory path is required")
  const destination = realpathSync(resolve(from, path))
  if (!statSync(destination).isDirectory())
    throw new Error("Working-directory destination is not a directory")
  return destination
}
export function directoryScope(state: ControlState): string | undefined {
  const location = workingDirectory(state)
  return location && location.current !== location.original ? location.scope : undefined
}

/** Prepare control changes privately; immutable assets may be written under the existing lease.
 * A single CAS publishes the prepared state. Existing component references then use that authority. */
export class PreparedSessionState implements SessionStateAccess {
  readonly #memory = new MemorySessionState()
  #published = false
  readonly before: ControlRecord
  constructor(readonly target: SessionStateAccess) {
    this.before = target.read()
    this.#memory.update("", "directory/prepare", (state) =>
      Object.assign(state, structuredClone(this.before.state)),
    )
  }
  get directory() {
    return this.target.directory
  }
  get durable() {
    return this.target.durable
  }
  assertOwned() {
    this.target.assertOwned?.()
  }
  read() {
    return this.#published ? this.target.read() : this.#memory.read()
  }
  update(expected: string, operation: string, change: (state: ControlState) => void) {
    return (this.#published ? this.target : this.#memory).update(expected, operation, change)
  }
  publish() {
    if (this.#published) throw new Error("Prepared directory state was already published")
    this.target.assertOwned?.()
    const prepared = this.#memory.read().state
    this.target.update(this.before.revision, "directory/commit", (state) => {
      for (const key of Object.keys(state)) delete state[key as keyof ControlState]
      Object.assign(state, structuredClone(prepared))
    })
    this.#published = true
  }
}
