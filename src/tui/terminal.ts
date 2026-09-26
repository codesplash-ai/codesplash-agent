import { spawn } from "node:child_process"
import type { TranscriptItem } from "../core/index.ts"
import { registerChildProcess } from "../core/lifecycle.ts"

export function terminalProfile(env: NodeJS.ProcessEnv = process.env) {
  const brand =
    env.TERM_PROGRAM ||
    (env.KITTY_WINDOW_ID ? "kitty" : env.WT_SESSION ? "windows-terminal" : env.TERM || "unknown")
  return {
    brand,
    tmux: !!env.TMUX,
    remote: !!(env.SSH_CONNECTION || env.SSH_TTY),
    dumb: env.TERM === "dumb",
    colors: env.NO_COLOR ? "basic" : /truecolor|24bit/.test(env.COLORTERM ?? "") ? "truecolor" : "auto",
  }
}
export function clipboardText(transcript: readonly TranscriptItem[], count = 1): string {
  if (!Number.isInteger(count) || count < 1 || count > 100)
    throw new Error("/copy expects 1–100 assistant messages")
  const text = transcript
    .filter((item) => item.kind === "message" && item.status === "completed")
    .slice(-count)
    .map((item) => item.text)
    .join("\n\n")
  if (!text) throw new Error("No completed assistant message to copy")
  if (Buffer.byteLength(text) > 1024 * 1024)
    throw new Error("Clipboard content exceeds 1 MiB; export the session instead")
  return text
}
export function osc52(text: string, tmux: boolean): string {
  const sequence = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`
  return tmux ? `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\` : sequence
}
export async function copyText(
  text: string,
  options: {
    mode: "auto" | "native" | "osc52"
    env?: NodeJS.ProcessEnv
    write?: (value: string) => void
  },
): Promise<string> {
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("Clipboard content exceeds 1 MiB")
  const env = options.env ?? process.env,
    profile = terminalProfile(env)
  if (options.mode !== "osc52" && !profile.remote) {
    const candidates =
      process.platform === "darwin"
        ? [["pbcopy"]]
        : process.platform === "win32"
          ? [["clip.exe"]]
          : [
              ...(env.WAYLAND_DISPLAY ? [["wl-copy"]] : []),
              ...(env.DISPLAY
                ? [
                    ["xclip", "-selection", "clipboard"],
                    ["xsel", "--clipboard", "--input"],
                  ]
                : []),
            ]
    for (const argv of candidates) {
      if (!Bun.which(argv[0]!, { PATH: env.PATH })) continue
      const success = await new Promise<boolean>((resolve) => {
        const child = spawn(argv[0]!, argv.slice(1), { env, stdio: ["pipe", "ignore", "ignore"] })
        const untrack = registerChildProcess(child)
        const timeout = setTimeout(() => child.kill("SIGKILL"), 2000)
        const done = (ok: boolean) => {
          clearTimeout(timeout)
          untrack()
          resolve(ok)
        }
        child.once("error", () => done(false))
        child.once("close", (code) => done(code === 0))
        child.stdin.on("error", () => {})
        child.stdin.end(text)
      })
      if (success) return "Copied to the local clipboard"
    }
    if (options.mode === "native") throw new Error("No working native clipboard backend")
  } else if (options.mode === "native")
    throw new Error("Native clipboard is disabled in remote sessions; select osc52")
  if (profile.dumb) throw new Error("This terminal cannot receive OSC 52 clipboard requests")
  if (!options.write && !process.stdout.isTTY) throw new Error("Clipboard requires a terminal")
  ;(options.write ?? ((value) => process.stdout.write(value)))(osc52(text, profile.tmux))
  return "Clipboard request sent to terminal (OSC 52; terminal permission may be required)"
}
