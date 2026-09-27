import { assertManagedPolicy } from "../core/config/policy.ts"
import { loadConfig } from "../core/config.ts"
import { createProfile } from "../engines/codesplash/sandbox/profile.ts"
import { NativeSandbox } from "../engines/codesplash/sandbox/runtime.ts"
import { osc52 } from "../tui/terminal.ts"

/** Only validated clipboard writes may cross the PTY boundary, including fragmented C1 strings. */
export class ClipboardWrap {
  #state: "text" | "escape" | "osc" | "string" = "text"
  #sequence = ""
  #escaped = false
  #discard = false
  #decoder = new TextDecoder()
  constructor(
    readonly enabled: boolean,
    readonly tmux: boolean,
  ) {}
  push(bytes: Uint8Array, final = false): string {
    let output = ""
    for (const char of this.#decoder.decode(bytes, { stream: !final })) {
      if (this.#state === "osc" || this.#state === "string") {
        const end =
          char === "\u009c" || (this.#escaped && char === "\\") || (this.#state === "osc" && char === "\x07")
        if (end) {
          if (this.#state === "osc" && !this.#discard) output += this.#osc()
          this.#state = "text"
          this.#sequence = ""
          this.#escaped = false
          this.#discard = false
        } else {
          // Embedded controls could introduce a nested escape into an otherwise allowed OSC.
          const code = char.charCodeAt(0)
          if (this.#escaped || (char !== "\x1b" && (code < 32 || (code >= 127 && code <= 159))))
            this.#discard = true
          this.#escaped = char === "\x1b"
          if (!this.#escaped && !this.#discard && this.#state === "osc") {
            this.#sequence += char
            if (this.#sequence.length > 128 * 1024) {
              this.#discard = true
              this.#sequence = ""
            }
          }
        }
        continue
      }
      if (this.#state === "escape") {
        this.#state = "text"
        if (char === "]" || char === "\u009d") this.#state = "osc"
        else if (["P", "X", "^", "_", "\u0090", "\u0098", "\u009e", "\u009f"].includes(char))
          this.#state = "string"
        else if (char === "\x1b") this.#state = "escape"
        else output += `\x1b${char}`
        continue
      }
      if (char === "\x1b") this.#state = "escape"
      else if (char === "\u009d") this.#state = "osc"
      else if (["\u0090", "\u0098", "\u009e", "\u009f"].includes(char)) this.#state = "string"
      else output += char
    }
    if (final) {
      this.#state = "text"
      this.#sequence = ""
      this.#escaped = false
      this.#discard = false
    }
    return output
  }
  #osc(): string {
    if (!this.#sequence.startsWith("52;"))
      return /^(?:0|1|2|7|8);/.test(this.#sequence) ? `\x1b]${this.#sequence}\x07` : ""
    const match = /^52;[cps0-7]*;([A-Za-z0-9+/]*={0,2})$/.exec(this.#sequence)
    if (!this.enabled || !match || match[1]!.length > 87384) return ""
    const decoded = Buffer.from(match[1]!, "base64")
    return decoded.toString("base64") === match[1] && decoded.length <= 65536
      ? osc52(decoded.toString(), this.tmux)
      : ""
  }
}
export async function runWrapCommand(args: string[]): Promise<number> {
  const boundary = args.indexOf("--")
  if (
    boundary < 0 ||
    boundary === args.length - 1 ||
    args.slice(0, boundary).some((a) => a !== "--clipboard") ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY
  )
    throw new Error("Use wrap [--clipboard] -- COMMAND [ARGS...] in a terminal")
  const config = await loadConfig(undefined, [], { cwd: process.cwd() })
  const policy = {
    sandbox: config.codex.sandbox,
    permissionMode: config.permissions.mode,
    approvalPolicy: config.codex.approvalPolicy,
  }
  assertManagedPolicy(config, policy)
  const runtime = new NativeSandbox(
    createProfile(process.cwd(), policy.sandbox, config.sandbox),
    undefined,
    undefined,
    config.resolution?.constraints,
  )
  const abort = new AbortController(),
    filter = new ClipboardWrap(args.includes("--clipboard"), Boolean(process.env.TMUX))
  try {
    const terminal = await runtime.openTerminal(
      args.slice(boundary + 1),
      { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24, timeoutMs: 3600000 },
      abort.signal,
      (chunk) => {
        process.stdout.write(filter.push(chunk))
      },
      policy.permissionMode,
    )
    const raw = process.stdin.isRaw,
      stop = () => abort.abort(),
      data = (chunk: Buffer) => {
        void terminal.write(chunk).catch(stop)
      },
      resize = () => {
        void terminal.resize(process.stdout.columns || 80, process.stdout.rows || 24).catch(stop)
      }
    process.stdin.setRawMode(true)
    process.stdin.on("data", data)
    process.stdout.on("resize", resize)
    process.once("SIGTERM", stop)
    try {
      return (await terminal.finished).exitCode
    } finally {
      process.stdin.removeListener("data", data)
      process.stdin.setRawMode(raw)
      process.stdin.pause()
      process.stdout.removeListener("resize", resize)
      process.removeListener("SIGTERM", stop)
      await terminal.close()
      process.stdout.write(filter.push(new Uint8Array(), true))
    }
  } finally {
    await runtime.close()
  }
}
