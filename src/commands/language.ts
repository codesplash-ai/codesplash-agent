import { join } from "node:path"
import { dataDirectory } from "../core/config.ts"
import {
  installDescriptor,
  reviewDescriptor,
  reviewedDescriptors,
} from "../engines/codesplash/language/managed.ts"
import { UsageError } from "./usage-error.ts"
export async function runLanguageCommand(args: string[]) {
  const root = join(dataDirectory(), "language-services")
  const usage =
    "codesplash lsp list | review DESCRIPTOR.json | install DESCRIPTOR.json --sha256 REVIEW_FINGERPRINT"
  if (args[0] === "--help") {
    process.stdout.write(`${usage}\n`)
    return 0
  }
  const result =
    args[0] === "list" && args.length === 1
      ? await reviewedDescriptors(root)
      : args[0] === "review" && args.length === 2
        ? await reviewDescriptor(args[1]!)
        : args[0] === "install" && args.length === 4 && args[2] === "--sha256"
          ? await installDescriptor(root, args[1]!, args[3]!)
          : undefined
  if (!result) throw new UsageError(usage)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return 0
}
