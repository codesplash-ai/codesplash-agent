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
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, parse, resolve } from "node:path"

export function directory(path: string, create = false): void {
  const absolute = resolve(path)
  let current = parse(absolute).root
  for (const part of absolute.slice(current.length).split("/")) {
    current = join(current, part)
    if (!existsSync(current)) {
      if (!create) return
      mkdirSync(current, { mode: 0o700 })
    }
    const info = lstatSync(current)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Memory directory must not contain symlinks")
  }
}
export function readBounded(path: string, max = 1024 * 1024): string {
  directory(dirname(path))
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.nlink !== 1 || info.size > max)
      throw new Error("Memory file must be a bounded regular singly-linked file")
    const bytes = Buffer.alloc(max + 1)
    let size = 0
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size, null)
      if (!n) break
      size += n
    }
    if (size > max) throw new Error("Memory file exceeds its size limit")
    return bytes.subarray(0, size).toString("utf8")
  } finally {
    closeSync(fd)
  }
}
export function atomicWrite(path: string, text: string): void {
  directory(dirname(path), true)
  const temp = `${path}.${crypto.randomUUID()}.tmp`
  const fd = openSync(temp, "wx", 0o600)
  try {
    writeFileSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
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
export function locked<T>(root: string, operation: () => T): T {
  directory(root, true)
  const path = join(root, "writer.lock")
  let fd: number
  try {
    fd = openSync(path, "wx", 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const info = lstatSync(path)
    const value = JSON.parse(readBounded(path, 1024)) as { pid?: unknown }
    if (!Number.isInteger(value.pid) || Number(value.pid) <= 0)
      throw new Error("Invalid memory writer lock; inspect before recovery")
    try {
      process.kill(Number(value.pid), 0)
      throw new Error("Memory store is busy; retry after the other writer finishes")
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== "ESRCH") throw failure
    }
    const current = lstatSync(path)
    if (current.ino !== info.ino || current.dev !== info.dev) throw new Error("Memory writer changed; retry")
    unlinkSync(path)
    fd = openSync(path, "wx", 0o600)
  }
  const identity = fstatSync(fd)
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID() }))
    fsyncSync(fd)
    return operation()
  } finally {
    closeSync(fd)
    if (existsSync(path)) {
      const current = lstatSync(path)
      if (current.ino === identity.ino && current.dev === identity.dev) unlinkSync(path)
    }
  }
}
