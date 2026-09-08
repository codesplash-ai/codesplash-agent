import { cc, ptr } from "bun:ffi"
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { getSystemErrorName } from "node:util"
import { snapshotPath } from "./checkpoints.ts"
import { digest, hostPath } from "./files.ts"
import source from "./secure-path.c" with { type: "file" }

const load = () => {
  const diskSource = source.startsWith("/$bunfs/")
    ? join(dirname(process.execPath), "sandbox-runtime", "restore.c")
    : source
  if (digest(readFileSync(diskSource)) !== digest(readFileSync(source)))
    throw new Error("Restore runtime asset checksum mismatch; reinstall the complete release archive")
  return cc({
    source: diskSource,
    define: process.platform === "darwin" ? { CODESPLASH_DARWIN: "1" } : {},
    symbols: {
      cs_openat: { args: ["i32", "ptr", "i32", "i32"], returns: "i32" },
      cs_mkdirat: { args: ["i32", "ptr"], returns: "i32" },
      cs_renameat: { args: ["i32", "ptr", "ptr"], returns: "i32" },
      cs_linkat: { args: ["i32", "ptr", "ptr"], returns: "i32" },
      cs_unlinkat: { args: ["i32", "ptr"], returns: "i32" },
    },
  } as const)
}
let library: ReturnType<typeof load> | undefined
function api() {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Safe file restore is supported on macOS and Linux")
  library ??= load()
  return library.symbols
}
function name(value: string): Buffer {
  if (!value || value.includes("/") || value.includes("\0") || value === "." || value === "..")
    throw new Error("Invalid relative filesystem name")
  return Buffer.from(`${value}\0`)
}
function checked(result: number): number {
  if (result < 0) {
    const code = getSystemErrorName(result),
      error = new Error(`Safe filesystem operation failed: ${code}`) as NodeJS.ErrnoException
    error.code = code
    throw error
  }
  return result
}

/** All mutation names are relative to a pinned, no-symlink directory descriptor. */
export class SafeParent {
  private constructor(
    readonly root: string,
    readonly path: string,
    readonly fd: number,
    readonly file: string,
  ) {}
  static open(root: string, path: string, create = false): SafeParent | undefined {
    const parts = snapshotPath(path).split("/"),
      file = parts.pop() as string
    if (realpathSync(root) !== hostPath(root)) throw new Error("Workspace path identity changed")
    let fd = openSync(hostPath(root), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      for (const part of parts) {
        const encoded = name(part)
        let next = api().cs_openat(
          fd,
          ptr(encoded),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          0,
        )
        if (next === -2 && create) {
          const made = api().cs_mkdirat(fd, ptr(encoded))
          if (made !== -17) checked(made)
          next = api().cs_openat(
            fd,
            ptr(encoded),
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            0,
          )
        }
        if (next === -2) {
          closeSync(fd)
          return undefined
        }
        checked(next)
        closeSync(fd)
        fd = next
      }
      return new SafeParent(root, path, fd, file)
    } catch (error) {
      closeSync(fd)
      throw error
    }
  }
  assertVisible(): void {
    const current = SafeParent.open(this.root, this.path)
    try {
      const a = fstatSync(this.fd),
        b = current ? fstatSync(current.fd) : undefined
      if (!b || a.dev !== b.dev || a.ino !== b.ino)
        throw new Error("Restore parent directory changed; held files are preserved")
    } finally {
      current?.close()
    }
  }
  read(file = this.file): { hash: string; mode: number; size: number; content: Buffer } | undefined {
    this.assertVisible()
    const encoded = name(file),
      result = api().cs_openat(
        this.fd,
        ptr(encoded),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0,
      )
    if (result === -2) return undefined
    const fd = checked(result)
    try {
      const info = fstatSync(fd)
      if (!info.isFile() || info.nlink !== 1 || info.size > 2 * 1024 * 1024)
        throw new Error("Unsafe restore file")
      const buffer = Buffer.alloc(info.size + 1)
      let size = 0
      while (size < buffer.length) {
        const count = readSync(fd, buffer, size, buffer.length - size, null)
        if (!count) break
        size += count
      }
      const after = fstatSync(fd)
      if (
        size !== info.size ||
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs ||
        after.ctimeMs !== info.ctimeMs
      )
        throw new Error("Restore file changed while reading")
      this.assertVisible()
      const content = buffer.subarray(0, size)
      return { hash: digest(content), size, mode: info.mode & 0o111 ? 0o755 : 0o644, content }
    } finally {
      closeSync(fd)
    }
  }
  write(file: string, value: Buffer, mode: number): void {
    this.assertVisible()
    const encoded = name(file),
      fd = checked(
        api().cs_openat(
          this.fd,
          ptr(encoded),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        ),
      )
    try {
      writeFileSync(fd, value)
      fchmodSync(fd, mode)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
  rename(from: string, to: string): void {
    this.assertVisible()
    const a = name(from),
      b = name(to)
    checked(api().cs_renameat(this.fd, ptr(a), ptr(b)))
    this.sync()
  }
  link(from: string, to: string): void {
    this.assertVisible()
    const a = name(from),
      b = name(to)
    checked(api().cs_linkat(this.fd, ptr(a), ptr(b)))
    this.sync()
  }
  unlink(file: string): void {
    this.assertVisible()
    const encoded = name(file)
    checked(api().cs_unlinkat(this.fd, ptr(encoded)))
    this.sync()
  }
  sync(): void {
    fsyncSync(this.fd)
  }
  close(): void {
    closeSync(this.fd)
  }
}
