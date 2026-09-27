import { win32 } from "node:path"
import { validateWindowsPath } from "../platform.ts"

/** Inspect numeric SIDs/rights, never localized account names or formatted icacls text. */
export function assertWindowsPolicyACL(path: string): void {
  validateWindowsPath(path)
  const script = String.raw`
$ErrorActionPreference='Stop'
$location = [Console]::In.ReadToEnd() | ConvertFrom-Json
$trusted = @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$leaf = $true
while ($location) {
  $item = Get-Item -LiteralPath $location -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse policy path' }
  $acl = Get-Acl -LiteralPath $location
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($trusted -notcontains $owner) { throw 'Policy path owner is not an administrator' }
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
  if ($null -eq $raw.DiscretionaryAcl) { throw 'Null policy DACL' }
  $mask = if ($leaf) { 0xD0116 } else { 0xD0040 }
  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $trusted -notcontains $rule.IdentityReference.Value -and
        ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
        ([int]$rule.FileSystemRights -band $mask) -ne 0) { throw 'Policy path is writable by a non-administrator' }
  }
  $parent = [IO.Path]::GetDirectoryName($location.TrimEnd('\'))
  if (-not $parent -or $parent -eq $location) { break }
  if ($parent -match '^[A-Za-z]:$') { $parent += '\' }
  $location = $parent; $leaf = $false
}
[Console]::Out.Write('ACL_VERIFIED')
`
  const result = Bun.spawnSync(
    [
      win32.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      stdin: Buffer.from(JSON.stringify(path)),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
      maxBuffer: 65536,
    },
  )
  if (result.exitCode !== 0 || result.stdout.toString() !== "ACL_VERIFIED")
    throw Error("System fleet policy failed administrator ownership/ACL validation")
}
