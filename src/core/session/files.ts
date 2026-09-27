import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { hostname } from "node:os"
import { basename, dirname, join, parse, resolve } from "node:path"
import { darwinLocalFilesystem } from "./darwin-native.ts"
import { WindowsParent, windowsLocalFilesystem } from "./windows-native.ts"
export const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
export function component(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) || value === "..")
    throw new Error("Invalid session identifier")
  return value
}
export function hostPath(path: string): string {
  const absolute = resolve(path)
  return process.platform === "darwin" ? absolute.replace(/^\/(tmp|var)(?=\/|$)/, "/private/$1") : absolute
}
export function canonicalRoot(path: string): string {
  let parent = resolve(path)
  const parts: string[] = []
  while (!existsSync(parent)) {
    parts.unshift(basename(parent))
    parent = dirname(parent)
  }
  return join(realpathSync(parent), ...parts)
}
export function directory(path: string, create = false): void {
  path = hostPath(path)
  let current = parse(path).root
  for (const part of path.slice(current.length).split(process.platform === "win32" ? /[\\/]/ : /\//)) {
    current = join(current, part)
    if (!existsSync(current)) {
      if (!create) return
      mkdirSync(current, { mode: 0o700 })
    }
    const info = lstatSync(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe session directory")
  }
}
export function bytes(path: string, max = 1024 * 1024): Buffer {
  path = hostPath(path)
  if (process.platform === "win32") {
    const parent = WindowsParent.open(dirname(path), basename(path))
    try {
      const result = parent?.read(undefined, max)
      if (!result) {
        const error = new Error("File does not exist") as NodeJS.ErrnoException
        error.code = "ENOENT"
        throw error
      }
      return result.content
    } finally {
      parent?.close()
    }
  }
  directory(dirname(path))
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.nlink !== 1 || info.size > max)
      throw new Error("Session file is unsafe or exceeds its size limit")
    const output = Buffer.alloc(Math.min(info.size + 1, max + 1))
    let size = 0
    while (size < output.length) {
      const count = readSync(fd, output, size, output.length - size, null)
      if (!count) break
      size += count
    }
    if (size > info.size || size > max) throw new Error("Session file changed while reading")
    return output.subarray(0, size)
  } finally {
    closeSync(fd)
  }
}
export function json<T>(path: string, max = 1024 * 1024): T {
  const source = bytes(path, max).toString()
  try {
    return JSON.parse(source) as T
  } catch {
    throw new Error("Invalid session JSON; preserve the file before recovery")
  }
}
export function atomic(path: string, value: string | Uint8Array): void {
  path = hostPath(path)
  if (process.platform === "win32") {
    const parent = WindowsParent.open(dirname(path), basename(path), true, true)
    if (!parent) throw new Error("Could not open Windows storage parent")
    const temp = `${basename(path)}.${crypto.randomUUID()}.tmp`
    let staged = false
    try {
      parent.write(temp, Buffer.from(value), 0o600)
      staged = true
      parent.rename(temp, basename(path))
      staged = false
    } finally {
      try {
        if (staged) parent.unlink(temp)
      } finally {
        parent.close()
      }
    }
    return
  }
  directory(dirname(path), true)
  const temp = `${path}.${crypto.randomUUID()}.tmp`
  try {
    const fd = openSync(temp, "wx", 0o600)
    try {
      writeFileSync(fd, value)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
    const parent = openSync(dirname(path), "r")
    try {
      fsyncSync(parent)
    } finally {
      closeSync(parent)
    }
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
}
export const hostId = () => digest(hostname()).slice(0, 24)
export function localFilesystem(path: string): boolean {
  if (process.platform === "win32") return windowsLocalFilesystem(path)
  try {
    let parent = hostPath(path)
    while (!existsSync(parent)) parent = dirname(parent)
    if (process.platform === "darwin") return darwinLocalFilesystem(parent)
    const type = Number(statfsSync(parent).type)
    return [0xef53, 0x01021994, 0x794c7630, 0x58465342, 0x9123683e].includes(type)
  } catch {
    return false
  }
}
export type Lease = { host: string; pid: number; nonce: string }
export function owner(path: string): Lease | undefined {
  path = hostPath(path)
  if (!existsSync(path)) return undefined
  const value = json<Lease>(path, 4096)
  if (
    !value ||
    !Number.isInteger(value.pid) ||
    value.pid < 1 ||
    typeof value.host !== "string" ||
    typeof value.nonce !== "string"
  )
    throw new Error("Invalid session lease; inspect before recovery")
  if (value.host !== hostId()) return value
  try {
    process.kill(value.pid, 0)
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return value
  }
  return undefined
}
export function lease(directoryPath: string, name = "writer.lease"): () => void {
  directoryPath = hostPath(directoryPath)
  if (!localFilesystem(directoryPath))
    throw new Error("Session writes require verified local storage; use a local data directory")
  directory(directoryPath, true)
  const path = join(directoryPath, component(name))
  // An OS-backed SQLite lock serializes stale-file reclamation across processes.
  // The empty lock database carries no session state and is never replaced while in use.
  const lockPath = join(directoryPath, `.${name}.sqlite`)
  try {
    closeSync(openSync(lockPath, "wx", 0o600))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  const lockInfo = lstatSync(lockPath)
  if (!lockInfo.isFile() || lockInfo.nlink !== 1) throw new Error("Unsafe session lock")
  const database = new Database(lockPath)
  try {
    database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE")
  } catch {
    database.close()
    throw new Error("Session is active or owned by another host")
  }
  try {
    if (existsSync(path)) {
      const before = lstatSync(path)
      if (owner(path)) throw new Error("Session is active or owned by another host")
      const after = lstatSync(path)
      if (before.ino !== after.ino || before.dev !== after.dev)
        throw new Error("Session owner changed; retry")
      unlinkSync(path)
    }
    const fd = openSync(path, "wx", 0o600),
      info = fstatSync(fd)
    try {
      writeFileSync(fd, JSON.stringify({ host: hostId(), pid: process.pid, nonce: crypto.randomUUID() }))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      try {
        if (existsSync(path)) {
          const next = lstatSync(path)
          if (next.ino === info.ino && next.dev === info.dev) unlinkSync(path)
        }
      } finally {
        database.close()
      }
    }
  } catch (error) {
    database.close()
    throw error
  }
}
export function exclusive<T>(root: string, operation: () => T): T {
  const release = lease(root, "operation.lease")
  try {
    return operation()
  } finally {
    release()
  }
}
