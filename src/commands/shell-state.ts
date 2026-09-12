import { resolve } from "node:path"
import { dataDirectory } from "../core/config.ts"
import {
  captureShellSnapshot,
  reviewShellSnapshot,
  trustShellSnapshot,
} from "../engines/codesplash/orchestration/shell-state.ts"
import { UsageError } from "./usage-error.ts"

const usage =
  "codesplash shell-state capture PATH [--shell bash|zsh] [--env NAME] [--definitions FILE] | review PATH | trust PATH --fingerprint HASH\nCapture imports explicitly selected definitions and filtered environment; it never executes startup files. Review the full snapshot before trusting its fingerprint.\n"
export async function runShellStateCommand(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; dataDir?: string; output?: (text: string) => void } = {},
): Promise<number> {
  const output = options.output ?? ((text) => process.stdout.write(text)),
    env = options.env ?? process.env,
    cwd = options.cwd ?? process.cwd()
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    output(usage)
    return 0
  }
  const [action, path, ...flags] = args
  if (!path || !["capture", "review", "trust"].includes(action ?? "")) throw new UsageError(usage)
  let shell: "bash" | "zsh" = "bash",
    definitions: string | undefined,
    fingerprint: string | undefined
  const names: string[] = [],
    seen = new Set<string>()
  for (let i = 0; i < flags.length; i++) {
    const key = flags[i]!,
      value = flags[++i]
    if (!value || (key !== "--env" && seen.has(key)))
      throw new UsageError("Missing or duplicate shell-state option")
    seen.add(key)
    if (key === "--env" && action === "capture") names.push(value)
    else if (key === "--definitions" && action === "capture") definitions = resolve(cwd, value)
    else if (key === "--shell" && action === "capture" && ["bash", "zsh"].includes(value))
      shell = value as typeof shell
    else if (key === "--fingerprint" && action === "trust") fingerprint = value
    else throw new UsageError(usage)
  }
  const target = resolve(cwd, path)
  const result =
    action === "capture"
      ? captureShellSnapshot(target, shell, names, definitions, env)
      : action === "review"
        ? reviewShellSnapshot(target, env)
        : fingerprint
          ? trustShellSnapshot(options.dataDir ?? dataDirectory(env), { path: target, fingerprint })
          : undefined
  if (!result) throw new UsageError("Trust requires the reviewed --fingerprint HASH")
  output(`${JSON.stringify(result, null, 2)}\n`)
  return 0
}
