/** Explicit irreversible startup hardening. Call before reading credentials or opening sessions. */
export async function hardenProcess(): Promise<{
  coreDumps: false
  debuggerAttach: false
  noNewPrivileges: boolean
}> {
  if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch))
    throw new Error("Process hardening is unavailable on this platform; startup refused")
  for (const name of Object.keys(process.env))
    if (/^(?:LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$|BUN_OPTIONS$|BASH_ENV$|ENV$)/.test(name))
      delete process.env[name]
  const { dlopen, ptr } = await import("bun:ffi")
  const zero = new Uint8Array(16),
    actual = new Uint8Array(16)
  const common = {
    setrlimit: { args: ["i32", "ptr"], returns: "i32" },
    getrlimit: { args: ["i32", "ptr"], returns: "i32" },
  } as const
  if (process.platform === "linux") {
    const lib = dlopen("libc.so.6", {
      ...common,
      prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
    })
    try {
      if (
        lib.symbols.setrlimit(4, ptr(zero)) !== 0 ||
        lib.symbols.getrlimit(4, ptr(actual)) !== 0 ||
        actual.some(Boolean) ||
        lib.symbols.prctl(4, 0, 0, 0, 0) !== 0 ||
        lib.symbols.prctl(3, 0, 0, 0, 0) !== 0 ||
        lib.symbols.prctl(38, 1, 0, 0, 0) !== 0 ||
        lib.symbols.prctl(39, 0, 0, 0, 0) !== 1
      )
        throw new Error("Kernel startup hardening failed; startup refused")
    } finally {
      lib.close()
    }
  } else {
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      ...common,
      ptrace: { args: ["i32", "i32", "ptr", "i32"], returns: "i32" },
    })
    try {
      if (
        lib.symbols.setrlimit(4, ptr(zero)) !== 0 ||
        lib.symbols.getrlimit(4, ptr(actual)) !== 0 ||
        actual.some(Boolean) ||
        lib.symbols.ptrace(31, 0, null, 0) !== 0
      )
        throw new Error("Kernel startup hardening failed; startup refused")
    } finally {
      lib.close()
    }
  }
  return { coreDumps: false, debuggerAttach: false, noNewPrivileges: process.platform === "linux" }
}
