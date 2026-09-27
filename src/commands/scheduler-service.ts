import { accessSync, constants, statSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { configDirectory, dataDirectory, loadConfig } from "../core/config.ts"
import { SchedulerService, schedulerServicePlan } from "../core/services/scheduler.ts"
import { canonicalRoot } from "../core/session/files.ts"
import { createPermissionRuntime } from "../engines/codesplash/permissions.ts"

export async function runSchedulerService(
  args: string[],
  options: { cwd?: string; dataRoot?: string; configPath?: string; output?: (text: string) => void } = {},
) {
  const [action, ...rest] = args
  if (!["install", "start", "stop", "status", "uninstall"].includes(action ?? ""))
    throw new Error(
      "Use scheduler service install --executable ABSOLUTE_BINARY --model ID [--approve] [--apply --trust] | start --apply --trust | stop --apply | status | uninstall --apply",
    )
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Scheduler user services require macOS or Linux")
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!
    if (flag in flags) throw new Error("Duplicate service option")
    if (["--apply", "--trust", "--approve"].includes(flag)) flags[flag] = true
    else if (["--executable", "--model"].includes(flag) && rest[i + 1]) flags[flag] = rest[++i]!
    else throw new Error("Unknown service option")
  }
  const allowed =
    action === "install"
      ? ["--apply", "--trust", "--approve", "--executable", "--model"]
      : action === "start"
        ? ["--apply", "--trust"]
        : action === "status"
          ? []
          : ["--apply"]
  if (Object.keys(flags).some((k) => !allowed.includes(k)))
    throw new Error("Option is not valid for this service action")
  const cwd = canonicalRoot(options.cwd ?? process.cwd()),
    dataRoot = options.dataRoot ?? dataDirectory()
  const output = options.output ?? ((text: string) => process.stdout.write(text))
  const service = new SchedulerService({ cwd, dataRoot, home: homedir(), platform: process.platform })
  let plan: ReturnType<typeof schedulerServicePlan> | undefined
  if (action === "install") {
    if (typeof flags["--executable"] !== "string" || typeof flags["--model"] !== "string")
      throw new Error("Installation requires --executable and --model")
    plan = schedulerServicePlan({
      cwd,
      dataRoot,
      configRoot: configDirectory(),
      home: homedir(),
      platform: process.platform,
      executable: String(flags["--executable"]),
      model: String(flags["--model"]),
      approve: flags["--approve"] === true,
    })
  }
  if (action !== "status" && !flags["--apply"]) {
    output(
      `${JSON.stringify({ action, preview: plan ?? service.label, instruction: "Add --apply to perform this service operation; install/start also require --trust." }, null, 2)}\n`,
    )
    return 0
  }
  if (["install", "start"].includes(action!)) {
    if (!flags["--trust"]) throw new Error("Service activation requires explicit workspace trust")
    const config = await loadConfig(options.configPath, [], {
      cwd,
      workspaceTrusted: true,
      dataDir: dataRoot,
    })
    if (!config.history.enabled || config.permissions.mode === "plan" || config.codex.sandbox === "read-only")
      throw new Error("Persistent scheduling denied by configuration")
    const permissions = await createPermissionRuntime({
      cwd,
      workspaceTrusted: true,
      mode: config.permissions.mode,
      configRules: config.permissions,
      constraints: config.resolution?.constraints,
    })
    if (
      ["scheduler", "scheduler_start"].some(
        (name) => permissions.decide(name, undefined, false).kind === "deny",
      )
    )
      throw new Error("Scheduling denied by policy")
  }
  if (action === "install") {
    const executable = resolve(String(flags["--executable"]))
    if (!statSync(executable).isFile()) throw new Error("Service executable must be a regular file")
    accessSync(executable, constants.X_OK)
    output(
      `${JSON.stringify(await service.install(executable, configDirectory(), String(flags["--model"]), flags["--approve"] === true))}\nUse scheduler service start --apply --trust to start now. The installed service runs at future user logins.\n`,
    )
  } else
    output(
      `${JSON.stringify(await service.control(action as "start" | "stop" | "status" | "uninstall"), null, 2)}\n`,
    )
  return 0
}
