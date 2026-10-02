import { existsSync, readFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { dirname, join, parse, win32 } from "node:path"
import { fileURLToPath } from "node:url"
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime"
import { digest, lease } from "../../../core/session/files.ts"
import { installationRoot } from "./entrypoint.ts"
import type { SupervisorInput } from "./supervisor.ts"

const hashes: Record<string, string> = {
  x64: "82871cfa804d24f1bad16b946d1008db69890d6828887b9d0073e1b0185a9eb2",
  arm64: "b9dc970e3b52ac70a1471cb73a17928ef8a299fbd502628f1f70c53e7a07ff4e",
}
export function verifiedWindowsHelper(): string {
  const candidates = [join(dirname(process.execPath), "sandbox-runtime", "srt-win.exe")]
  if (!import.meta.url.includes("/$bunfs/"))
    candidates.push(
      fileURLToPath(
        new URL(
          `../../../../node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/${process.arch}/srt-win.exe`,
          import.meta.url,
        ),
      ),
    )
  const path = candidates.find(existsSync)
  if (!path || digest(readFileSync(path)) !== hashes[process.arch])
    throw new Error("Windows sandbox helper missing or altered; reinstall the complete package")
  return path
}
/** Never stamp the whole Program Files tree: installed SDKs/WindowsApps can
 * hold ACL propagation indefinitely. Grant supported command runtimes only;
 * additional toolchains still require explicit profile read roots. */
export function windowsToolReadRoots(programFiles: string): string[] {
  return ["Git", "PowerShell", "nodejs"].map((tool) => win32.join(programFiles, tool))
}
export function windowsRuntimeConfig(input: SupervisorInput): SandboxRuntimeConfig {
  const p = input.profile,
    system = process.env.SystemRoot ?? "C:\\Windows"
  const roots = [
    ...new Set(
      [
        p.cwd,
        input.temp,
        installationRoot(),
        ...p.readRoots,
        ...p.writeRoots,
        ...p.protectedPaths,
        ...p.deniedReadPaths,
      ].map((path) => parse(path).root),
    ),
  ]
  // Root denies plus explicit grants make the read boundary independent of ambient Everyone ACLs.
  // The backend refuses if the operator cannot stamp these ACLs; it never drops a failed rule.
  return {
    windows: { srtWin: { path: verifiedWindowsHelper() } },
    network: {
      allowedDomains: p.allowedHosts,
      deniedDomains: [],
      strictAllowlist: true,
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: [...roots, ...p.deniedReadPaths],
      allowRead: [
        system,
        ...windowsToolReadRoots(process.env.ProgramFiles ?? "C:\\Program Files"),
        process.execPath,
        installationRoot(),
        input.temp,
        ...p.readRoots,
        ...p.writeRoots,
      ].filter(existsSync),
      allowWrite: [...(input.planFile ? [input.planFile] : p.writeRoots), input.temp],
      denyWrite: [...p.protectedPaths, installationRoot()],
    },
    enableWeakerNetworkIsolation: false,
  }
}
const ps = (text: string) => `'${text.replaceAll("'", "''")}'`
/** PowerShell normalizes every ancestor of a drive-qualified Set-Location.
 * A private drive rooted at the already-authorized work folder avoids inspecting
 * denied parents. This changes provider navigation only; no ACL is broadened.
 * Native programs still inherit the real filesystem path, never the PS alias. */
export function windowsPowerShellLocation(cwd: string): string[] {
  return [
    `New-PSDrive -Name CodeSplashWorkspace -PSProvider FileSystem -Root ${ps(cwd)} -ErrorAction Stop | Out-Null`,
    "Set-Location -LiteralPath 'CodeSplashWorkspace:\\' -ErrorAction Stop",
    `[IO.Directory]::SetCurrentDirectory(${ps(cwd)})`,
    `if ($PWD.ProviderPath -ne ${ps(cwd)} -or [IO.Directory]::GetCurrentDirectory() -ne ${ps(cwd)}) { throw 'Sandbox working directory mismatch' }`,
  ]
}
/** The workload shell is a separate PowerShell process and needs the same
 * provider root. Preserve its executable, arguments and original command. */
export function windowsWorkloadArgv(argv: string[], cwd: string): string[] {
  if (!/^(?:powershell|pwsh)(?:\.exe)?$/i.test(win32.basename(argv[0] ?? ""))) return argv
  if (argv.some((arg) => /^-File$/i.test(arg))) return argv
  const index = argv.findIndex((arg) => /^(?:-EncodedCommand|-Command)$/i.test(arg))
  if (index < 0 || index !== argv.length - 2) return argv
  const value = argv[index + 1]
  if (value === undefined) return argv
  const encoded = argv[index]?.toLowerCase() === "-encodedcommand"
  const command = encoded ? Buffer.from(value, "base64").toString("utf16le") : value
  const prepared = ["$ErrorActionPreference = 'Stop'", ...windowsPowerShellLocation(cwd), command].join(
    "\r\n",
  )
  return [
    ...argv.slice(0, index + 1),
    encoded ? Buffer.from(prepared, "utf16le").toString("base64") : prepared,
  ]
}
/** Private file keeps named secrets off the host's process command line. */
export async function windowsCommand(input: SupervisorInput) {
  const path = join(input.temp, "invoke.ps1")
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    ...Object.entries({ ...input.workloadEnv, ...input.secrets })
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\0\r\n]/.test(value))
          throw new Error("Unsupported Windows child environment entry")
        return `[Environment]::SetEnvironmentVariable(${ps(key)},${ps(value)},'Process')`
      }),
    ...windowsPowerShellLocation(input.profile.cwd),
    `& ${windowsWorkloadArgv(input.argv, input.profile.cwd).map(ps).join(" ")}`,
    "if ($null -eq $LASTEXITCODE) { exit 0 }; exit $LASTEXITCODE",
  ]
  await writeFile(path, Buffer.from(`\uFEFF${lines.join("\r\n")}`, "utf16le"), { flag: "wx", mode: 0o600 })
  return {
    command: `& ${ps(path)}`,
    shell: {
      exe: join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"],
    },
  }
}
export function windowsSandboxLease(temp: string) {
  // The upstream account is shared: overlapping profiles must not union their ACL grants.
  return lease(join(dirname(temp), "codesplash-windows-sandbox"), "execution.lease")
}
