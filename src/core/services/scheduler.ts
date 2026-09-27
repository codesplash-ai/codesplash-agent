import { existsSync, unlinkSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { writeResources } from "../../engines/codesplash/inputs/authoring.ts"
import { atomic, bytes, canonicalRoot, digest, directory, json, lease } from "../session/files.ts"

type Platform = "darwin" | "linux"
export type SchedulerServiceOptions = {
  platform: Platform
  cwd: string
  home: string
  executable: string
  configRoot: string
  dataRoot: string
  model: string
  approve?: boolean
}
type Receipt = { version: 1; platform: Platform; cwd: string; file: string; hash: string; label: string }
const clean = (text: string) => {
  if (!text || text.length > 4096 || [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
    throw new Error("Invalid service argument")
  return text
}
const xml = (text: string) =>
  clean(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
const unit = (text: string, command = false) =>
  JSON.stringify(
    clean(text)
      .replaceAll("%", "%%")
      .replaceAll("$", () => (command ? "$$" : "$")),
  )
export function schedulerServicePlan(options: SchedulerServiceOptions) {
  if (!["darwin", "linux"].includes(options.platform))
    throw new Error("Scheduler services support macOS launchd and Linux systemd user services")
  for (const path of [options.cwd, options.home, options.executable, options.configRoot, options.dataRoot])
    if (!isAbsolute(clean(path))) throw new Error("Service paths must be absolute")
  if (/[\s\\]$/.test(options.cwd))
    throw new Error("Service workspace cannot end with whitespace or a backslash")
  if (!options.model || options.model.length > 256 || options.model.startsWith("-"))
    throw new Error("Service requires an explicit model")
  const label = `ai.codesplash.scheduler.${digest(options.cwd).slice(0, 20)}`
  const args = [
    options.executable,
    "scheduler",
    "worker",
    "--duration-ms",
    "3600000",
    "--apply",
    "--trust",
    "--model",
    options.model,
    ...(options.approve ? ["--approve"] : []),
  ]
  const env = {
    CODESPLASH_AGENT_CONFIG_DIR: options.configRoot,
    CODESPLASH_AGENT_DATA_DIR: options.dataRoot,
    PATH: `${dirname(options.executable)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
  }
  const file =
    options.platform === "darwin"
      ? join(options.home, "Library", "LaunchAgents", `${label}.plist`)
      : join(options.home, ".config", "systemd", "user", `${label}.service`)
  const content =
    options.platform === "darwin"
      ? `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${args.map((s) => `<string>${xml(s)}</string>`).join("")}</array><key>WorkingDirectory</key><string>${xml(options.cwd)}</string><key>EnvironmentVariables</key><dict>${Object.entries(
          env,
        )
          .map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`)
          .join(
            "",
          )}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>60</integer><key>ExitTimeOut</key><integer>30</integer><key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>\n`
      : `[Unit]\nDescription=CodeSplash bounded scheduler owner\nStartLimitIntervalSec=300\nStartLimitBurst=5\n[Service]\nType=exec\nWorkingDirectory=${options.cwd.replaceAll("%", "%%")}\nExecStart=${args.map((a) => unit(a, true)).join(" ")}\n${Object.entries(
          env,
        )
          .map(([k, v]) => `Environment=${unit(`${k}=${v}`)}`)
          .join(
            "\n",
          )}\nRestart=always\nRestartSec=60\nTimeoutStopSec=30\nKillMode=control-group\nUMask=0077\nStandardOutput=null\nStandardError=null\n[Install]\nWantedBy=default.target\n`
  return { label, file, content, args }
}
export async function serviceCommand(argv: string[]) {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const timer = setTimeout(() => child.kill(), 15000)
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (status !== 0)
      throw new Error(`Service manager exited ${status}: ${(stderr || stdout).slice(0, 4096)}`)
    return stdout.slice(0, 16384)
  } finally {
    clearTimeout(timer)
  }
}
export class SchedulerService {
  readonly cwd: string
  readonly label: string
  readonly root: string
  constructor(
    readonly options: {
      cwd: string
      home: string
      dataRoot: string
      platform: Platform
      uid?: number
      run?: (argv: string[]) => Promise<string>
    },
  ) {
    this.cwd = canonicalRoot(options.cwd)
    this.label = `ai.codesplash.scheduler.${digest(this.cwd).slice(0, 20)}`
    this.root = join(canonicalRoot(options.dataRoot), "scheduler-services", this.label)
  }
  #read() {
    const receipt = json<Receipt>(join(this.root, "receipt.json"), 8192)
    const file =
      this.options.platform === "darwin"
        ? join(this.options.home, "Library", "LaunchAgents", `${this.label}.plist`)
        : join(this.options.home, ".config", "systemd", "user", `${this.label}.service`)
    if (
      receipt.version !== 1 ||
      receipt.cwd !== this.cwd ||
      receipt.platform !== this.options.platform ||
      receipt.label !== this.label ||
      receipt.file !== file ||
      !/^[a-f0-9]{64}$/.test(receipt.hash)
    )
      throw new Error("Invalid service ownership receipt")
    if (digest(bytes(file, 32768)) !== receipt.hash)
      throw new Error("Service file changed; preserve it and inspect the receipt before manual recovery")
    return receipt
  }
  async install(executable: string, configRoot: string, model: string, approve = false) {
    directory(this.root, true)
    const release = lease(this.root)
    try {
      if (existsSync(join(this.root, "receipt.json")))
        throw new Error("Service already installed; uninstall before replacing")
      const plan = schedulerServicePlan({
        ...this.options,
        cwd: this.cwd,
        executable,
        configRoot,
        model,
        approve,
      })
      // Publication never overwrites an existing LaunchAgent/unit file.
      await writeResources(this.options.home, [
        { path: relative(this.options.home, plan.file), text: plan.content },
      ])
      atomic(
        join(this.root, "receipt.json"),
        JSON.stringify({
          version: 1,
          platform: this.options.platform,
          cwd: this.cwd,
          label: this.label,
          file: plan.file,
          hash: digest(plan.content),
        } satisfies Receipt),
      )
      return { file: plan.file, installed: true, started: false }
    } finally {
      release()
    }
  }
  async control(action: "start" | "stop" | "status" | "uninstall") {
    directory(this.root, true)
    const release = lease(this.root)
    try {
      const receipt = this.#read(),
        run = this.options.run ?? serviceCommand
      const domain = `gui/${this.options.uid ?? process.getuid?.()}`
      const target = this.options.platform === "darwin" ? `${domain}/${this.label}` : `${this.label}.service`
      if (action === "status")
        return {
          file: receipt.file,
          status: await run(
            this.options.platform === "darwin"
              ? ["/bin/launchctl", "print", target]
              : ["systemctl", "--user", "status", "--no-pager", target],
          ),
        }
      if (action === "start") {
        if (this.options.platform === "darwin") {
          await run(["/bin/launchctl", "enable", target])
          await run(["/bin/launchctl", "bootstrap", domain, receipt.file])
        } else {
          await run(["systemctl", "--user", "daemon-reload"])
          await run(["systemctl", "--user", "enable", "--now", target])
        }
        return { started: true, file: receipt.file }
      }
      if (this.options.platform === "darwin") {
        await run(["/bin/launchctl", "disable", target])
        // A missing job is already stopped; only that specific absence is accepted.
        try {
          await run(["/bin/launchctl", "bootout", target])
        } catch (error) {
          if (!/could not find service|no such process/i.test(String(error))) throw error
        }
      } else await run(["systemctl", "--user", "disable", "--now", target])
      if (action === "uninstall") {
        this.#read() // Never unlink a changed file after the manager call.
        unlinkSync(receipt.file)
        unlinkSync(join(this.root, "receipt.json"))
        if (this.options.platform === "linux") await run(["systemctl", "--user", "daemon-reload"])
      }
      return { stopped: true, uninstalled: action === "uninstall" }
    } finally {
      release()
    }
  }
}
