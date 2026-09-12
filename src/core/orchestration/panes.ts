import { lstatSync, unlinkSync } from "node:fs"
import { createConnection } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { runProcess } from "../../engines/codesplash/sandbox/process.ts"
import { PeerEndpoint } from "./peer-socket.ts"
import type { PeerMailbox } from "./peers.ts"

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
export class TeamPanes {
  readonly endpoint: PeerEndpoint
  readonly #windows = new Map<string, string>()
  readonly #viewed = new Set<string>()
  readonly #tmux = Bun.which("tmux")
  #identity?: { ino: number; dev: number }
  #closed = false
  #pending?: Promise<ReturnType<TeamPanes["status"]>>
  constructor(mailbox: PeerMailbox, view: (team: string) => unknown) {
    this.endpoint = new PeerEndpoint(mailbox, (team) => {
      const result = view(team)
      this.#viewed.add(team)
      return result
    })
  }
  get socket() {
    return join(dirname(this.endpoint.path), `${this.endpoint.id}.tmux`)
  }
  status() {
    return {
      available: !!this.#tmux,
      windows: [...this.#windows].map(([team, window]) => ({ team, window })),
      ...(this.#identity ? { socket: this.socket } : {}),
    }
  }
  #owned() {
    const info = lstatSync(this.socket)
    if (
      !info.isSocket() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      (this.#identity && (info.ino !== this.#identity.ino || info.dev !== this.#identity.dev))
    )
      throw new Error("Team pane server ownership changed")
    return info
  }
  async command(args: string[]) {
    if (!this.#tmux) throw new Error("tmux is unavailable; install tmux or use the in-process dashboard")
    if (this.#identity) this.#owned()
    const result = await runProcess([this.#tmux, "-S", this.socket, "-f", "/dev/null", ...args], {
      cwd: dirname(this.endpoint.path),
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin`,
        LANG: "C.UTF-8",
        TERM: "xterm-256color",
      },
      signal: AbortSignal.timeout(5000),
      timeoutMs: 5000,
      maxBytes: 65536,
      structured: true,
    })
    if (result.exitCode !== 0) throw new Error(`Team pane command failed: ${result.stderr.slice(0, 1024)}`)
    return result.stdout.trim()
  }
  async open(team: string): Promise<ReturnType<TeamPanes["status"]>> {
    if (this.#pending) {
      await this.#pending
      return this.open(team)
    }
    const pending = this.#open(team)
    this.#pending = pending
    try {
      return await pending
    } finally {
      if (this.#pending === pending) this.#pending = undefined
    }
  }
  async #open(team: string) {
    if (this.#closed) throw new Error("Pane owner closed")
    if (!/^[a-f0-9-]{36}$/.test(team)) throw new Error("Invalid team pane identity")
    if (this.#windows.has(team)) return this.status()
    if (this.#windows.size >= 8) throw new Error("Team pane limit reached")
    if (!this.#tmux) throw new Error("tmux is unavailable; install tmux or use the in-process dashboard")
    await this.endpoint.open()
    if (this.#closed) throw new Error("Pane owner closed during startup")
    const source = fileURLToPath(new URL("../../cli.js", import.meta.url)),
      development = fileURLToPath(new URL("../../cli.ts", import.meta.url)),
      cli = import.meta.url.endsWith(".ts") ? development : source
    const argv = [
      process.execPath,
      ...(import.meta.url.includes("/$bunfs/") ? [] : [cli]),
      "teams",
      "view",
      this.endpoint.path,
      team,
    ]
    try {
      const window = await this.command(
        this.#identity
          ? [
              "new-window",
              "-d",
              "-P",
              "-F",
              "#{window_id}",
              "-t",
              `cs_${this.endpoint.id}`,
              "-n",
              team,
              argv.map(quote).join(" "),
            ]
          : [
              "new-session",
              "-d",
              "-P",
              "-F",
              "#{window_id}",
              "-s",
              `cs_${this.endpoint.id}`,
              "-x",
              "120",
              "-y",
              "35",
              "-n",
              team,
              argv.map(quote).join(" "),
            ],
      )
      this.#identity = this.#owned()
      if (!/^@[0-9]+$/.test(window)) throw new Error("Invalid owned pane response")
      this.#windows.set(team, window)
      const deadline = Date.now() + 5000
      while (!this.#viewed.has(team)) {
        if (this.#closed || Date.now() >= deadline)
          throw new Error("Team viewer did not authenticate before its startup deadline")
        await Bun.sleep(25)
      }
      return this.status()
    } catch (error) {
      try {
        this.#identity ??= this.#owned()
      } catch {}
      await this.#dispose()
      throw error
    }
  }
  async close() {
    if (this.#closed) return
    this.#closed = true
    await this.#pending?.catch(() => {})
    await this.#dispose()
  }
  async #listening(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socket)
      const timer = setTimeout(() => finish(new Error("Pane listener check timed out")), 1000)
      const finish = (error?: Error, listening = false) => {
        clearTimeout(timer)
        socket.destroy()
        error ? reject(error) : resolve(listening)
      }
      socket.once("connect", () => finish(undefined, true))
      socket.once("error", (error) =>
        ["ECONNREFUSED", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")
          ? finish()
          : finish(error),
      )
    })
  }
  async #dispose() {
    try {
      if (this.#identity) {
        let failure: unknown
        try {
          await this.command(["kill-server"])
        } catch (error) {
          failure = error
        }
        const deadline = Date.now() + 5000
        for (;;) {
          if (!(await this.#listening())) {
            try {
              this.#owned()
              unlinkSync(this.socket)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
            }
            break
          }
          if (failure) throw failure
          if (Date.now() >= deadline) throw new Error("Owned team pane server did not stop")
          await Bun.sleep(25)
        }
      }
    } finally {
      this.#windows.clear()
      this.#viewed.clear()
      this.#identity = undefined
      await this.endpoint.close()
    }
  }
}
