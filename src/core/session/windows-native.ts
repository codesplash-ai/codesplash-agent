import { dlopen, ptr } from "bun:ffi"
import { win32 } from "node:path"
import { validateWindowsPath } from "../platform.ts"

const wchar = (s: string) => Buffer.from(`${s}\0`, "utf16le")
let loaded: ReturnType<typeof load> | undefined
function load() {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw Error("Native Windows filesystem transactions require Windows x64")
  const system = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32")
  const kernel = dlopen(win32.join(system, "kernel32.dll"), {
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "u64" },
    SetInformationJobObject: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
    AssignProcessToJobObject: { args: ["u64", "u64"], returns: "i32" },
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    LocalFree: { args: ["u64"], returns: "u64" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
    GetLongPathNameW: { args: ["ptr", "ptr", "u32"], returns: "u32" },
    GetFileInformationByHandle: { args: ["u64", "ptr"], returns: "i32" },
    ReadFile: { args: ["u64", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
    WriteFile: { args: ["u64", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
    FlushFileBuffers: { args: ["u64"], returns: "i32" },
    SetFileInformationByHandle: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
    GetVolumePathNameW: { args: ["ptr", "ptr", "u32"], returns: "i32" },
    GetDriveTypeW: { args: ["ptr"], returns: "u32" },
    GetVolumeInformationW: { args: ["ptr", "ptr", "u32", "ptr", "ptr", "ptr", "ptr", "u32"], returns: "i32" },
  } as const)
  const security = dlopen(win32.join(system, "advapi32.dll"), {
    ConvertStringSecurityDescriptorToSecurityDescriptorW: {
      args: ["ptr", "u32", "ptr", "ptr"],
      returns: "i32",
    },
  } as const)
  const nt = dlopen(win32.join(system, "ntdll.dll"), {
    NtSetInformationFile: {
      args: ["u64", "ptr", "ptr", "u32", "i32"],
      returns: "i32",
    },
    NtCreateFile: {
      args: ["ptr", "u32", "ptr", "ptr", "ptr", "u32", "u32", "u32", "u32", "ptr", "u32"],
      returns: "i32",
    },
    RtlNtStatusToDosError: { args: ["i32"], returns: "u32" },
  } as const)
  return { kernel, nt, security, k: kernel.symbols, n: nt.symbols, securityApi: security.symbols }
}
const api = () => {
  loaded ??= load()
  return loaded
}
function error(code: number): never {
  const e = new Error(`Windows filesystem operation failed (${code})`) as NodeJS.ErrnoException
  e.code =
    (
      { 2: "ENOENT", 3: "ENOENT", 5: "EACCES", 32: "EBUSY", 80: "EEXIST", 183: "EEXIST" } as Record<
        number,
        string
      >
    )[code] ?? "EIO"
  throw e
}
/** Resolve 8.3 aliases while the broker can still discover parent names.
 * The restricted child must not need parent-directory read access merely to
 * expand RUNNER~1 when PowerShell normalizes its working directory. */
export function windowsLongPath(path: string): string {
  validateWindowsPath(path)
  const input = wchar(path),
    output = Buffer.alloc(32768 * 2)
  const length = api().k.GetLongPathNameW(ptr(input), ptr(output), 32768)
  if (!length) error(api().k.GetLastError())
  if (length >= 32768) throw Error("Expanded Windows path exceeds the native limit")
  return output.subarray(0, length * 2).toString("utf16le")
}
function checked(ok: number) {
  if (!ok) error(api().k.GetLastError())
}
function close(h: bigint) {
  checked(api().k.CloseHandle(h))
}
function info(h: bigint) {
  const b = Buffer.alloc(52)
  checked(api().k.GetFileInformationByHandle(h, ptr(b)))
  return {
    attributes: b.readUInt32LE(0),
    volume: b.readUInt32LE(28),
    size: b.readUInt32LE(36) + b.readUInt32LE(32) * 2 ** 32,
    links: b.readUInt32LE(40),
    id: `${b.readUInt32LE(44)}:${b.readUInt32LE(48)}`,
    stamp: b.subarray(4, 28).toString("hex"),
  }
}
function relative(
  parent: bigint,
  name: string,
  access: number,
  disposition: number,
  directory = false,
  privateAccess = false,
): bigint {
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name))
    throw Error("Invalid relative Windows name")
  validateWindowsPath(`C:\\${name}`)
  const encoded = wchar(name),
    unicode = Buffer.alloc(16),
    object = Buffer.alloc(48),
    status = Buffer.alloc(16),
    out = Buffer.alloc(8)
  unicode.writeUInt16LE(encoded.length - 2, 0)
  unicode.writeUInt16LE(encoded.length, 2)
  unicode.writeBigUInt64LE(BigInt(ptr(encoded)), 8)
  object.writeUInt32LE(48, 0)
  object.writeBigUInt64LE(parent, 8)
  object.writeBigUInt64LE(BigInt(ptr(unicode)), 16)
  object.writeUInt32LE(0x40, 24)
  const descriptor = Buffer.alloc(8)
  if (privateAccess) {
    // New state files/directories must not inherit public read/write grants.
    const sddl = wchar("D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
    checked(
      api().securityApi.ConvertStringSecurityDescriptorToSecurityDescriptorW(
        ptr(sddl),
        1,
        ptr(descriptor),
        null,
      ),
    )
    object.writeBigUInt64LE(descriptor.readBigUInt64LE(), 32)
  }
  // No share-delete: an opened ancestor/file cannot be swapped while this transaction owns it.
  const result = api().n.NtCreateFile(
    ptr(out),
    // Every opened handle is inspected below, including write/delete-only callers.
    // Metadata-only handles do not enforce delete sharing; list access pins directories.
    (access | 0x100000 | 0x80 | (directory ? 1 : 0)) >>> 0,
    ptr(object),
    ptr(status),
    null,
    0x80,
    3,
    disposition,
    0x200000 | 0x20 | (directory ? 1 : 0x40),
    null,
    0,
  )
  if (privateAccess) api().k.LocalFree(descriptor.readBigUInt64LE())
  if (result < 0) error(api().n.RtlNtStatusToDosError(result))
  const handle = out.readBigUInt64LE()
  try {
    if (info(handle).attributes & 0x400) throw Error("Reparse points are refused in filesystem transactions")
    return handle
  } catch (error) {
    close(handle)
    throw error
  }
}
export function windowsLocalFilesystem(path: string): boolean {
  try {
    validateWindowsPath(win32.resolve(path))
    const root = Buffer.alloc(65536),
      fs = Buffer.alloc(128)
    checked(api().k.GetVolumePathNameW(ptr(wchar(path)), ptr(root), 32768))
    if (api().k.GetDriveTypeW(ptr(root)) !== 3) return false
    checked(api().k.GetVolumeInformationW(ptr(root), null, 0, null, null, null, ptr(fs), 64))
    return fs.toString("utf16le").replace(/\0.*$/s, "") === "NTFS"
  } catch {
    return false
  }
}
export class WindowsParent {
  private constructor(
    readonly root: string,
    readonly path: string,
    readonly file: string,
    readonly handles: bigint[],
  ) {}
  static open(root: string, path: string, create = false, privateParents = false): WindowsParent | undefined {
    validateWindowsPath(root)
    validateWindowsPath(win32.join(root, path))
    if (!windowsLocalFilesystem(root)) throw Error("Windows transactions require local NTFS")
    const drive = win32.parse(root).root,
      parts = [...root.slice(drive.length).split("\\").filter(Boolean), ...path.split("/")],
      file = parts.pop()!
    const handle = BigInt(
      api().k.CreateFileW(ptr(wchar(drive)), 0x81 | 0x100000, 3, null, 3, 0x2000000 | 0x200000, 0n),
    )
    if (handle === 0xffffffffffffffffn) error(api().k.GetLastError())
    const handles = [handle]
    try {
      for (const part of parts) {
        let next: bigint
        try {
          next = relative(handles.at(-1)!, part, 0x80, 1, true)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
          if (!create) {
            for (const h of handles.reverse()) close(h)
            return undefined
          }
          next = relative(handles.at(-1)!, part, 0x80, 3, true, privateParents)
        }
        handles.push(next)
      }
      return new WindowsParent(root, path, file, handles)
    } catch (e) {
      for (const h of handles.reverse()) close(h)
      throw e
    }
  }
  get handle() {
    return this.handles.at(-1)!
  }
  assertVisible() {
    const current = WindowsParent.open(this.root, this.path)
    try {
      if (!current) throw Error("Windows parent disappeared")
      const a = info(this.handle),
        b = info(current.handle)
      if (a.id !== b.id || a.volume !== b.volume) throw Error("Windows parent identity changed")
    } finally {
      current?.close()
    }
  }
  read(
    file = this.file,
    max = 2 * 1024 * 1024,
  ): { hash: string; mode: number; size: number; content: Buffer } | undefined {
    this.assertVisible()
    let h: bigint
    try {
      h = relative(this.handle, file, 0x80000000, 1)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return
      throw e
    }
    try {
      const before = info(h)
      if (before.links !== 1 || before.size > max || before.attributes & 0x10)
        throw Error("Unsafe Windows restore file")
      const out = Buffer.alloc(before.size + 1),
        count = Buffer.alloc(4)
      checked(api().k.ReadFile(h, ptr(out), out.length, ptr(count), null))
      const after = info(h)
      if (count.readUInt32LE() !== before.size || after.size !== before.size || after.stamp !== before.stamp)
        throw Error("Windows restore file changed")
      const content = out.subarray(0, before.size)
      return {
        hash: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
        size: before.size,
        mode: 0o644,
        content,
      }
    } finally {
      close(h)
    }
  }
  write(file: string, value: Buffer, mode: number) {
    this.assertVisible()
    const h = relative(this.handle, file, 0x40000000, 2, false, mode === 0o600)
    try {
      let at = 0
      const count = Buffer.alloc(4)
      while (at < value.length) {
        checked(api().k.WriteFile(h, ptr(value.subarray(at)), value.length - at, ptr(count), null))
        const n = count.readUInt32LE()
        if (!n) throw Error("Short Windows write")
        at += n
      }
      checked(api().k.FlushFileBuffers(h))
    } finally {
      close(h)
    }
  }
  #move(from: string, to: string, link: boolean) {
    this.assertVisible()
    const h = relative(this.handle, from, 0x10000 | 0x80, 1)
    try {
      const name = wchar(to)
      validateWindowsPath(`C:\\${to}`)
      if (/[\\/]/.test(to)) throw Error("Invalid relative target")
      const data = Buffer.alloc(Math.max(24, 20 + name.length))
      data.writeUInt8(link ? 0 : 1, 0)
      data.writeBigUInt64LE(this.handle, 8)
      data.writeUInt32LE(name.length - 2, 16)
      name.copy(data, 20, 0, name.length - 2)
      // NT rename/link classes resolve the destination against our pinned directory.
      // Win32 FileInfoByHandle classes are a different enumeration (11 is not a link).
      const status = Buffer.alloc(16)
      const result = api().n.NtSetInformationFile(h, ptr(status), ptr(data), data.length, link ? 11 : 10)
      if (result < 0) error(api().n.RtlNtStatusToDosError(result))
    } finally {
      close(h)
    }
  }
  rename(from: string, to: string) {
    this.#move(from, to, false)
  }
  link(from: string, to: string) {
    this.#move(from, to, true)
  }
  unlink(file: string) {
    this.assertVisible()
    const h = relative(this.handle, file, 0x10000, 1)
    try {
      const data = Buffer.from([1])
      checked(api().k.SetFileInformationByHandle(h, 4, ptr(data), 1))
    } finally {
      close(h)
    }
  }
  sync() {
    /* Each file is flushed before activation; Windows has no supported directory fsync. */
  }
  close() {
    for (const h of this.handles.splice(0).reverse()) close(h)
  }
}

/** Trusted supervisors wait for stdin until assignment; child jobs remain owned after broker death. */
export function windowsProcessJob(pid: number): () => void {
  const k = api().k,
    job = BigInt(k.CreateJobObjectW(null, null))
  if (!job) error(k.GetLastError())
  let active = true
  const cleanup = () => {
    if (active) {
      active = false
      close(job)
    }
  }
  try {
    const limits = Buffer.alloc(144)
    // Permit the native broker's deliberate nested-job handoff; its workload job forbids breakaway.
    limits.writeUInt32LE(0x2000 | 0x800, 16)
    checked(k.SetInformationJobObject(job, 9, ptr(limits), limits.length))
    const processHandle = BigInt(k.OpenProcess(0x100 | 1, 0, pid))
    if (!processHandle) error(k.GetLastError())
    try {
      checked(k.AssignProcessToJobObject(job, processHandle))
    } finally {
      close(processHandle)
    }
    return cleanup
  } catch (e) {
    cleanup()
    throw e
  }
}
