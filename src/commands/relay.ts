import { relayUnixSocket } from "../core/services/unix-relay.ts"

export async function runRelayCommand(args: string[]) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    process.stdout.write(
      "codesplash relay --socket PRIVATE_SOCKET [--timeout-ms N] [--max-bytes N]\nRelays stdin/stdout; EOF half-closes the request, then drains the response.\n",
    )
    return 0
  }
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1]
    if (!["--socket", "--timeout-ms", "--max-bytes"].includes(key) || key in flags || !value)
      throw new Error("Use relay --socket PRIVATE_SOCKET [--timeout-ms N] [--max-bytes N]")
    flags[key] = value
  }
  if (!flags["--socket"]) throw new Error("Relay requires --socket")
  const controller = new AbortController(),
    cancel = () => controller.abort()
  process.once("SIGINT", cancel)
  process.once("SIGTERM", cancel)
  try {
    await relayUnixSocket(flags["--socket"], process.stdin, process.stdout, {
      signal: controller.signal,
      ...(flags["--timeout-ms"] ? { timeoutMs: Number(flags["--timeout-ms"]) } : {}),
      ...(flags["--max-bytes"] ? { maxBytes: Number(flags["--max-bytes"]) } : {}),
    })
    return 0
  } finally {
    process.off("SIGINT", cancel)
    process.off("SIGTERM", cancel)
  }
}
