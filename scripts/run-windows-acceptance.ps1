param([ValidateSet('Verify', 'Cleanup')][string]$Mode = 'Verify')
$ErrorActionPreference = 'Stop'
# The CI broker must stamp read-only ACLs on TrustedInstaller-owned Windows
# directories. Administrators possess SeRestorePrivilege, but it is disabled
# by default. Enable it only in this broker process; the sandbox workload runs
# as a separate restricted user and the smoke test checks non-inheritance.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class CodeSplashRestorePrivilege {
  [StructLayout(LayoutKind.Sequential)] public struct Luid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] public struct Privileges { public uint Count; public Luid Luid; public uint Attributes; }
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool LookupPrivilegeValue(string system, string name, out Luid luid);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref Privileges value, uint length, out Privileges previous, out uint returned);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static IntPtr Token;
  public static Privileges Previous;
  public static void Enable() {
    if (!OpenProcessToken(GetCurrentProcess(), 0x20 | 0x8, out Token)) throw new Win32Exception();
    try {
      Luid luid;
      if (!LookupPrivilegeValue(null, "SeRestorePrivilege", out luid)) throw new Win32Exception();
      var value = new Privileges { Count = 1, Luid = luid, Attributes = 2 };
      uint returned;
      if (!AdjustTokenPrivileges(Token, false, ref value, (uint)Marshal.SizeOf(typeof(Privileges)), out Previous, out returned)) throw new Win32Exception();
      int error = Marshal.GetLastWin32Error();
      if (error != 0) throw new Win32Exception(error);
    } catch { CloseHandle(Token); Token = IntPtr.Zero; throw; }
  }
  public static void Restore() {
    if (Token == IntPtr.Zero) return;
    try {
      Privileges ignored; uint returned;
      if (!AdjustTokenPrivileges(Token, false, ref Previous, (uint)Marshal.SizeOf(typeof(Privileges)), out ignored, out returned)) throw new Win32Exception();
    } finally { CloseHandle(Token); Token = IntPtr.Zero; }
  }
}
'@
[CodeSplashRestorePrivilege]::Enable()
try {
  if ($Mode -eq 'Cleanup') {
    & bun src/cli.ts windows-sandbox uninstall --apply
    if ($LASTEXITCODE -ne 0) { throw 'Sandbox cleanup failed' }
  } else {
    & bun src/cli.ts windows-sandbox verify
    if ($LASTEXITCODE -ne 0) { throw 'WFP verification failed' }
    & bun scripts/m11-windows-smoke.ts
    if ($LASTEXITCODE -ne 0) { throw 'Native sandbox acceptance failed' }
  }
} finally {
  [CodeSplashRestorePrivilege]::Restore()
}
