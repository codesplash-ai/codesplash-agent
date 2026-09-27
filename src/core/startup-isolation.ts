import { existsSync, realpathSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { installationRoot } from "../engines/codesplash/sandbox/entrypoint.ts"
import { contains, physicalPath } from "../engines/codesplash/sandbox/profile.ts"
import { registerChildProcess } from "./lifecycle.ts"
import { json } from "./session/files.ts"
import { startStartupBridge } from "./startup-bridge.ts"

export type StartupIsolation = {
  version: 1
  workspace: string
  configDirectory: string
  dataDirectory: string
  readRoots?: string[]
  environment?: string[]
}
export function startupProfile(raw: unknown): StartupIsolation {
  const p = raw as StartupIsolation
  if (
    !p ||
    p.version !== 1 ||
    Object.keys(p).some(
      (k) =>
        !["version", "workspace", "configDirectory", "dataDirectory", "readRoots", "environment"].includes(k),
    ) ||
    !Array.isArray(p.readRoots ?? []) ||
    (p.readRoots?.length ?? 0) > 32 ||
    !Array.isArray(p.environment ?? []) ||
    (p.environment?.length ?? 0) > 64
  )
    throw new Error("Invalid startup isolation profile")
  for (const path of [p.workspace, p.configDirectory, p.dataDirectory, ...(p.readRoots ?? [])]) {
    if (
      typeof path !== "string" ||
      !isAbsolute(path) ||
      /[\p{Cc}\p{Cf}]/u.test(path) ||
      !existsSync(path) ||
      physicalPath(path) !== path
    )
      throw new Error("Startup isolation roots must be existing physical absolute paths")
  }
  for (const root of [p.configDirectory, p.dataDirectory])
    if (contains(p.workspace, root) || contains(root, p.workspace))
      throw new Error("Agent config/state must be separate from the model workspace")
  for (const name of p.environment ?? [])
    if (
      !/^[A-Z_][A-Z0-9_]*$/.test(name) ||
      /^(?:LD_|DYLD_|NODE_|BUN_|BASH_ENV$|ENV$|HOME$|PATH$|TMP|TEMP$|CODESPLASH_(?:AGENT_(?:CONFIG|DATA)_|STARTUP_))/.test(
        name,
      )
    )
      throw new Error("Startup environment contains an unsafe override")
  return structuredClone(p)
}
function quote(path: string) {
  return JSON.stringify(path)
}
/** Outer filesystem boundary is installed by the OS launcher before Bun/provider/session initialization.
 * The host agent retains its network access; model tools retain their stricter nested network sandbox.
 */
export function startupArgv(
  p: StartupIsolation,
  temp: string,
  command: string[],
  platform = process.platform,
): string[] {
  const runtime = [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/System",
    "/Library",
    "/opt/homebrew",
    "/etc/ssl",
    "/etc/hosts",
    "/etc/resolv.conf",
    "/etc/nsswitch.conf",
    "/etc/localtime",
    "/private/etc",
    "/private/var/select",
    "/private/var/db/timezone",
    process.execPath,
    join(dirname(process.execPath), "sandbox-runtime"),
    installationRoot(),
    ...(p.readRoots ?? []),
  ]
    .filter(existsSync)
    .map(physicalPath)
  const reads = [...new Set([...runtime, p.configDirectory])],
    writes = [p.workspace, p.dataDirectory, temp]
  if (platform === "darwin") {
    const policy = [
      "(version 1)",
      "(deny default)",
      "(allow process-exec process-fork sysctl-read ipc-posix* network*)",
      "(allow process-info* signal (target same-sandbox))",
      '(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.bsd.dirhelper") (global-name "com.apple.securityd.xpc") (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent") (global-name "com.apple.SecurityServer") (global-name "com.apple.logd") (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.opendirectoryd.membership") (global-name "com.apple.system.notification_center") (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.cfprefsd.agent"))',
      "(allow file-read-metadata)",
      '(allow file-read* (literal "/"))',
      "(allow mach-priv-task-port (target same-sandbox))",
      '(allow file-ioctl (subpath "/dev"))',
      '(allow sysctl-write (sysctl-name "kern.tcsm_enable"))',
      ...reads.map((path) => `(allow file-read* (subpath ${quote(path)}))`),
      ...writes.map((path) => `(allow file-read* file-write* (subpath ${quote(path)}))`),
      ...writes.map((path) => `(deny file-write-create file-write-unlink (literal ${quote(path)}))`),
      '(allow file-read* file-write* (subpath "/dev"))',
      `(deny file-write* (subpath ${quote(physicalPath(installationRoot()))}))`,
      `(deny file-write* (subpath ${quote(p.configDirectory)}))`,
    ].join("\n")
    return ["/usr/bin/sandbox-exec", "-p", policy, ...command]
  }
  if (platform === "linux") {
    const bwrap = Bun.which("bwrap")
    if (!bwrap) throw new Error("Whole-agent isolation requires bubblewrap; no unrestricted fallback")
    const argv = [bwrap, "--die-with-parent", "--new-session", "--unshare-pid", "--cap-drop", "ALL"]
    for (const path of reads) argv.push("--ro-bind", path, path)
    // Recreate standard aliases when merged-/usr resolves them above.
    for (const path of ["/bin", "/sbin", "/lib", "/lib64", "/etc"])
      if (existsSync(path) && realpathSync(path) !== path)
        argv.push("--symlink", realpathSync(path).slice(1), path)
    argv.push("--proc", "/proc", "--dev", "/dev")
    for (const path of writes) argv.push("--bind", path, path)
    // The application installation and reviewed config remain read-only even under wider grants.
    for (const path of [physicalPath(installationRoot()), p.configDirectory])
      argv.push("--ro-bind", path, path)
    argv.push("--chdir", p.workspace, "--", ...command)
    return argv
  }
  throw new Error("Whole-agent startup isolation currently requires macOS or Linux")
}
export async function runIsolatedAgent(path: string, args: string[]): Promise<number> {
  const profile = startupProfile(json(path, 65536))
  if (!args.length || args[0] === "isolate" || args.some((a) => a.startsWith("--internal-")))
    throw new Error("isolate requires a public agent command")
  const owner = physicalPath(
    await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "cs-isolate-")),
  )
  const bridge = await startStartupBridge(profile, owner)
  const ext = import.meta.url.endsWith(".ts") ? "ts" : "js"
  const command = import.meta.url.includes("/$bunfs/")
    ? [process.execPath, ...args]
    : [process.execPath, join(dirname(fileURLToPath(import.meta.url)), `../cli.${ext}`), ...args]
  const env: NodeJS.ProcessEnv = {
    CODESPLASH_OFFLINE: process.env.CODESPLASH_OFFLINE,
    CODESPLASH_STARTUP_BRIDGE: bridge.path,
    CODESPLASH_STARTUP_TOKEN: bridge.token,
    PATH: process.env.PATH,
    HOME: owner,
    TMPDIR: owner,
    TMP: owner,
    TEMP: owner,
    LANG: process.env.LANG,
    TERM: process.env.TERM,
    CODESPLASH_AGENT_CONFIG_DIR: profile.configDirectory,
    CODESPLASH_AGENT_DATA_DIR: profile.dataDirectory,
  }
  for (const name of profile.environment ?? [])
    if (process.env[name] !== undefined) env[name] = process.env[name]
  let child: ReturnType<typeof Bun.spawn> | undefined
  let grace: ReturnType<typeof setTimeout> | undefined
  const kill = () => {
    try {
      if (child) process.kill(-child.pid, "SIGKILL")
    } catch {
      child?.kill("SIGKILL")
    }
  }
  const stop = () => {
    grace ??= setTimeout(kill, 500)
    try {
      if (child) process.kill(-child.pid, "SIGTERM")
    } catch {
      child?.kill()
    }
  }
  const unregister = registerChildProcess({ kill })
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  try {
    child = Bun.spawn(startupArgv(profile, owner, command), {
      cwd: profile.workspace,
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      detached: true,
    })
    return await child.exited
  } finally {
    kill()
    if (grace) clearTimeout(grace)
    unregister()
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
    await bridge.close()
    await rm(owner, { recursive: true, force: true })
  }
}
