import {
  checkWindowsSandboxStatusAsync,
  installWindowsSandboxAsync,
  resolveSrtWin,
  uninstallWindowsSandbox,
  verifyWindowsWfpEgress,
} from "@anthropic-ai/sandbox-runtime"
import { verifiedWindowsHelper } from "../engines/codesplash/sandbox/windows.ts"
import { UsageError } from "./usage-error.ts"
export async function runWindowsSandboxCommand(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(
      "windows-sandbox status | verify | install --apply | uninstall --apply\nInstall provisions a dedicated account and WFP filters through Windows UAC.\n",
    )
    return 0
  }
  if (process.platform !== "win32") throw new Error("Windows sandbox management requires Windows")
  const srtWin = resolveSrtWin({ path: verifiedWindowsHelper() })
  let result: unknown
  if (args.length === 1 && args[0] === "status") result = await checkWindowsSandboxStatusAsync({ srtWin })
  else if (args.length === 1 && args[0] === "verify") result = await verifyWindowsWfpEgress({ srtWin })
  else if (args.length === 2 && args[1] === "--apply" && args[0] === "install")
    result = await installWindowsSandboxAsync({ srtWin })
  else if (args.length === 2 && args[1] === "--apply" && args[0] === "uninstall")
    result = uninstallWindowsSandbox({ srtWin })
  else throw new UsageError("Use windows-sandbox --help; system changes require --apply")
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return 0
}
