import { existsSync } from "node:fs"
import { join } from "node:path"
import { atomic, digest, directory, exclusive, hostPath, json } from "./files.ts"
export type ControlState = {
  title?: string
  manualTitle?: boolean
  archived?: boolean
  section?: string
  organization?: string
  position?: number
  migrated?: boolean
  values: Record<string, unknown>
}
export type ControlRecord = {
  version: 1
  revision: string
  parent: string | null
  operation: string
  created: string
  state: ControlState
}
function validState(state: ControlState): boolean {
  return Boolean(
    state?.values &&
      typeof state.values === "object" &&
      !Array.isArray(state.values) &&
      [state.title, state.section, state.organization].every(
        (value) => value === undefined || (typeof value === "string" && value.length <= 200),
      ) &&
      [state.manualTitle, state.archived, state.migrated].every(
        (value) => value === undefined || typeof value === "boolean",
      ) &&
      (state.position === undefined ||
        (typeof state.position === "number" && Number.isFinite(state.position))),
  )
}
const revision = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
export function control(root: string): ControlRecord {
  root = hostPath(root)
  directory(root)
  if (!existsSync(join(root, "control.json")))
    return {
      version: 1,
      revision: "",
      parent: null,
      operation: "initial",
      created: "",
      state: { values: {} },
    }
  const pointer = json<{ version: number; head: string; hash: string }>(join(root, "control.json"), 4096)
  if (pointer.version !== 1 || !revision.test(pointer.head))
    throw new Error("Unsupported or corrupt session control manifest")
  const record = json<ControlRecord>(join(root, "control", `${pointer.head}.json`))
  if (
    digest(JSON.stringify(record)) !== pointer.hash ||
    record.version !== 1 ||
    record.revision !== pointer.head ||
    !validState(record.state) ||
    (record.parent !== null && !revision.test(record.parent)) ||
    typeof record.operation !== "string" ||
    typeof record.created !== "string"
  )
    throw new Error("Corrupt session control record")
  return record
}
export function updateControl(
  root: string,
  expected: string,
  operation: string,
  change: (state: ControlState) => void,
): ControlRecord {
  return exclusive(root, () => {
    const before = control(root)
    if (before.revision !== expected)
      throw new Error("Session changed; reload before applying this operation")
    const state = structuredClone(before.state)
    change(state)
    if (!validState(state)) throw new Error("Invalid session control state")
    const record: ControlRecord = {
      version: 1,
      revision: crypto.randomUUID(),
      parent: before.revision || null,
      operation,
      created: new Date().toISOString(),
      state,
    }
    const serialized = JSON.stringify(record)
    if (Buffer.byteLength(serialized) > 1024 * 1024) throw new Error("Session control state exceeds 1 MiB")
    atomic(join(root, "control", `${record.revision}.json`), serialized)
    atomic(
      join(root, "control.json"),
      JSON.stringify({ version: 1, head: record.revision, hash: digest(serialized) }),
    )
    return record
  })
}
export interface SessionStateAccess {
  readonly durable: boolean
  read(): ControlRecord
  update(expected: string, operation: string, change: (state: ControlState) => void): ControlRecord
}
export class MemorySessionState implements SessionStateAccess {
  readonly durable = false
  #record: ControlRecord = {
    version: 1,
    revision: "",
    parent: null,
    operation: "initial",
    created: "",
    state: { values: {} },
  }
  read() {
    return structuredClone(this.#record)
  }
  update(expected: string, operation: string, change: (state: ControlState) => void) {
    if (expected !== this.#record.revision) throw new Error("Session changed; reload")
    const state = structuredClone(this.#record.state)
    change(state)
    if (!validState(state)) throw new Error("Invalid session control state")
    if (Buffer.byteLength(JSON.stringify(state)) > 1024 * 1024)
      throw new Error("Session control state exceeds 1 MiB")
    this.#record = {
      version: 1,
      revision: crypto.randomUUID(),
      parent: this.#record.revision || null,
      operation,
      created: new Date().toISOString(),
      state,
    }
    return this.read()
  }
}
