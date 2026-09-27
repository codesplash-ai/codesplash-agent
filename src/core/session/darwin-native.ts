import { dlopen, ptr } from "bun:ffi"

const load = () =>
  dlopen("/usr/lib/libSystem.B.dylib", {
    statfs64: { args: ["ptr", "ptr"], returns: "i32" },
  } as const)
let library: ReturnType<typeof load> | undefined

/** Darwin assigns filesystem type numbers at runtime; verify the name and local mount flag. */
export function darwinLocalFilesystem(path: string): boolean {
  if (process.platform !== "darwin" || path.includes("\0")) return false
  library ??= load()
  // Darwin's statfs64 ABI: f_flags at 64, f_fstypename[16] at 72; total size 2168.
  // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/mount.h
  const result = Buffer.alloc(2168),
    encoded = Buffer.from(`${path}\0`)
  if (library.symbols.statfs64(ptr(encoded), ptr(result)) !== 0) return false
  const name = result.subarray(72, 88).toString("utf8").replace(/\0.*$/s, "")
  return (result.readUInt32LE(64) & 0x1000) !== 0 && (name === "apfs" || name === "hfs")
}
