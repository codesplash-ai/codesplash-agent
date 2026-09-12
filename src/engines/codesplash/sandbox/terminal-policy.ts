/** Resolve the inherited slave in trusted startup code, before any workload enters Seatbelt. */
const MAC_TERMINAL_LAUNCH = String.raw`
cs_terminal_device=$(/usr/bin/tty) || exit 126
[[ "$cs_terminal_device" =~ ^/dev/ttys[0-9]+$ ]] || exit 126
cs_terminal_policy="$1
(allow file-read* file-write* file-ioctl (literal \"$cs_terminal_device\") (literal \"/dev/tty\"))
(deny file-read* file-write* file-ioctl
  (require-all (regex #\"^/dev/(tty|pty)\")
    (require-not (literal \"$cs_terminal_device\"))
    (require-not (literal \"/dev/tty\"))))
(deny file-read* file-write* file-ioctl (literal \"/dev/ptmx\"))"
shift
exec /usr/bin/sandbox-exec -p "$cs_terminal_policy" "$@"
`
/** The pinned runtime's broad allowPty grants all user terminals; M7 grants only this owned slave. */
export function terminalSandboxArgv(argv: string[]): string[] {
  if (process.platform !== "darwin") return argv
  const at = argv.indexOf("/usr/bin/sandbox-exec")
  if (
    argv[0] !== "/usr/bin/env" ||
    at < 1 ||
    argv[at + 1] !== "-p" ||
    !argv[at + 2]?.startsWith("(version 1)")
  )
    throw new Error("Unexpected terminal sandbox wrapper")
  return [
    ...argv.slice(0, at),
    "/bin/bash",
    "--noprofile",
    "--norc",
    "-c",
    MAC_TERMINAL_LAUNCH,
    "codesplash-terminal",
    ...argv.slice(at + 2),
  ]
}
