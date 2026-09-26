import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { vscodePackage } from "../server/vsix.ts"
import { UsageError } from "./usage-error.ts"
export async function runIdeCommand(args: string[]) {
  if (args[0] === "--help") {
    process.stdout.write("codesplash ide package FILE.vsix | install [code|code-insiders|cursor]\n")
    return 0
  }
  if (args[0] === "package" && args.length === 2) {
    await writeFile(resolve(args[1]!), vscodePackage(), { flag: "wx" })
    return 0
  }
  if (
    args[0] !== "install" ||
    args.length > 2 ||
    ![undefined, "code", "code-insiders", "cursor"].includes(args[1])
  )
    throw new UsageError("Use codesplash ide package FILE.vsix or ide install [code|code-insiders|cursor]")
  const binary = Bun.which(args[1] ?? "code")
  if (!binary) throw new Error("Editor CLI unavailable; use ide package and Install from VSIX in the editor")
  const temp = await mkdtemp(join(tmpdir(), "codesplash-vsix-")),
    path = join(temp, "codesplash.vsix")
  try {
    await writeFile(path, vscodePackage())
    return await Bun.spawn([binary, "--install-extension", path], {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    }).exited
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}
