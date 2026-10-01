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
    // Diagnose a failing working-directory transition under the actual child
    // token. Keep the original failure and every ACL; do not launch the workload.
    `try { Set-Location -LiteralPath ${ps(input.profile.cwd)} } catch {`,
    "  $locationError = $_",
    `  $probePath = ${ps(input.profile.cwd)}`,
    "  $probe = @{ path = $probePath; exists = [IO.Directory]::Exists($probePath) }",
    "  try { $probe.itemPath = (Get-Item -LiteralPath $probePath -Force -ErrorAction Stop).FullName } catch { $probe.itemError = $_.Exception.Message }",
    "  try { $probe.acl = (Get-Acl -LiteralPath $probePath -ErrorAction Stop).Sddl } catch { $probe.aclError = $_.Exception.Message }",
    "  try { $probe.entryCount = [IO.Directory]::GetFileSystemEntries($probePath).Length } catch { $probe.enumerateError = $_.Exception.Message }",
    "  try { [IO.Directory]::SetCurrentDirectory($probePath); $probe.nativeCwd = [IO.Directory]::GetCurrentDirectory() } catch { $probe.nativeCwdError = $_.Exception.Message }",
    "  foreach ($key in $probe.Keys) { [Console]::WriteLine('WINDOWS_CWD_PROBE ' + $key + '=' + [string]$probe[$key]) }",
    "  throw $locationError",
    "}",
    `& ${input.argv.map(ps).join(" ")}`,
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
