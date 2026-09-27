import { posix, win32 } from "node:path"

export type ShellDialect = "posix" | "powershell" | "cmd"
export function shellDialect(platform = process.platform, env = process.env): ShellDialect {
  if (platform !== "win32") return "posix"
  const value = env.CODESPLASH_WINDOWS_SHELL ?? "powershell"
  if (value !== "powershell" && value !== "cmd") throw new Error("Windows shell must be powershell or cmd")
  return value
}
export function shellCommand(command: string, platform = process.platform, env = process.env): string[] {
  if (command.includes("\0")) throw new Error("Invalid shell command")
  const dialect = shellDialect(platform, env)
  if (dialect === "posix") return ["bash", "-c", command]
  const system = env.SystemRoot ?? "C:\\Windows"
  if (dialect === "cmd") return [win32.join(system, "System32", "cmd.exe"), "/d", "/s", "/c", command]
  // EncodedCommand avoids the two independent cmd/PowerShell quoting grammars. Profiles never run.
  return [
    win32.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(command, "utf16le").toString("base64"),
  ]
}
export function pathContains(root: string, path: string, platform = process.platform): boolean {
  const api = platform === "win32" ? win32 : posix
  let a = api.resolve(root),
    b = api.resolve(path)
  if (platform === "win32") {
    a = a.toLowerCase()
    b = b.toLowerCase()
  }
  const relative = api.relative(a, b)
  return (
    relative === "" ||
    (!api.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${api.sep}`))
  )
}
export function validateWindowsPath(path: string): void {
  if (
    !win32.isAbsolute(path) ||
    /[\p{Cc}\p{Cf}]/u.test(path) ||
    path.startsWith("\\\\") ||
    !/^[A-Za-z]:\\/.test(path) ||
    path
      .slice(3)
      .split(/[\\/]/)
      .some(
        (part) =>
          part === ".." ||
          /[:*?"<>|]/.test(part) ||
          /[ .]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error(
      "Windows sandbox paths must be local absolute paths without device names, streams or aliases",
    )
}
export function isTermux(env = process.env): boolean {
  return Boolean(env.TERMUX_VERSION || env.PREFIX?.startsWith("/data/data/com.termux/"))
}
export function platformCapabilities() {
  return {
    version: 1,
    target: `${process.platform}-${process.arch}`,
    termux: isTermux(),
    shell: shellDialect(),
    nativeSandbox:
      process.platform === "darwin"
        ? "seatbelt"
        : process.platform === "linux" && !isTermux()
          ? "bwrap-seccomp"
          : "requires-host-validation",
    advertised: ["darwin", "linux"].includes(process.platform) && !isTermux(),
  }
}
