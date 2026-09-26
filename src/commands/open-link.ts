import { parseDeepLink } from "../server/deep-link.ts"
import { runServerCommand } from "./server.ts"
import { UsageError } from "./usage-error.ts"
export async function runOpenLink(args: string[]) {
  const [source, ...rest] = args
  if (!source || rest.some((v, i) => v !== "--attach" && v !== "--root" && rest[i - 1] !== "--root"))
    throw new UsageError("codesplash open codesplash://session/UUID [--attach] [--root DIR]")
  const link = parseDeepLink(source)
  process.stderr.write(`${link.provenance}\nSession: ${link.threadId}\n`)
  if (!rest.includes("--attach")) {
    process.stderr.write("Add --attach to open this session as a reader.\n")
    return 0
  }
  return runServerCommand("attach", [link.threadId, "--reader", ...rest.filter((v) => v !== "--attach")])
}
