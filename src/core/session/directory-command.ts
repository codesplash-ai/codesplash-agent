import { parse } from "shell-quote"
import type { DirectoryRequest } from "./working-directory.ts"
export function directoryCommand(text: string): DirectoryRequest {
  const args = parse(text, (key) => `$${key}`)
  if (args.some((value) => typeof value !== "string"))
    throw new Error("cd accepts literal path arguments only")
  const request: DirectoryRequest = { path: "" }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string
    if (arg === "--carry" || arg === "--clear") {
      if (request.context) throw new Error("Choose one of --carry or --clear")
      request.context = arg === "--carry" ? "carry" : "clear"
    } else if (arg === "--apply") request.apply = true
    else if (arg === "--revision") {
      request.revision = args[++index] as string | undefined
      if (!request.revision) throw new Error("--revision requires the reviewed directory revision")
    } else if (arg.startsWith("--") || request.path)
      throw new Error("Use /cd PATH [--carry|--clear --apply --revision REVISION]")
    else request.path = arg
  }
  if (!request.path) throw new Error("Use /cd PATH to preview a working-directory change")
  return request
}
