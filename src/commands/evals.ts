import { writeFile } from "node:fs/promises"
import { compareEvals, fixtureEvalSuite, runEvals } from "../core/evals.ts"
import { bytes } from "../core/session/files.ts"
import { UsageError } from "./usage-error.ts"
export async function runEvalCommand(args: string[]): Promise<number> {
  if (args[0] === "--help") {
    process.stdout.write(
      "codesplash eval --fixture [--output FILE]\ncodesplash eval SUITE.json --model ID --budget-usd N [--judge ID] [--config FILE] [--output FILE]\ncodesplash eval compare BEFORE.json AFTER.json\n",
    )
    return 0
  }
  const read = (path: string) => JSON.parse(bytes(path, 2 * 1024 * 1024).toString())
  if (args[0] === "compare" && args.length === 3) {
    process.stdout.write(`${JSON.stringify(compareEvals(read(args[1]!), read(args[2]!)), null, 2)}\n`)
    return 0
  }
  const fixture = args[0] === "--fixture",
    source = args[0]
  if (!source) throw new UsageError("Use eval --help")
  const flags: Record<string, string> = {}
  for (let i = 1; i < args.length; i += 2) {
    if (
      !["--model", "--budget-usd", "--judge", "--config", "--output"].includes(args[i]!) ||
      !args[i + 1] ||
      flags[args[i]!]
    )
      throw new UsageError("Invalid eval option")
    flags[args[i]!] = args[i + 1]!
  }
  const report = await runEvals(fixture ? fixtureEvalSuite : read(source), {
    fixture,
    model: flags["--model"],
    judge: flags["--judge"],
    config: flags["--config"],
    budgetUsd: flags["--budget-usd"] ? Number(flags["--budget-usd"]) : undefined,
  })
  const output = JSON.stringify(report, null, 2) + "\n"
  if (flags["--output"]) await writeFile(flags["--output"]!, output, { flag: "wx", mode: 0o600 })
  else process.stdout.write(output)
  return report.accepted ? 0 : 1
}
