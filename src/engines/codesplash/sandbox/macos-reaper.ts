import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// A tiny ABI bridge: sandbox_check is variadic, including on arm64. Bun's
// built-in C compiler handles that ABI; no external compiler/helper is needed.
// Filter constants: WebKit Source/WTF/wtf/spi/darwin/SandboxSPI.h.
const source = `
extern int sandbox_check(int, const char *, int, ...);
extern const int SANDBOX_CHECK_NO_REPORT;
extern int proc_listallpids(void *, int);
int check_tag(int pid, const char *tag) {
  return sandbox_check(pid, "mach-lookup", 2 | SANDBOX_CHECK_NO_REPORT, tag);
}
int list_pids(void *buffer, int size) { return proc_listallpids(buffer, size); }
`

async function loadBridge() {
  const { cc, ptr } = await import("bun:ffi")
  const directory = await mkdtemp(join(tmpdir(), "codesplash-reaper-"))
  try {
    const path = join(directory, "bridge.c")
    await writeFile(path, source, { mode: 0o600 })
    const library = cc({
      source: path,
      library: ["sandbox"],
      symbols: {
        check_tag: { returns: "int", args: ["int", "ptr"] },
        list_pids: { returns: "int", args: ["ptr", "int"] },
      },
    })
    return { library, ptr }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
let bridge: ReturnType<typeof loadBridge> | undefined

/** Kernel-inherited identity, independent of ppid, process group, env, and setsid. */
export async function createMacReaper(tag = `com.codesplash.cleanup.${crypto.randomUUID()}`) {
  macCleanupPolicy(tag)
  bridge ??= loadBridge()
  const { library, ptr } = await bridge
  const yes = Buffer.from(`${tag}.a\0`),
    no = Buffer.from(`${tag}.b\0`)
  const matches = (pid: number) =>
    pid > 1 &&
    pid !== process.pid &&
    library.symbols.check_tag(pid, ptr(yes)) === 0 &&
    library.symbols.check_tag(pid, ptr(no)) === 1
  // Verify the host can distinguish the negative control before admitting a command.
  if (
    library.symbols.check_tag(process.pid, ptr(yes)) !== 0 ||
    library.symbols.check_tag(process.pid, ptr(no)) !== 0
  )
    throw new Error("macOS process cleanup is unavailable inside this enclosing sandbox")
  return {
    tag,
    matches,
    kill() {
      const stopped = new Set<number>()
      // Stop before killing and rescan: a process may have forked during enumeration.
      for (let round = 0; round < 64; round++) {
        const capacity = Math.max(4096, library.symbols.list_pids(null, 0) * 2)
        const pids = new Int32Array(capacity)
        const count = library.symbols.list_pids(ptr(pids), pids.byteLength)
        if (count <= 0 || count >= capacity) throw new Error("Cannot enumerate sandbox descendants")
        let found = false
        for (const pid of pids.subarray(0, count)) {
          if (stopped.has(pid) || !matches(pid)) continue
          try {
            process.kill(pid, "SIGSTOP")
            stopped.add(pid)
            found = true
          } catch {}
        }
        if (!found) break
      }
      for (const pid of stopped) {
        // Recheck to avoid acting on a PID that exited and was reused.
        if (matches(pid)) {
          try {
            process.kill(pid, "SIGKILL")
          } catch {}
        }
      }
    },
  }
}

export function macCleanupPolicy(tag: string): string {
  if (!/^com\.codesplash\.cleanup\.[a-f0-9-]{36}$/.test(tag)) throw new Error("Invalid cleanup tag")
  // There is no service at these random names. The two policy answers identify
  // this invocation only; unconfined processes allow both and other sandboxes
  // deny both. Block nested policy application so descendants cannot remove it.
  return `\n(allow mach-lookup (global-name "${tag}.a"))\n(deny mach-lookup (global-name "${tag}.b"))\n(deny system-mac-syscall (mac-policy-name "Sandbox"))\n`
}
